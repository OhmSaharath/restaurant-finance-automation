"""Menu-sales ingest: scan (stateless preview) + ingest (write path). Phase 1.

POST /api/v1/menu-sales/scan
  Upload a Grab CSV / LINE MAN xlsx menu-sales file and preview the detected
  dates, branch, parsed rows, and per-row auto-match result. NEVER writes:
  it parses and matches in memory (service-role key is not even required for
  the parse; the brand's menu_items are read brand-scoped for matching).

POST /api/v1/menu-sales/ingest
  Parse, match, and persist:
    - matched items -> upsert daily_item_sales with menu_item_id + a snapshot
      of unit_cost + cogs = unit_cost * quantity;
    - unmatched items -> create a new menu_items row (brand_id, name, auto
      menu_code, cost=NULL) THEN upsert daily_item_sales with unit_cost/cogs
      NULL (the user enters the cost later — never fabricated);
    - persist menu_item_platform_mappings for every resolved name.
  Idempotent: daily_item_sales upserts on the deterministic unique key
  (brand_id, branch_key, platform, report_date, raw_item_name).

Guardrails: get_authenticated_user + slowapi rate limit; every query/write brand-scoped;
money as Decimal / NUMERIC(12,2); secrets via env-only config.
"""
import logging
import uuid
import unicodedata
from datetime import datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile, status
from pydantic import BaseModel, Field

from app.core.config import settings
from app.core.auth import get_authenticated_user, get_tenant_scope, require_write_access
from app.core.database import get_supabase_client
from app.core.rate_limit import limiter
from app.ingestion.menu_item_matcher import match_item_name, normalize_item_name
from app.ingestion.menu_sales_parser import (
    MenuSalesParseError,
    parse_grab_menu_sales,
    parse_lineman_menu_sales,
)
from app.ingestion.resolver import resolve_branch_id

logger = logging.getLogger("menu_sales")

router = APIRouter(prefix="/menu-sales", tags=["Menu Sales Ingest"])

_PLATFORMS = {"Grab", "LINE MAN", "Shopee Food", "Robinhood"}


class ParsedRowResult(BaseModel):
    raw_item_name: str
    quantity: Decimal = Field(default=Decimal("0.00"), decimal_places=2, max_digits=12)
    item_gross: Optional[Decimal] = Field(default=None, decimal_places=2, max_digits=12)
    matched_menu_item_id: Optional[str] = None
    matched_item_name: Optional[str] = None
    match_status: str = "UNMATCHED"


class MenuSalesScanFileResult(BaseModel):
    """Per-file outcome for /scan (status ok|error, never aborts the batch)."""
    filename: str
    status: str = "ok"
    detected_dates: List[str] = Field(default_factory=list)
    rows: List[ParsedRowResult] = Field(default_factory=list)
    row_count: int = 0
    matched_count: int = 0
    unmatched_count: int = 0
    error: Optional[str] = None


class MenuSalesScanResponse(BaseModel):
    status: str = "ok"  # "ok" | "partial" (some files failed) | "error" (all failed)
    platform: str
    brand_id: str
    detected_dates: List[str] = Field(default_factory=list)
    detected_branches: List[str] = Field(default_factory=list)
    rows: List[ParsedRowResult] = Field(default_factory=list)
    row_count: int = 0
    matched_count: int = 0
    unmatched_count: int = 0
    ok_count: int = 0
    failed_count: int = 0
    files: List[MenuSalesScanFileResult] = Field(default_factory=list)


class IngestRowResult(ParsedRowResult):
    menu_item_id: Optional[str] = None
    cogs: Optional[Decimal] = Field(default=None, decimal_places=2, max_digits=12)


class MenuSalesIngestFileResult(BaseModel):
    """Per-file outcome for /ingest (status ok|error, never aborts the batch)."""
    filename: str
    status: str = "ok"
    report_dates: List[str] = Field(default_factory=list)
    ingested_rows: int = 0
    matched_rows: int = 0
    created_rows: int = 0
    cogs_total: Decimal = Field(default=Decimal("0.00"), decimal_places=2, max_digits=12)
    error: Optional[str] = None


class MenuSalesIngestResponse(BaseModel):
    status: str = "ok"  # "ok" | "partial" | "error"
    platform: str
    brand_id: str
    report_dates: List[str] = Field(default_factory=list)
    ingest_date: str
    branch_id: Optional[str] = None
    ingested_rows: int = 0
    matched_rows: int = 0
    created_rows: int = 0
    cogs_total: Decimal = Field(default=Decimal("0.00"), decimal_places=2, max_digits=12)
    costed_rows: int = 0
    rows: List[IngestRowResult] = Field(default_factory=list)
    total_ingested_rows: int = 0
    total_matched_rows: int = 0
    total_created_rows: int = 0
    total_cogs: Decimal = Field(default=Decimal("0.00"), decimal_places=2, max_digits=12)
    ok_count: int = 0
    failed_count: int = 0
    files: List[MenuSalesIngestFileResult] = Field(default_factory=list)


def _canonical_platform(raw: str) -> str:
    p = (raw or "").strip()
    return {"Grab": "Grab", "LINE MAN": "LINE MAN", "Line Man": "LINE MAN",
            "lineman": "LINE MAN", "LINE_MAN": "LINE MAN",
            "Shopee Food": "Shopee Food", "ShopeeFood": "Shopee Food",
            "Robinhood": "Robinhood", "Robin Hood": "Robinhood"}.get(p, p)


def _fetch_menu_items(db, brand_id: str) -> List[Dict[str, Any]]:
    """Fetch the brand's menu_items (active first, but keep all for matching)."""
    if db is None:
        return []
    try:
        resp = db.table("menu_items").select("id, brand_id, name, is_active, cost") \
            .eq("brand_id", brand_id).execute()
        return [dict(r) for r in (resp.data or [])]
    except Exception as exc:  # noqa: BLE001
        logger.error(f"[MENU SALES] Failed to fetch menu_items for brand {brand_id}: {exc}")
        return []


def _parse_upload(platform: str, filename: str, content: bytes) -> List[Dict[str, Any]]:
    """Parse one uploaded file.

    Raises MenuSalesParseError on failure (empty file, unsupported platform,
    LINE MAN range/multi-date filename). Callers wrap this PER FILE so a single
    bad file never aborts the rest of the batch.
    """
    if platform == "Grab":
        return parse_grab_menu_sales(content, filename)
    if platform == "LINE MAN":
        return parse_lineman_menu_sales(content, filename)
    raise MenuSalesParseError(
        f"Platform {platform!r} is not supported for menu-sales parsing yet."
    )


def _aggregate_source_rows(records: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Aggregate repeated source lines before writing ``daily_item_sales``.

    Grab exports commonly contain several order lines for the same menu in a
    branch/day.  The database idempotency key is the raw item name, so writing
    those rows one-by-one makes the last line overwrite the earlier quantity
    and gross.  Aggregate only an exact display-name identity (NFC + whitespace
    cleanup); promotional/portion variants remain separate aliases and are not
    silently merged.  The first display spelling is retained for auditability.
    """
    grouped: Dict[tuple, Dict[str, Any]] = {}
    for rec in records:
        raw = str(rec.get("raw_item_name") or "").strip()
        # NFC + whitespace folding fixes harmless export formatting drift while
        # deliberately preserving promo text, brackets, and x2/x4 portions.
        raw_key = " ".join(unicodedata.normalize("NFC", raw).split())
        key = (
            rec.get("platform"),
            rec.get("branch_name") or "",
            rec.get("report_date"),
            raw_key,
        )
        current = grouped.get(key)
        if current is None:
            current = dict(rec)
            current["raw_item_name"] = raw
            grouped[key] = current
            continue
        current["quantity"] = Decimal(str(current.get("quantity") or "0")) + Decimal(
            str(rec.get("quantity") or "0")
        )
        old_gross = current.get("item_gross")
        new_gross = rec.get("item_gross")
        if old_gross is None:
            current["item_gross"] = new_gross
        elif new_gross is not None:
            current["item_gross"] = Decimal(str(old_gross)) + Decimal(str(new_gross))
    return list(grouped.values())


def _scan_records_to_result(
    records: List[Dict[str, Any]],
    menu_items: List[Dict[str, Any]],
    brand_id: str,
    platform: str,
) -> tuple:
    """Match every record for one scanned file -> (dates, branches, rows, matched, unmatched)."""
    dates: List[str] = []
    branches: List[str] = []
    rows: List[ParsedRowResult] = []
    matched = unmatched = 0
    for rec in _aggregate_source_rows(records):
        if rec["report_date"] and rec["report_date"] not in dates:
            dates.append(rec["report_date"])
        b = rec.get("branch_name")
        if b and b not in branches:
            branches.append(b)
        mid, mstatus = match_item_name(
            rec["raw_item_name"], menu_items, brand_id, platform, db=None
        )
        mname = None
        if mid:
            for it in menu_items:
                if str(it.get("id")) == str(mid):
                    mname = it.get("name")
                    break
        if mstatus == "UNMATCHED":
            unmatched += 1
        else:
            matched += 1
        rows.append(ParsedRowResult(
            raw_item_name=rec["raw_item_name"],
            quantity=rec["quantity"],
            item_gross=rec["item_gross"],
            matched_menu_item_id=mid,
            matched_item_name=mname,
            match_status=mstatus,
        ))
    return dates, branches, rows, matched, unmatched


def _ingest_one_file(
    db,
    platform: str,
    brand_id: str,
    filename: str,
    records: List[Dict[str, Any]],
    menu_items: List[Dict[str, Any]],
    tenant_brand_ids: Optional[List[str]] = None,
    user_id: Optional[str] = None,
) -> tuple:
    """Parse-free ingest of one file's records.

    Returns (MenuSalesIngestFileResult, resolved_branch_id, result_rows, costed).
    The /ingest endpoint merges these per-file totals into the aggregate union.
    Every write stays brand-scoped; money is Decimal/ROUND_HALF_UP; unknown
    costs are never fabricated (unit_cost/cogs stay NULL).

    MULTI-STORE RE-KEY: each record's branch is resolved via ``resolve_branch_id``
    which now returns the STORE brand that owns the branch. Matching + the sales
    write are re-keyed to that ``store_brand_id`` (never the form ``brand_id``),
    so daily_item_sales.brand_id and branch_id always belong to the SAME store.
    ``menu_items`` is the initial store (the form brand_id) and is used as the
    base case; a per-store cache swaps in each store's own menu_items the first
    time a row resolves to that store.
    """
    records = _aggregate_source_rows(records)
    report_dates = sorted({r["report_date"] for r in records if r["report_date"]})

    matched_rows = created_rows = ingested = costed = 0
    result_rows: List[IngestRowResult] = []
    resolved_branch_id: Optional[str] = None

    # Per-store menu_items cache. ``menu_items`` (the caller's form-brand_id
    # fetch) is the initial store; when a row resolves to a different store we
    # swap to that store's items so matching + cost lookup are store-scoped.
    current_store_brand_id = brand_id
    current_menu_items = menu_items

    for rec in records:
        branch_id: Optional[str] = None
        store_brand_id: Optional[str] = None
        if rec.get("branch_name"):
            try:
                branch_id, store_brand_id, _status = resolve_branch_id(
                    platform, rec["branch_name"], brand_id, db=db,
                    tenant_brand_ids=tenant_brand_ids, user_id=user_id,
                )
            except ValueError as exc:
                # Resolver fail-closed (no tenant scope / mismatched brand_id) —
                # do NOT silently re-key to the form brand. Surface the row as an
                # error instead of writing a NULL-branch ghost under the primary brand.
                logger.error(f"[MENU SALES] resolver fail-closed for {rec['raw_item_name']!r}: {exc}")
                continue
            except Exception as exc:  # noqa: BLE001
                logger.error(f"[MENU SALES] branch resolve failed: {exc}")
                branch_id = None
            if branch_id and resolved_branch_id is None:
                resolved_branch_id = branch_id

        # The write + matching store is the RESOLVED store brand (never a client
        # brand). Fall back to the form brand_id only when the resolver produced
        # no branch (no branch_name on the record).
        if not store_brand_id:
            store_brand_id = brand_id

        # Swap the per-store menu_items cache when this row's store differs.
        if store_brand_id != current_store_brand_id:
            current_menu_items = _fetch_menu_items(db, store_brand_id)
            current_store_brand_id = store_brand_id
        by_id = {str(it.get("id")): it for it in current_menu_items}

        mid, mstatus = match_item_name(
            rec["raw_item_name"], current_menu_items, store_brand_id, platform, db=db
        )

        unit_cost: Optional[Decimal] = None
        cogs: Optional[Decimal] = None
        if mid and str(mid) in by_id:
            costv = by_id[str(mid)].get("cost")
            if costv is not None and Decimal(str(costv)) != 0:
                unit_cost = Decimal(str(costv)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
                cogs = (unit_cost * rec["quantity"]).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
                costed += 1
        if mid is None:
            mid = _ensure_menu_item(db, store_brand_id, rec["raw_item_name"])
            created_rows += 1
            try:
                db.table("menu_item_platform_mappings").upsert(
                    {"brand_id": store_brand_id, "menu_item_id": mid,
                     "platform": platform, "raw_item_name": rec["raw_item_name"].strip()},
                    on_conflict="brand_id,platform,raw_item_name",
                ).execute()
            except Exception:  # noqa: BLE001 - mapping is a cache
                pass
        else:
            matched_rows += 1

        ds_payload = {
            "brand_id": store_brand_id,
            "platform": platform,
            "report_date": rec["report_date"],
            "raw_item_name": rec["raw_item_name"],
            "quantity": rec["quantity"],
            "item_gross": rec["item_gross"],
            "menu_item_id": mid,
            "unit_cost": unit_cost,
            "cogs": cogs,
        }
        if branch_id:
            ds_payload["branch_id"] = branch_id
        _upsert_daily_item_sales(db, ds_payload)
        ingested += 1

        result_rows.append(IngestRowResult(
            raw_item_name=rec["raw_item_name"], quantity=rec["quantity"],
            item_gross=rec["item_gross"], matched_menu_item_id=mid,
            matched_item_name=by_id[str(mid)].get("name") if mid and str(mid) in by_id else None,
            match_status=mstatus, menu_item_id=mid, cogs=cogs,
        ))

    # total_cogs = SUM of the already-quantized per-row cogs, so the report
    # reconciles EXACTLY with SUM(daily_item_sales.cogs) (round-then-sum, never
    # sum-then-round which drifts by a cent on fractional quantities).
    cogs_total = sum(
        (r.cogs for r in result_rows if r.cogs is not None),
        start=Decimal("0.00"),
    ).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)

    file_result = MenuSalesIngestFileResult(
        filename=filename, status="ok", report_dates=report_dates,
        ingested_rows=ingested, matched_rows=matched_rows,
        created_rows=created_rows, cogs_total=cogs_total,
    )
    return file_result, resolved_branch_id, result_rows, costed


def _batch_status(ok_count: int, failed_count: int) -> str:
    if failed_count == 0:
        return "ok"
    if ok_count == 0:
        return "error"
    return "partial"


@router.post(
    "/scan",
    response_model=MenuSalesScanResponse,
    status_code=status.HTTP_200_OK,
    summary="Preview Grab/LINE MAN menu-sales files (multi-file batch) without writing",
    description="Parses each uploaded menu-sales file and returns detected dates, "
    "branch(es), rows, and per-row auto-match results per file, plus a union. "
    "A file that fails to parse becomes a per-file 'error' — the batch never aborts.",
)
@limiter.limit(settings.RATE_LIMIT_PER_MINUTE)
async def scan_menu_sales(
    request: Request,
    files: List[UploadFile] = File(..., description="Menu-sales files (.csv Grab / .xlsx LINE MAN)"),
    platform: str = Form(..., description="Grab | LINE MAN"),
    user_id: str = Depends(get_authenticated_user),
) -> MenuSalesScanResponse:
    platform = _canonical_platform(platform)
    if platform not in ("Grab", "LINE MAN"):
        raise HTTPException(
            status_code=422,
            detail={"error": "UNSUPPORTED_PLATFORM", "message": f"Platform {platform!r} not supported."},
        )
    if not files:
        raise HTTPException(status_code=400, detail={"error": "NO_FILES", "message": "No files uploaded."})

    # Tenant scope is DERIVED server-side from the authenticated user's
    # brand_users rows — never from a client field. brand_id (primary) is the
    # first brand in the user's set; the full set (tenant_brand_ids) is not
    # needed for this stateless preview (the /ingest write path consumes it).
    db = get_supabase_client()
    if db is None:
        raise HTTPException(status_code=503, detail={"error": "DB_UNAVAILABLE",
                                                     "message": "Database client unavailable."})
    scope_user_id, tenant_brand_ids = get_tenant_scope(db, user_id)
    if not tenant_brand_ids:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"error": "NO_TENANT_BRAND",
                    "message": "Authenticated user has no linked brand (brand_users)."},
        )
    brand_id = tenant_brand_ids[0]

    # Read the brand's menu_items (brand-scoped) once for the whole batch. No writes.
    menu_items = _fetch_menu_items(db, brand_id)

    all_dates: List[str] = []
    all_branches: List[str] = []
    all_rows: List[ParsedRowResult] = []
    file_results: List[MenuSalesScanFileResult] = []
    ok_count = failed_count = matched_total = unmatched_total = 0

    for fl in files:
        filename = fl.filename or ""
        content = await fl.read()
        if not content:
            file_results.append(MenuSalesScanFileResult(
                filename=filename, status="error", error="Uploaded file is empty."))
            failed_count += 1
            continue
        try:
            records = _parse_upload(platform, filename, content)
        except Exception as exc:  # noqa: BLE001 - per-file failure; never abort the batch
            file_results.append(MenuSalesScanFileResult(
                filename=filename, status="error", error=str(exc)))
            failed_count += 1
            continue
        dates, branches, rows, matched, unmatched = _scan_records_to_result(
            records, menu_items, brand_id, platform
        )
        file_results.append(MenuSalesScanFileResult(
            filename=filename, status="ok", detected_dates=dates, rows=rows,
            row_count=len(rows), matched_count=matched, unmatched_count=unmatched))
        ok_count += 1
        matched_total += matched
        unmatched_total += unmatched
        for d in dates:
            if d not in all_dates:
                all_dates.append(d)
        for b in branches:
            if b not in all_branches:
                all_branches.append(b)
        all_rows.extend(rows)

    return MenuSalesScanResponse(
        status=_batch_status(ok_count, failed_count),
        platform=platform, brand_id=brand_id,
        detected_dates=all_dates, detected_branches=all_branches,
        rows=all_rows, row_count=len(all_rows),
        matched_count=matched_total, unmatched_count=unmatched_total,
        ok_count=ok_count, failed_count=failed_count, files=file_results,
    )


def _ensure_menu_item(db, brand_id: str, raw_item_name: str) -> str:
    """Return an existing menu_item id for the name, else create one (cost NULL).

    Looks up by brand-scoped name first so consecutive identical unmatched rows
    in one file reuse a single menu_item. A newly created row carries an auto
    menu_code and cost=NULL (the user fills the cost later — never fabricated).
    """
    norm = normalize_item_name(raw_item_name)
    if norm:
        try:
            # Prefer the DB-enforced canonical identity; retain the exact-name
            # fallback for older local databases that predate the migration.
            try:
                resp = db.table("menu_items").select("id").eq("brand_id", brand_id) \
                    .eq("normalized_name", norm).limit(1).execute()
            except Exception:
                resp = db.table("menu_items").select("id").eq("brand_id", brand_id) \
                    .eq("name", norm).limit(1).execute()
            if resp.data:
                return str(resp.data[0]["id"])
        except Exception as exc:  # noqa: BLE001
            logger.error(f"[MENU SALES] menu_items lookup failed: {exc}")

    code = f"AUTO-{uuid.uuid4().hex[:6].upper()}"
    payload = {"brand_id": brand_id, "name": norm or raw_item_name.strip(),
               "menu_code": code, "cost": None, "is_active": True}
    try:
        resp = db.table("menu_items").insert(payload).execute()
        if resp.data:
            return str(resp.data[0]["id"])
    except Exception as exc:  # noqa: BLE001
        logger.error(f"[MENU SALES] menu_items create failed for {brand_id!r}: {exc}")
        # Fall back to a re-lookup (a concurrent create may have won the race).
        try:
            try:
                resp = db.table("menu_items").select("id").eq("brand_id", brand_id) \
                    .eq("normalized_name", norm).limit(1).execute()
            except Exception:
                resp = db.table("menu_items").select("id").eq("brand_id", brand_id) \
                    .eq("name", norm).limit(1).execute()
            if resp.data:
                return str(resp.data[0]["id"])
        except Exception:  # noqa: BLE001
            pass
    raise HTTPException(status_code=503, detail={"error": "DB_WRITE_FAILED",
                                                 "message": "Could not create menu_item."})


def _upsert_daily_item_sales(db, row: Dict[str, Any]) -> None:
    """Upsert a daily_item_sales row on the deterministic unique key."""
    payload = {
        "brand_id": row["brand_id"],
        "platform": row["platform"],
        "report_date": row["report_date"],
        "raw_item_name": row["raw_item_name"],
        "quantity": str(row["quantity"]),
    }
    if row.get("item_gross") is not None:
        payload["item_gross"] = str(row["item_gross"])
    if row.get("branch_id"):
        payload["branch_id"] = row["branch_id"]
    if row.get("menu_item_id"):
        payload["menu_item_id"] = row["menu_item_id"]
    if row.get("unit_cost") is not None:
        payload["unit_cost"] = str(row["unit_cost"])
    if row.get("cogs") is not None:
        payload["cogs"] = str(row["cogs"])
    try:
        db.table("daily_item_sales").upsert(
            payload,
            on_conflict="brand_id,branch_key,platform,report_date,raw_item_name",
        ).execute()
    except Exception as exc:  # noqa: BLE001
        # A batch is atomic per file; a partial failure should surface.
        logger.error(f"[MENU SALES] daily_item_sales upsert failed: {exc}")
        raise HTTPException(status_code=503, detail={"error": "DB_WRITE_FAILED",
                                                     "message": f"daily_item_sales upsert failed: {exc}"})


@router.post(
    "/ingest",
    response_model=MenuSalesIngestResponse,
    status_code=status.HTTP_200_OK,
    summary="Parse, match, and persist menu-sales files (multi-file batch, idempotent)",
    description="Parses each file, auto-matches items, creates unmatched "
    "menu_items (cost NULL), snapshots unit_cost + cogs on matched rows, and "
    "upserts daily_item_sales idempotently. A file that fails to parse becomes "
    "a per-file 'error' — the rest of the batch still writes. Re-upload "
    "overwrites, never duplicates.",
)
@limiter.limit(settings.RATE_LIMIT_PER_MINUTE)
async def ingest_menu_sales(
    request: Request,
    files: List[UploadFile] = File(..., description="Menu-sales files (.csv Grab / .xlsx LINE MAN)"),
    platform: str = Form(..., description="Grab | LINE MAN"),
    user_id: str = Depends(get_authenticated_user),
) -> MenuSalesIngestResponse:
    db = get_supabase_client()
    require_write_access(db, user_id)
    platform = _canonical_platform(platform)
    if platform not in ("Grab", "LINE MAN"):
        raise HTTPException(status_code=422, detail={"error": "UNSUPPORTED_PLATFORM",
                                                     "message": f"Platform {platform!r} not supported."})
    if not files:
        raise HTTPException(status_code=400, detail={"error": "NO_FILES", "message": "No files uploaded."})

    # Tenant scope is DERIVED server-side from the authenticated user's
    # brand_users rows — never from a client field. brand_id (primary) is the
    # first brand in the user's set; the full set (tenant_brand_ids) scopes the
    # store/branch resolver so the write can only touch in-scope stores and
    # links newly-created stores to the authenticated user.
    if db is None:
        raise HTTPException(status_code=503, detail={"error": "DB_UNAVAILABLE",
                                                     "message": "Database client unavailable."})

    scope_user_id, tenant_brand_ids = get_tenant_scope(db, user_id)
    if not tenant_brand_ids:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"error": "NO_TENANT_BRAND",
                    "message": "Authenticated user has no linked brand (brand_users)."},
        )
    brand_id = tenant_brand_ids[0]

    file_results: List[MenuSalesIngestFileResult] = []
    all_rows: List[IngestRowResult] = []
    all_report_dates: List[str] = []
    ok_count = failed_count = 0
    total_ingested = total_matched = total_created = costed_total = 0
    cogs_total = Decimal("0.00")
    resolved_branch_id: Optional[str] = None

    for fl in files:
        filename = fl.filename or ""
        content = await fl.read()
        if not content:
            file_results.append(MenuSalesIngestFileResult(
                filename=filename, status="error", error="Uploaded file is empty."))
            failed_count += 1
            continue
        try:
            records = _parse_upload(platform, filename, content)
        except Exception as exc:  # noqa: BLE001 - per-file failure; never abort the batch
            file_results.append(MenuSalesIngestFileResult(
                filename=filename, status="error", error=str(exc)))
            failed_count += 1
            continue

        # Fresh brand-scoped menu_items per file so items created by an earlier
        # file in this batch are available for matching later ones.
        menu_items = _fetch_menu_items(db, brand_id)
        fr, bid, result_rows, costed = _ingest_one_file(
            db, platform, brand_id, filename, records, menu_items,
            tenant_brand_ids=tenant_brand_ids, user_id=scope_user_id,
        )
        file_results.append(fr)
        ok_count += 1
        total_ingested += fr.ingested_rows
        total_matched += fr.matched_rows
        total_created += fr.created_rows
        costed_total += costed
        cogs_total += fr.cogs_total
        all_rows.extend(result_rows)
        if bid and resolved_branch_id is None:
            resolved_branch_id = bid
        for d in fr.report_dates:
            if d not in all_report_dates:
                all_report_dates.append(d)

    cogs_total = cogs_total.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)

    return MenuSalesIngestResponse(
        status=_batch_status(ok_count, failed_count),
        platform=platform, brand_id=brand_id, report_dates=all_report_dates,
        ingest_date=datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        branch_id=resolved_branch_id,
        ingested_rows=total_ingested, matched_rows=total_matched, created_rows=total_created,
        cogs_total=cogs_total, costed_rows=costed_total, rows=all_rows,
        total_ingested_rows=total_ingested, total_matched_rows=total_matched,
        total_created_rows=total_created, total_cogs=cogs_total,
        ok_count=ok_count, failed_count=failed_count, files=file_results,
    )
