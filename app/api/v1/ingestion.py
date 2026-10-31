import json
import logging
from decimal import Decimal
from typing import Any, Dict, List, Optional
from uuid import UUID

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field
from supabase import Client

from app.ingestion.resolver import (
    ResolverDatabaseUnavailable,
    STATUS_PENDING_CONFIRMATION,
    resolve_branch_id,
)
from schemas.models import DailyReportUpsert, PlatformEnum

logger = logging.getLogger("ingestion_audit")

# NOTE: This module now holds ONLY the shared ingestion core used by the native
# Gmail pipeline (app/api/v1/gmail_ingestion.py): _process_and_upsert_records and
# _verify_branch_exists. The legacy Make.com-era HTTP endpoints (/ingest/settlement,
# /ingest/mailhook, /ingest/records) were removed in Phase 0 of per-tenant auth —
# they had no callers (the Next.js sync worker forwards to /ingestion/grab and
# /ingestion/lineman). The router is kept empty so app/main.py can still include it.
router = APIRouter(prefix="/ingest", tags=["Settlement Ingestion"])


class IngestionItemResponse(BaseModel):
    branch_id: UUID
    platform: PlatformEnum
    report_date: str
    shop_name_raw: str
    order_count: int
    gross_sales: Decimal
    deductions: Decimal
    net_sale: Decimal
    upsert_status: str


class IngestionResponse(BaseModel):
    success: bool
    total_processed: int
    total_upserted: int
    records: List[IngestionItemResponse]
    details: Dict[str, Any] = Field(default_factory=dict)


def _verify_branch_exists(db: Optional[Client], branch_id: str) -> bool:
    """Return True if the branch_id exists in public.branches.

    Returns False (never raises) when the DB is unavailable or a look-up error
    occurs — the caller treats a False as an abort/500 so a write can't silently
    reference a missing branch (FK violation root cause for 0-row commits).
    """
    if db is None:
        return False
    try:
        res = (
            db.table("branches")
            .select("id")
            .eq("id", branch_id)
            .limit(1)
            .execute()
        )
        return bool(res.data)
    except Exception:
        return False


def _process_and_upsert_records(
    raw_records: List[Dict[str, Any]],
    db: Optional[Client],
    brand_id: Optional[str] = None,
    platform: Optional[str] = None,
    source_label: str = "records",
    tenant_brand_ids: Optional[List[str]] = None,
    user_id: Optional[str] = None,
) -> IngestionResponse:
    """Validate, resolve branch_id, check financial math, and perform idempotent upsert.

    ``brand_id`` is the explicit tenant scope (forwarded from the Gmail ingestion
    layer). When absent it falls back to the per-record hint, then to the caller's
    ``tenant_brand_ids`` set. When no scope resolves, ingestion fails CLOSED
    (NO_BRAND_SCOPE) — never to an arbitrary/global brand.

    ``tenant_brand_ids`` (the user's brand set from getTenantUserContext) and
    ``user_id`` are OPTIONAL tenant context forwarded to the resolver so the Phase
    A store/branch split can find-or-create STORE brands scoped to the tenant and
    link new stores via brand_users. When they are None (the current API-key
    ingestion path, which has no authenticated user), the resolver stays scoped to
    the single passed brand and skips creating NEW store brands (documented
    isolation limitation — it never creates a cross-tenant / orphan brand).
    """
    validated_upserts: List[DailyReportUpsert] = []
    response_items: List[IngestionItemResponse] = []

    # Deep audit: parsing overview.
    logger.info(f"[INGEST DEBUG] Parsing result for {source_label}: total_rows_extracted={len(raw_records)}")
    if raw_records:
        sample = raw_records[0]
        logger.info(
            "[INGEST DEBUG] Sample parsed record: "
            f"raw_shop_name={sample.get('shop_name_raw')!r} "
            f"gross={sample.get('gross_sales')!r} "
            f"deductions={sample.get('deductions')!r} "
            f"net={sample.get('net_sale')!r}"
        )

    for item in raw_records:
        platform_str = str(item["platform"]).strip()
        raw_shop = str(item.get("shop_name_raw", "")).strip()

        # Resolve the tenant brand id with strict precedence:
        #   (1) explicit brand_id param (forwarded from the Gmail ingestion layer),
        #   (2) per-record hint stamped under details.source_email.brand_id.
        # No third tier: when neither resolves AND no tenant_brand_ids are given,
        # the guard below raises NO_BRAND_SCOPE (fails CLOSED) — never a global brand.
        details_raw = item.get("details") or {}
        brand_id_hint = (
            str((details_raw.get("source_email") or {}).get("brand_id") or "").strip()
            or None
        )
        effective_brand_id = brand_id or brand_id_hint
        if not effective_brand_id and not tenant_brand_ids:
            logger.error("[INGEST ERROR] No tenant scope (no brand_id, no record hint, no tenant_brand_ids).")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail={
                    "error": "NO_BRAND_SCOPE",
                    "message": (
                        "Could not determine a tenant scope for this ingestion. "
                        "Pass brand_id/tenant_brand_ids explicitly, or add a record "
                        "brand hint under details.source_email.brand_id."
                    ),
                },
            )

        # 1. Resolve store mapping to branch_id — ALWAYS returns a branch_id
        #    (zero-error auto-discovery) plus a resolution status. The platform
        #    passed to the resolver is the explicit-platform param when supplied,
        #    else the per-row platform.
        resolve_platform = (platform or platform_str).strip()
        try:
            branch_id, store_brand_id, mapping_status = resolve_branch_id(
                resolve_platform,
                raw_shop_name=raw_shop,
                brand_id=effective_brand_id,
                supabase_client=db,
                tenant_brand_ids=tenant_brand_ids,
                user_id=user_id,
            )
        except ResolverDatabaseUnavailable as exc:
            # Fail closed: never auto-create a branch from an incomplete DB
            # read. The caller can retry the same attachment safely.
            logger.error("[INGEST ERROR] Resolver database unavailable; refusing write: %s", exc)
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail={
                    "error": "RESOLVER_DATABASE_UNAVAILABLE",
                    "message": "Could not verify the existing branch mapping; no sales row was written.",
                },
            ) from exc
        logger.info(
            f"[RESOLVER DEBUG] raw_shop_name={raw_shop!r} -> resolved branch_id={branch_id} "
            f"(store_brand_id={store_brand_id}, Status: {mapping_status!r})"
        )

        # 1b. Verify the resolved branch_id actually exists in public.branches
        #     before attempting the upsert (a non-existent branch is a silent
        #     FK-failure root cause -> expose it loudly).
        branch_exists = _verify_branch_exists(db, str(branch_id))
        logger.info(
            f"[INGEST DEBUG] branch_id={branch_id} exists_in_branches={branch_exists}"
        )
        if not branch_exists:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail={
                    "error": "BRANCH_NOT_FOUND",
                    "message": (
                        f"Resolved branch_id {branch_id} does not exist in public.branches; "
                        "cannot upsert daily_report row. Check branch auto-discovery."
                    ),
                    "branch_id": str(branch_id),
                    "raw_shop_name": raw_shop,
                    "platform": platform_str,
                },
            )

        # 2. Strict financial precision & formula verification: net_sale == gross_sales - deductions
        gross = Decimal(str(item["gross_sales"])).quantize(Decimal("0.01"))
        deductions = Decimal(str(item.get("deductions", "0.00"))).quantize(Decimal("0.01"))
        net = Decimal(str(item["net_sale"])).quantize(Decimal("0.01"))

        expected_net = (gross - deductions).quantize(Decimal("0.01"))
        logger.info(f"Financial Check: Net {net} == Gross {gross} - Deductions {deductions}")
        if abs(expected_net - net) > Decimal("0.05"):
            logger.error(
                f"[INGEST ERROR] Financial mismatch: net={net} gross={gross} deductions={deductions} "
                f"expected_net={expected_net}"
            )
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail={
                    "error": "FINANCIAL_CALCULATION_MISMATCH",
                    "message": f"net_sale ({net}) does not equal gross_sales ({gross}) - deductions ({deductions})",
                    "gross_sales": str(gross),
                    "deductions": str(deductions),
                    "net_sale": str(net),
                    "expected_net_sale": str(expected_net)
                }
            )

        # 3. Annotation: if the branch was auto-assigned without a confident match,
        #    flag the row for user confirmation and preserve the original name.
        details = dict(details_raw) if isinstance(details_raw, dict) else {}
        if mapping_status == STATUS_PENDING_CONFIRMATION:
            details["mapping_status"] = STATUS_PENDING_CONFIRMATION
            details["unmapped_raw_name"] = raw_shop

        # 4. Create DailyReportUpsert model instance with detailed breakdown
        upsert_model = DailyReportUpsert(
            branch_id=branch_id,
            platform=item["platform"],
            report_date=item["report_date"],
            shop_name_raw=raw_shop or None,
            order_count=int(item.get("order_count", 0)),
            gross_sales=gross,
            deductions=deductions,
            net_sale=expected_net,
            details=details
        )
        validated_upserts.append(upsert_model)

    # 4. Perform Supabase Upsert (Idempotency on branch_id, platform, report_date)
    if db is not None:
        db_payloads = [
            {
                "branch_id": str(u.branch_id),
                "platform": u.platform.value if hasattr(u.platform, "value") else str(u.platform),
                "report_date": str(u.report_date),
                "shop_name_raw": u.shop_name_raw,
                "order_count": u.order_count,
                "gross_sales": str(u.gross_sales),
                "deductions": str(u.deductions),
                "net_sale": str(u.net_sale),
                "details": u.details,
            }
            for u in validated_upserts
        ]

        # Deep audit: log every payload, then perform AN UNMASKED upsert.
        logger.info(
            "Preparing to upsert payload into daily_reports: "
            f"{json.dumps(db_payloads, default=str)}"
        )
        try:
            response = (
                db.table("daily_reports")
                .upsert(db_payloads, on_conflict="branch_id, platform, report_date")
                .execute()
            )
        except Exception as e:
            logger.error(f"❌ SUPABASE WRITE FAILED: {e}", exc_info=True)
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail={"error": "DATABASE_UPSERT_FAILED", "message": f"Database write failed: {e}"},
            )

        # An idle/empty upsert response is a REAL failure of the default PostgREST
        # insert config (upsert returning no rows) — surface it, never fake a 200.
        response_data = getattr(response, "data", None)
        logger.info(f"✅ Supabase Upsert Success! Returned data: {response_data}")
        if response_data is None:
            logger.error("❌ SUPABASE UPSERT returned NO data (empty response).")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail={
                    "error": "UPSERT_EMPTY_RESPONSE",
                    "message": (
                        "Supabase upsert returned no data. Verify PostgREST insert "
                        "permissions / response headers; no rows were confirmed committed."
                    ),
                },
            )
        upsert_count = len(response_data)
    else:
        # No DB client available: we cannot verify any write — do NOT claim success.
        logger.error("[AUDIT] No Supabase client available; refusing to claim upsert success.")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "error": "NO_DATABASE_CLIENT",
                "message": "Supabase client unavailable; upsert could not be executed or verified.",
            },
        )

    for u in validated_upserts:
        response_items.append(
            IngestionItemResponse(
                branch_id=u.branch_id,
                platform=u.platform,
                report_date=str(u.report_date),
                shop_name_raw=u.shop_name_raw or "",
                order_count=u.order_count,
                gross_sales=u.gross_sales,
                deductions=u.deductions,
                net_sale=u.net_sale,
                upsert_status="UPSERTED"
            )
        )

    return IngestionResponse(
        success=True,
        total_processed=len(validated_upserts),
        total_upserted=upsert_count,
        records=response_items,
        details={
            "idempotency_key": "UNIQUE (branch_id, platform, report_date)",
            "precision": "NUMERIC(12,2)"
        }
    )
