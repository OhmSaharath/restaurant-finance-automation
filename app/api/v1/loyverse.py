"""Loyverse Phase 2: in-store (Loyverse POS) receipt -> daily_reports ingestion.

Pulls the owner's Loyverse POS SALE receipts and aggregates them per
(branch_id, receipt_date) into ``daily_reports`` under the platform literal
``LOYVERSE_INSTORE``, so in-store revenue appears on the finance dashboard
alongside Grab / LINE MAN / Shopee Food / Robinhood.

Design / guardrails (owner-confirmed, do not reverse):
  - In-store receipts have NO platform commission: deductions = 0.00, net = gross.
  - Platform label is the literal string ``LOYVERSE_INSTORE``.
  - REFUND receipts (receipt_type == \"REFUND\") are EXCLUDED — never netted into
    gross, never double-counted. Only SALE receipts are ingested.
  - One Loyverse account has MULTIPLE stores; ``loyverse_config.store_branch_map``
    (JSONB array of {store_id, store_name, branch_id}) maps each store to one of
    our branches. ONLY mapped stores are ingested; an unmapped store_id is
    skipped (logged + counted, never written, never written to a guessed branch).
  - Token decrypt reuses the EXISTING AES-256-GCM ``decrypt_refresh_token`` in
    app/ingestion/gmail_push.py (token stored with the same encryption the web
    save route used). No new AES code.
  - 31-day history limit: Loyverse returns ``402 PAYMENT_REQUIRED`` for receipts
    older than 31 days without \"Unlimited Sales History\". We ingest WHATEVER the
    API returns and degrade gracefully via a non-blocking ``note_31day_history``
    flag — never error the whole run.
  - The daily_reports write is done DIRECTLY here (branch comes from the owner's
    explicit store->branch map, NOT the delivery-platform name-matching resolver),
    mirroring the db_payloads upsert shape in _process_and_upsert_records with
    on_conflict=\"branch_id, platform, report_date\".
"""
import asyncio
import logging
import uuid
from decimal import Decimal, ROUND_HALF_UP
from typing import Any, Callable, Dict, List, Optional, Tuple

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, status
from supabase import Client

from app.api.v1.menu_sales import _upsert_daily_item_sales
from app.ingestion.menu_item_matcher import normalize_item_name

from app.api.v1.gmail_ingestion import _verify_oidc_bearer
from app.core.auth import (
    get_authenticated_user,
    get_tenant_scope,
    require_write_access,
    resolve_brand_id_from_scope,
)
from app.core.config import settings
from app.core.database import get_db
from app.core.rate_limit import limiter
from app.ingestion.gmail_push import decrypt_refresh_token

logger = logging.getLogger("ingestion_audit")

router = APIRouter(prefix="/integrations/loyverse", tags=["Loyverse In-store Ingestion"])

LOYVERSE_API_BASE = "https://api.loyverse.com/v1.0"
LOYVERSE_RECEIPTS_ENDPOINT = f"{LOYVERSE_API_BASE}/receipts"
MAX_PAGES = 100  # safety cap for cursor pagination
PAGE_SIZE = 250

# The exact platform literal written into daily_reports.platform (must match the
# widened CHECK constraint from 20260916_loyverse_platform.sql exactly).
PLATFORM_LOYVERSE_INSTORE = "LOYVERSE_INSTORE"

LOYVERSE_ITEMS_ENDPOINT = f"{LOYVERSE_API_BASE}/items"

# Payment method names that signify a genuine IN-STORE (front-of-house) sale.
# Every other payment name (Lineman/Grabfood/Robinhood/Shoppee E-Payment, credit
# card, etc.) is an ONLINE order whose revenue ALREADY arrives via the Gmail
# settlement pipeline — counting it here would double-count. Names are written as
# \u escapes (never raw Thai) to avoid mojibake through file edits. Verified
# against the live account's distinct payment names.
# DEFAULT in-store payment method names, used only when a brand has NOT set its
# own allowlist in ``loyverse_config.payment_names``. Every other payment name
# (Lineman/Grabfood/Robinhood/Shoppee E-Payment, credit card, etc.) is an ONLINE
# order whose revenue ALREADY arrives via the Gmail settlement pipeline —
# counting it here would double-count. Names are written as \u escapes (never
# raw Thai) to avoid mojibake through file edits. Verified against the live
# account's distinct payment names. Each brand may override this list.
DEFAULT_INSTORE_PAYMENT_NAMES = {
    "Cash",
    "\u0e16\u0e38\u0e07\u0e40\u0e07\u0e34\u0e19",  # ถุงเงิน (cash bag)
    "QR Promtpay",
    "\u0e44\u0e17\u0e22\u0e0a\u0e48\u0e27\u0e22\u0e44\u0e17\u0e22(\u0e2b\u0e19\u0e49\u0e32\u0e23\u0e49\u0e32\u0e19)",  # ไทยช่วยไทย(หน้าร้าน)
}


def _included_payment_names(config: Optional[dict]) -> Callable[[str], bool]:
    """Return a predicate(payment_name)->bool from ``loyverse_config.payment_names``.

    Per-brand allowlist (JSONB array of strings): only the listed payment method
    names count as in-store. If a brand has NOT set its own list (None / empty
    / not a list), fall back to ``DEFAULT_INSTORE_PAYMENT_NAMES`` so existing
    tenants keep working. This keeps the filter multi-tenant: each restaurant
    declares its own in-store payment names instead of one shared hardcode.
    """
    allow: Optional[set] = None
    configured = (config or {}).get("payment_names")
    if isinstance(configured, list):
        allow = {
            str(n).strip()
            for n in configured
            if n is not None and str(n).strip()
        }
    effective = allow if (allow is not None and len(allow) > 0) else set(DEFAULT_INSTORE_PAYMENT_NAMES)

    def _included(name: str) -> bool:
        return name in effective

    return _included


# ---------------------------------------------------------------------------
# Service-role config lookup (bypasses RLS; brand-scoped)
# ---------------------------------------------------------------------------
def _lookup_config(db: Optional[Client], brand_id: str) -> Optional[dict]:
    """Return the brand's ``loyverse_config`` row or None (DB down / unregistered)."""
    if db is None:
        return None
    try:
        res = (
            db.table("loyverse_config")
            .select("brand_id, encrypted_access_token, enabled, store_branch_map, item_selection, payment_names")
            .eq("brand_id", str(brand_id))
            .limit(1)
            .execute()
        )
        data = res.data or []
        return data[0] if data else None
    except Exception as e:  # noqa: BLE001 - fail-safe on DB error
        logger.error(f"[LOYVERSE] config lookup failed for brand {brand_id}: {e}", exc_info=True)
        return None


def _owned_branch_ids(db: Optional[Client], brand_id: str, candidate_ids: List[str]) -> set:
    """Return the subset of candidate branch ids owned by ``brand_id``.

    The store->branch map is cross-checked against the branches table belonging
    to THAT brand only (`.eq(\"brand_id\", brand_id)`), so a mapping can never
    resolve to a foreign branch.
    """
    if db is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"error": "NO_DATABASE_CLIENT", "message": "Supabase client unavailable."},
        )
    try:
        res = (
            db.table("branches")
            .select("id")
            .eq("brand_id", str(brand_id))
            .in_("id", sorted(candidate_ids))
            .execute()
        )
        return {str(r["id"]) for r in (res.data or [])}
    except Exception as e:  # noqa: BLE001
        logger.error(f"[LOYVERSE] branch ownership validation failed for brand {brand_id}: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"error": "BRANCH_VALIDATION_FAILED", "message": "Could not validate store->branch ownership."},
        ) from e


def _parse_store_map(raw: Any, db: Optional[Client], brand_id: str) -> List[dict]:
    """Normalize+validate ``store_branch_map``; reject foreign/unowned branches 400.

    Returns a list of {store_id, store_name, branch_id} for the mapped stores.
    An empty map -> 400 (no stores mapped yet). Any branch NOT owned by the
    resolved brand_id -> 400 BEFORE any receipt fetch or write.
    """
    if not isinstance(raw, list) or not raw:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error": "LOYVERSE_NO_STORES_MAPPED",
                "message": "No Loyverse stores are mapped to branches yet (store_branch_map is empty).",
            },
        )

    entries: List[dict] = []
    seen_stores: set = set()
    for item in raw:
        if not isinstance(item, dict):
            continue
        store_id = str(item.get("store_id") or "").strip()
        branch_id = str(item.get("branch_id") or "").strip()
        if not store_id or not branch_id:
            continue
        if store_id in seen_stores:
            continue
        seen_stores.add(store_id)
        entries.append(
            {
                "store_id": store_id,
                "store_name": str(item.get("store_name") or store_id),
                "branch_id": branch_id,
            }
        )

    if not entries:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error": "LOYVERSE_NO_STORES_MAPPED",
                "message": "No valid store->branch entries found in store_branch_map.",
            },
        )

    candidate_branch_ids = sorted({e["branch_id"] for e in entries})
    owned = _owned_branch_ids(db, brand_id, candidate_branch_ids)
    foreign = set(candidate_branch_ids) - owned
    if foreign:
        # Fail-closed before any fetch/write: never resolve to a foreign branch.
        logger.error(
            f"[LOYVERSE] store_branch_map references branch(es) not owned by brand {brand_id}: {sorted(foreign)}"
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error": "LOYVERSE_UNOWNED_BRANCH",
                "message": "store_branch_map references a branch that does not belong to this brand.",
            },
        )
    return entries


# ---------------------------------------------------------------------------
# Financial precision
# ---------------------------------------------------------------------------
def _parse_money(value: Any, receipt_number: Any) -> Decimal:
    """Strictly parse a receipt total to NUMERIC(12,2) precision.

    A SALE receipt with a missing / non-numeric total is a data-integrity fault:
    fail closed (422) rather than silently under-report gross. Never fall back
    to 0.00 on a present-but-malformed value.
    """
    if value is None or str(value).strip() == "":
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "error": "LOYVERSE_MALFORMED_RECEIPT",
                "message": f"SALE receipt {receipt_number} has no total_money and cannot be netted into gross.",
            },
        )
    try:
        return Decimal(str(value)).quantize(Decimal("0.01"))
    except Exception:  # noqa: BLE001
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "error": "LOYVERSE_MALFORMED_RECEIPT",
                "message": f"SALE receipt {receipt_number} has a non-numeric total_money.",
            },
        ) from None


# ---------------------------------------------------------------------------
# Loyverse API (requests, raw HTTP). Token stays local; never logged/returned.
# ---------------------------------------------------------------------------
def _fetch_store_receipts(token: str, store_id: str) -> Tuple[List[dict], bool]:
    """Cursor-paginate /receipts for one mapped store; return (sale_receipts, note_31_day).

    Collects ALL receipts returned by the API (SALE + REFUND; the caller decides
    which to net). ``note_31_day`` is set True on a 402 PAYMENT_REQUIRED
    (no \"Unlimited Sales History\" beyond 31 days) — non-blocking, never raises,
    so the whole run degrades gracefully.
    """
    sale_receipts: List[dict] = []
    note_31_day = False
    cursor: Optional[str] = None
    pages = 0
    headers = {"Authorization": f"Bearer {token}"}

    while pages < MAX_PAGES:
        pages += 1
        params: Dict[str, Any] = {"limit": PAGE_SIZE, "store_id": store_id}
        if cursor:
            params["cursor"] = cursor
        try:
            resp = httpx.get(LOYVERSE_RECEIPTS_ENDPOINT, params=params, headers=headers, timeout=60.0)
        except httpx.HTTPError as e:
            logger.error(f"[LOYVERSE] API unreachable for store {store_id}: {e}")
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail={"error": "LOYVERSE_API_UNREACHABLE", "message": "Loyverse API is unreachable."},
            ) from e

        if resp.status_code == 402:
            # Graceful 31-day-history degradation — non-blocking note, not an error.
            note_31_day = True
            logger.info(
                f"[LOYVERSE] 402 PAYMENT_REQUIRED for store {store_id}: "
                "receipts older than 31 days require Unlimited Sales History."
            )
            break
        if resp.status_code == 401:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail={"error": "LOYVERSE_AUTH_FAILED", "message": "The Loyverse token is invalid or expired."},
            )
        if resp.status_code >= 400:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail={
                    "error": "LOYVERSE_API_ERROR",
                    "message": f"Loyverse API returned HTTP {resp.status_code}.",
                },
            )
        try:
            body = resp.json()
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail={"error": "LOYVERSE_API_ERROR", "message": "Loyverse API returned a non-JSON response."},
            ) from None

        sale_receipts.extend(body.get("receipts") or [])
        cursor = body.get("cursor")
        if not cursor:
            break
    return sale_receipts, note_31_day


# ---------------------------------------------------------------------------
# Itemized COGS: catalog fetch + variant cost map + item inclusion (Phase 3)
# ---------------------------------------------------------------------------
def _parse_variant_cost(value: Any) -> Optional[Decimal]:
    """Strictly parse a Loyverse variant cost to NUMERIC(12,2); None if unusable.

    A missing / empty / non-numeric / ZERO / NEGATIVE cost is ``None`` (never a
    fabricated 0.00) — a zero cost means the owner has NOT yet keyed a cost, so
    the line item is then skipped for itemized COGS. Only a POSITIVE cost
    resolves to a Decimal.
    """
    if value is None or str(value).strip() == "":
        return None
    try:
        parsed = Decimal(str(value))
    except Exception:  # noqa: BLE001 - malformed cost must not become 0.00
        return None
    if parsed <= 0:
        # A zero/negative cost means "not keyed", never a real 0.00 cost.
        return None
    return parsed.quantize(Decimal("0.01"))


def _fetch_variant_cost_map(token: str) -> Tuple[Dict[str, Decimal], Dict[str, Decimal]]:
    """Cursor-paginate /items; return (variant_id->cost, item_id->resolved cost).

    Builds the source-of-truth cost map for itemized in-store COGS, handling
    BOTH cost models Loyverse supports:

      - DIRECT item: cost lives on ``variants[].cost`` (positive only). A zero or
        missing cost means "owner hasn't keyed it" -> no cost.
      - COMPOSITE item (``is_composite`` true): the item has NO direct variant
        cost; its cost is DERIVED from a ``components[]`` list, each entry
        ``{ variant_id, quantity }`` referencing an ingredient item's variant
        (the owner's ingredient rows carry the real per-unit cost). Cost =
        SUM(component cost x quantity), computed recursively (a composite may
        reference another composite; a cycle or an uncosted component makes the
        composite's cost unresolvable -> skipped, never fabricated).

    The returned maps resolve EVERY item/variant (direct or composite) to its
    unit cost, so a receipt line_item referencing either a composite item's
    variant or a plain ingredient resolves correctly. Field names (verified
    live): item name `item_name`, variant id `variant_id` (fall back `id`),
    composite flag `is_composite`, recipe `components`.

    Token stays local; never logged/returned. Returns ({}, {}) on empty /
    unreachable (the daily_reports write still runs).
    """
    # Pass 1 — collect the raw catalog: item metadata, variant ownership, and
    # direct (positive) variant costs.
    item_meta: Dict[str, dict] = {}      # item_id -> {name, is_composite, variant_ids, components}
    variant_owner: Dict[str, str] = {}   # variant_id -> item_id
    direct_variant_cost: Dict[str, Decimal] = {}  # variant_id -> direct positive cost

    cursor: Optional[str] = None
    pages = 0
    headers = {"Authorization": f"Bearer {token}"}

    while pages < MAX_PAGES:
        pages += 1
        params: Dict[str, Any] = {"limit": PAGE_SIZE}
        if cursor:
            params["cursor"] = cursor
        try:
            resp = httpx.get(LOYVERSE_ITEMS_ENDPOINT, params=params, headers=headers, timeout=60.0)
        except httpx.HTTPError as e:
            logger.error(f"[LOYVERSE] items API unreachable: {e}")
            return {}, {}
        if resp.status_code == 401:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail={"error": "LOYVERSE_AUTH_FAILED", "message": "The Loyverse token is invalid or expired."},
            )
        if resp.status_code >= 400:
            logger.error(f"[LOYVERSE] items API returned HTTP {resp.status_code}.")
            return {}, {}
        try:
            body = resp.json()
        except ValueError:
            logger.error("[LOYVERSE] items API returned a non-JSON response.")
            return {}, {}

        for item in body.get("items") or []:
            item_id = str(item.get("id") or "").strip()
            if not item_id:
                continue
            variant_ids: List[str] = []
            components: List[dict] = []
            if isinstance(item.get("components"), list):
                for comp in item["components"]:
                    if isinstance(comp, dict):
                        components.append(comp)
            item_meta[item_id] = {
                "name": item.get("item_name") or item.get("handle") or item_id,
                "is_composite": bool(item.get("is_composite")),
                "variant_ids": variant_ids,
                "components": components,
            }
            for v in (item.get("variants") or []):
                if not isinstance(v, dict):
                    continue
                variant_id = str(v.get("variant_id") or v.get("id") or "").strip()
                if variant_id:
                    variant_ids.append(variant_id)
                    variant_owner[variant_id] = item_id
                cost = _parse_variant_cost(v.get("cost"))
                if cost is not None and variant_id:
                    direct_variant_cost.setdefault(variant_id, cost)

        cursor = body.get("cursor")
        if not cursor:
            break

    # Pass 2 — resolve the unit cost of every item (direct first, else composite
    # recipe), recursively, with a cycle/uncosted guard (unresolvable -> None).
    resolved_item: Dict[str, Optional[Decimal]] = {}

    def resolve(item_id: str, stack: frozenset) -> Optional[Decimal]:
        if item_id in resolved_item:
            return resolved_item[item_id]
        if item_id in stack:
            return None  # cycle -> unresolvable (never fabricate)
        meta = item_meta.get(item_id)
        if meta is None:
            return None
        stack = stack | {item_id}
        # Direct cost: the first positive variant cost on this item.
        for vid in meta["variant_ids"]:
            direct = direct_variant_cost.get(vid)
            if direct is not None:
                resolved_item[item_id] = direct
                return direct
        # Composite: sum components (cost x quantity) recursively.
        if meta["is_composite"] and meta["components"]:
            total = Decimal("0.00")
            for comp in meta["components"]:
                vid = str(comp.get("variant_id") or "").strip()
                owner = variant_owner.get(vid)
                if owner is None:
                    return None  # component not in catalog -> unresolvable
                try:
                    qty = Decimal(str(comp.get("quantity")))
                except Exception:  # noqa: BLE001 - malformed/absent quantity
                    return None  # recipe malformed -> composite cost unknown
                if qty <= 0:
                    return None  # non-positive ingredient quantity -> unresolvable
                sub_cost = resolve(owner, stack)
                if sub_cost is None:
                    return None  # an uncosted ingredient -> composite cost unknown
                total += sub_cost * qty
            total = total.quantize(Decimal("0.01"))
            resolved_item[item_id] = total
            return total
        resolved_item[item_id] = None
        return None

    for item_id in item_meta:
        resolve(item_id, frozenset())

    # Pass 3 — produce the two lookup maps, then overlay composite item/variant
    # costs so a receipt line_item resolves correctly by EITHER key.
    variant_cost: Dict[str, Decimal] = dict(direct_variant_cost)
    item_cost: Dict[str, Decimal] = {}
    for item_id, cost in resolved_item.items():
        if cost is not None:
            item_cost[item_id] = cost
            # A composite item's variants carry no direct cost; backfill them so
            # a line_item keyed by variant_id still resolves the composite cost.
            for vid in item_meta[item_id]["variant_ids"]:
                if vid not in variant_cost:
                    variant_cost[vid] = cost
    return variant_cost, item_cost


def _included_item_ids(config: Optional[dict]) -> Callable[[str], bool]:
    """Return a predicate(item_id)->bool derived from ``loyverse_config.item_selection``.

    The owner's selection is a JSONB array of {item_id, include}. An item_id
    ABSENT from the list is INCLUDED by default (pull-all; toggle OFF to
    exclude). Empty / missing list -> everything is included.
    """
    excluded: set = set()
    selection = (config or {}).get("item_selection")
    if isinstance(selection, list):
        for entry in selection:
            if not isinstance(entry, dict):
                continue
            item_id = str(entry.get("item_id") or "").strip()
            if item_id and entry.get("include") is False:
                excluded.add(item_id)

    def _included(item_id: str) -> bool:
        return str(item_id or "").strip() not in excluded

    return _included


def _ensure_menu_item_costed(db, brand_id: str, raw_item_name: str, unit_cost: Decimal) -> str:
    """Return an existing menu_item id (updating its cost), else create one with cost.

    Mirrors ``menu_sales._ensure_menu_item`` but SETS/UPDATEs ``cost`` to the
    Loyverse variant cost — the source of truth for in-store COGS (the dashboard
    reads the LIVE ``menu_items.cost``, not the daily_item_sales snapshot).
    Strictly brand-scoped; never touches another tenant's menu.
    """
    norm = normalize_item_name(raw_item_name)
    name = norm or raw_item_name.strip()
    if norm:
        try:
            try:
                resp = db.table("menu_items").select("id, cost") \
                    .eq("brand_id", brand_id) \
                    .eq("normalized_name", norm) \
                    .limit(1) \
                    .execute()
            except Exception:
                # Backwards-compatible fallback for a local DB before the
                # canonical menu identity migration.
                resp = db.table("menu_items").select("id, cost") \
                    .eq("brand_id", brand_id) \
                    .eq("name", norm) \
                    .limit(1) \
                    .execute()
            if resp.data:
                mid = str(resp.data[0]["id"])
                existing = resp.data[0].get("cost")
                if existing is None or Decimal(str(existing)) != unit_cost:
                    db.table("menu_items").update({"cost": str(unit_cost)}) \
                        .eq("id", mid) \
                        .eq("brand_id", brand_id) \
                        .execute()
                return mid
        except Exception as exc:  # noqa: BLE001
            logger.error(f"[LOYVERSE] menu_items lookup failed for brand {brand_id}: {exc}")

    code = f"AUTO-{uuid.uuid4().hex[:6].upper()}"
    payload = {"brand_id": brand_id, "name": name, "menu_code": code,
               "cost": str(unit_cost), "is_active": True}
    try:
        resp = db.table("menu_items").insert(payload).execute()
        if resp.data:
            return str(resp.data[0]["id"])
    except Exception as exc:  # noqa: BLE001
        logger.error(f"[LOYVERSE] menu_items create failed for brand {brand_id!r}: {exc}")
        # A concurrent create may have won the race — re-lookup by name.
        try:
            try:
                resp = db.table("menu_items").select("id") \
                    .eq("brand_id", brand_id) \
                    .eq("normalized_name", name) \
                    .limit(1) \
                    .execute()
            except Exception:
                resp = db.table("menu_items").select("id") \
                    .eq("brand_id", brand_id) \
                    .eq("name", name) \
                    .limit(1) \
                    .execute()
            if resp.data:
                db.table("menu_items").update({"cost": str(unit_cost)}) \
                    .eq("id", str(resp.data[0]["id"])) \
                    .eq("brand_id", brand_id) \
                    .execute()
                return str(resp.data[0]["id"])
        except Exception:  # noqa: BLE001
            pass
    raise HTTPException(status_code=503, detail={"error": "DB_WRITE_FAILED",
                                                 "message": "Could not create menu_item."})


# ---------------------------------------------------------------------------
# Sync core (synchronous; run via asyncio.to_thread)
# ---------------------------------------------------------------------------
def _run_sync(
    db: Optional[Client],
    token: str,
    store_entries: List[dict],
    brand_id: str,
    variant_cost: Dict[str, Decimal],
    item_cost: Dict[str, Decimal],
    included: Callable[[str], bool],
    payment_ok: Callable[[str], bool],
) -> dict:
    """Fetch SALE receipts for each mapped store and upsert daily_reports rows.

    Also writes itemized daily_item_sales rows for line items with a real
    Loyverse variant cost. ``variant_cost``/``item_cost`` are the maps from
    ``_fetch_variant_cost_map``; ``included`` is the item-inclusion predicate
    from ``_included_item_ids``; ``payment_ok`` is the in-store payment-method
    predicate from ``_included_payment_names``; ``brand_id`` is the resolved
    brand string.
    """
    if db is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"error": "NO_DATABASE_CLIENT", "message": "Supabase client unavailable."},
        )

    total_ingested = 0
    skipped_refund = 0
    skipped_unmapped = 0
    note_31_day = False

    # key: (branch_id, receipt_date) -> aggregation bucket
    agg: Dict[Tuple[str, str], Dict[str, Any]] = {}
    store_id_to_entry = {e["store_id"]: e for e in store_entries}

    # key: (branch_id, report_date, item_name) -> itemized COGS bucket
    item_agg: Dict[Tuple[str, str, str], Dict[str, Any]] = {}

    for entry in store_entries:
        receipts, had_note = _fetch_store_receipts(token, entry["store_id"])
        note_31_day = note_31_day or had_note
        for r in receipts:
            receipt_type = str(r.get("receipt_type") or "").upper()
            if receipt_type == "REFUND":
                # Never netted into gross, never double-counted.
                skipped_refund += 1
                continue
            # ---- Payment allowlist: only in-store payment methods count ----
            # Online orders (Lineman/Grabfood/Robinhood/Shoppee E-Payment) arrive
            # via the Gmail settlement pipeline; counting them here double-counts.
            pay_names = {
                str((p or {}).get("name") or "").strip()
                for p in (r.get("payments") or [])
                if isinstance(p, dict)
            }
            if not pay_names:
                continue
            if any(not payment_ok(n) for n in pay_names):
                continue
            store_id = str(r.get("store_id") or "").strip()
            mapped = store_id_to_entry.get(store_id)
            if mapped is None:
                # Only mapped stores are ingested; never write to a guessed branch.
                skipped_unmapped += 1
                continue
            receipt_date = r.get("receipt_date")
            if not receipt_date:
                # Cannot attribute to a daily row — skip defensively.
                continue
            # report_date is DATE; Loyverse returns an ISO datetime
            # ("2020-06-23T08:34:45.025Z"). Aggregate/key on the CALENDAR day,
            # never the sale timestamp — otherwise one day's receipts fragment
            # into multiple buckets and collide/under-report on the
            # (branch_id, platform, report_date) unique key.
            report_date = str(receipt_date).split("T")[0].strip()
            if not report_date:
                continue

            branch_id = mapped["branch_id"]
            key = (branch_id, report_date)
            bucket = agg.setdefault(
                key,
                {"gross": Decimal("0.00"), "count": 0, "receipt_numbers": [], "store_names": set()},
            )

            # ---- Gross must honor the owner's item selection ----
            # The receipt's `total_money` is the WHOLE ticket (every line, incl.
            # online-only menus the owner keys purely to count portions). Summing
            # it wholesale would double-count online revenue that already arrives
            # via the Gmail settlement pipeline. So gross is the SUM of only the
            # INCLUDED line items' money. A line has gross_total_money (before any
            # taxes/discounts) and total_money; use total_money for consistency
            # with the per-ticket money elsewhere.
            included_money = Decimal("0.00")
            included_lines = 0
            for line in (r.get("line_items") or []):
                try:
                    if not isinstance(line, dict):
                        continue
                    line_item_id = str(line.get("item_id") or "").strip()
                    if not line_item_id or not included(line_item_id):
                        continue
                    money = line.get("total_money") if line.get("total_money") is not None else line.get("gross_total_money")
                    included_money += _parse_money(money, r.get("receipt_number"))
                    included_lines += 1
                except Exception:  # noqa: BLE001 - a malformed line must not break gross
                    logger.error(
                        f"[LOYVERSE] gross line skipped for receipt {r.get('receipt_number')!r}",
                        exc_info=True,
                    )
                    continue

            if included_lines > 0:
                bucket["gross"] += included_money
                bucket["count"] += 1
                bucket["receipt_numbers"].append(str(r.get("receipt_number") or ""))
                bucket["store_names"].add(mapped["store_name"])
                total_ingested += 1
            # else: receipt had NO included line items -> contributes nothing to
            # gross (and is not counted as an in-store order).

            # ---- Itemized COGS (line items) -------------------------------
            # A line with no resolvable unit cost is SKIPPED (never a fabricated
            # 0.00 costs). A per-line error is logged and skipped, not fatal to
            # the whole sync.
            for line in (r.get("line_items") or []):
                try:
                    item_id = str(line.get("item_id") or "")
                    if not item_id:
                        continue
                    if not included(item_id):
                        continue
                    # Unit cost source: the line's variant first, else the item.
                    variant_id_val = str(line.get("variant_id") or "").strip()
                    unit_cost: Optional[Decimal] = variant_cost.get(variant_id_val)
                    if unit_cost is None:
                        unit_cost = item_cost.get(item_id)
                    if unit_cost is None:
                        continue
                    item_name = str(line.get("item_name") or "").strip()
                    if not item_name:
                        continue
                    # A single item can have MULTIPLE variants with DIFFERENT costs.
                    # Collapsing them under the same raw_item_name / menu_items name
                    # would let a later variant silently overwrite an earlier one's
                    # unit_cost, under/over-stating COGS. Append the variant id as a
                    # distinct suffix so distinct-cost variants become distinct rows.
                    line_name = (
                        f"{item_name} \u2014 {variant_id_val}"
                        if variant_id_val
                        else item_name
                    )
                    try:
                        quantity = Decimal(str(line.get("quantity") or 0))
                    except Exception:  # noqa: BLE001 - malformed qty skips line
                        continue
                    if quantity <= 0:
                        continue
                    menu_item_id = _ensure_menu_item_costed(
                        db, brand_id, line_name, unit_cost
                    )
                    i_key = (branch_id, report_date, line_name)
                    ibucket = item_agg.setdefault(
                        i_key,
                        {"quantity": Decimal("0.00"), "unit_cost": None,
                         "menu_item_id": None},
                    )
                    ibucket["quantity"] += quantity
                    ibucket["unit_cost"] = unit_cost
                    ibucket["menu_item_id"] = menu_item_id
                except HTTPException as exc:
                    # menu_item create failed (503) — log, keep the sync running.
                    logger.error(
                        f"[LOYVERSE] menu_item/COGS write failed for brand {brand_id}: {exc}"
                    )
                    continue
                except Exception as exc:  # noqa: BLE001
                    logger.error(
                        f"[LOYVERSE] line COGS skipped for brand {brand_id}: {exc}",
                        exc_info=True,
                    )
                    continue

    # Build daily_reports payloads (net == gross since deductions = 0.00).
    db_payloads: List[dict] = []
    for (branch_id, report_date), bucket in agg.items():
        gross = bucket["gross"].quantize(Decimal("0.01"))
        net = gross  # in-store: no commission, deductions = 0.00
        order_count = bucket["count"]
        store_name = ", ".join(sorted(bucket["store_names"])) or None
        db_payloads.append(
            {
                "branch_id": branch_id,
                "platform": PLATFORM_LOYVERSE_INSTORE,
                "report_date": report_date,
                "shop_name_raw": store_name,
                "order_count": order_count,
                "gross_sales": str(gross),
                "deductions": "0.00",
                "net_sale": str(net),
                "details": {
                    "source": "loyverse",
                    "receipt_numbers": bucket["receipt_numbers"],
                    "order_count": order_count,
                },
            }
        )

    rows_upserted = 0
    if db_payloads:
        try:
            response = (
                db.table("daily_reports")
                .upsert(db_payloads, on_conflict="branch_id, platform, report_date")
                .execute()
            )
        except Exception as e:  # noqa: BLE001
            logger.error(f"[LOYVERSE] daily_reports upsert failed: {e}", exc_info=True)
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail={"error": "DATABASE_UPSERT_FAILED", "message": "Database write failed."},
            ) from e

        # An idle/empty upsert response when rows SHOULD have been written is a
        # real failure (default PostgREST insert config) — surface it, never fake 200.
        response_data = getattr(response, "data", None)
        if response_data is None:
            logger.error("[LOYVERSE] UPSERT returned no data for a non-empty payload.")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail={
                    "error": "UPSERT_EMPTY_RESPONSE",
                    "message": (
                        "Supabase upsert returned no data. Verify PostgREST insert "
                        "and RETURNING (Prefer: resolution=merge-duplicates) are configured."
                    ),
                },
            )
        rows_upserted = len(response_data)

    # Itemized COGS: write one daily_item_sales row per (branch, date, item).
    # A per-item error is logged and skipped — the daily_reports row above is
    # already committed and must never be rolled back by a COGS-line failure.
    items_cogs_written = 0
    for (i_branch, i_date, i_name), ib in item_agg.items():
        try:
            unit = ib["unit_cost"]
            if unit is None:
                continue  # uncosted bucket should never exist, but guard anyway
            qty = ib["quantity"].quantize(Decimal("0.01"))
            cogs = (unit * qty).quantize(Decimal("0.01"))
            _upsert_daily_item_sales(
                db,
                {
                    "brand_id": brand_id,
                    "platform": PLATFORM_LOYVERSE_INSTORE,
                    "report_date": i_date,
                    "raw_item_name": i_name,
                    "quantity": qty,
                    "branch_id": i_branch,
                    "menu_item_id": ib["menu_item_id"],
                    "unit_cost": unit,
                    "cogs": cogs,
                },
            )
            items_cogs_written += 1
        except HTTPException as exc:
            logger.error(
                f"[LOYVERSE] COGS upsert failed for item {i_name!r} "
                f"(brand {brand_id}): {exc}"
            )
            continue
        except Exception as exc:  # noqa: BLE001
            logger.error(
                f"[LOYVERSE] COGS upsert skipped for item {i_name!r} "
                f"(brand {brand_id}): {exc}",
                exc_info=True,
            )
            continue

    return {
        "success": True,
        "total_receipts_ingested": total_ingested,
        "receipts_skipped_unmapped": skipped_unmapped,
        "receipts_skipped_refund": skipped_refund,
        "rows_upserted": rows_upserted,
        "items_cogs_written": items_cogs_written,
        "note_31day_history": note_31_day,
    }


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------
@router.post("/sync", status_code=status.HTTP_200_OK)
@limiter.limit(settings.RATE_LIMIT_PER_MINUTE)
async def loyverse_sync(
    request: Request,
    user_id: str = Depends(get_authenticated_user),
    db: Optional[Client] = Depends(get_db),
) -> dict:
    """Pull the authenticated brand's Loyverse in-store SALE receipts -> daily_reports.

    JWT-authorized (ES256/JWKS). The brand_id is derived SERVER-SIDE from the
    caller's brand_users scope (the client NEVER supplies a brand_id); the
    primary brand is used. Store->branch comes ONLY from the owner's explicit
    store_branch_map, whose branch ids are cross-checked against the brand's
    branches (foreign branches -> 400 before any write).
    """
    require_write_access(db, user_id)
    scope_user_id, tenant_brand_ids = get_tenant_scope(db, user_id)
    if not scope_user_id or not tenant_brand_ids:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "error": "NO_TENANT_SCOPE",
                "message": "Authenticated user has no tenant brand scope.",
            },
        )
    requested_brand_id: Optional[str] = request.query_params.get("brand_id")
    if not requested_brand_id:
        try:
            body_json = await request.json()
            if isinstance(body_json, dict) and isinstance(body_json.get("brand_id"), str):
                requested_brand_id = body_json["brand_id"].strip() or None
        except Exception:
            requested_brand_id = None
    brand_id = resolve_brand_id_from_scope(tenant_brand_ids, requested_brand_id)
    if brand_id is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "error": "BRAND_NOT_IN_SCOPE",
                "message": "No resolvable brand in the authenticated user's tenant scope.",
            },
        )

    config = _lookup_config(db, brand_id)
    if not config or not config.get("encrypted_access_token"):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "error": "LOYVERSE_NOT_CONFIGURED",
                "message": "No Loyverse integration configuration / token for this brand.",
            },
        )

    if config.get("enabled") is False:
        logger.info(f"[LOYVERSE] sync requested for brand {brand_id} but integration is disabled.")
        return {
            "success": False,
            "message": "Loyverse ingestion is disabled for this brand.",
            "total_receipts_ingested": 0,
            "receipts_skipped_unmapped": 0,
            "receipts_skipped_refund": 0,
            "rows_upserted": 0,
            "note_31day_history": False,
        }

    # Decrypt the stored token (same AES-256-GCM the web save route used). The
    # token stays a local variable — never logged, never returned.
    try:
        token = decrypt_refresh_token(str(config["encrypted_access_token"]))
    except Exception:  # noqa: BLE001 - generic, never echo ciphertext/token
        logger.error(f"[LOYVERSE] token decryption failed for brand {brand_id}.")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "error": "LOYVERSE_TOKEN_DECRYPT_FAILED",
                "message": "Could not decrypt the stored Loyverse token.",
            },
        ) from None

    store_entries = _parse_store_map(config.get("store_branch_map"), db, brand_id)
    # Fetch the catalog once for itemized COGS. Empty maps (catalog unreachable)
    # are NOT an error — the daily_reports write below still runs and itemized
    # COGS simply yields zero rows.
    variant_cost, item_cost = _fetch_variant_cost_map(token)
    included = _included_item_ids(config)
    payment_ok = _included_payment_names(config)
    return await asyncio.to_thread(
        _run_sync, db, token, store_entries, brand_id, variant_cost, item_cost, included, payment_ok
    )


# ---------------------------------------------------------------------------
# Cron-triggered "sync ALL Loyverse brands" endpoint (no user session).
#
# A cron job has NO user JWT, so auth mirrors the Pub/Sub webhook's OIDC
# contract instead: `Authorization: Bearer <google-signed OIDC token>` whose
# audience == settings.LOYVERSE_CRON_AUDIENCE (the cron endpoint's public URL).
# Reuses the SAME `_verify_oidc_bearer` from gmail_ingestion — never
# reimplemented. FAILS CLOSED: an empty LOYVERSE_CRON_AUDIENCE rejects every
# request with 401 so an unconfigured scheduler can never trigger a sync.
#
# Data isolation: brand_id comes ONLY from each loyverse_config row (enum'd via
# the service-role client; there is no client-supplied brand id on this path),
# and `_parse_store_map` membership-checks every branch against THAT brand's
# branches before any receipt fetch or write — so a mapping can never resolve
# to a foreign branch. Per-brand failures are recorded and logged, never
# aborted, so one misconfigured brand cannot take down the whole run.
# ---------------------------------------------------------------------------
def _list_enabled_configs(db: Optional[Client]) -> List[dict]:
    """Return ALL ``loyverse_config`` rows with ``enabled = true`` (service-role).

    Bypasses RLS (no user session) via the same service-role client the rest of
    the pipeline uses. brand_id comes only from the row itself. Returns [] on
    DB down / empty table (caller fails closed on an empty enum via 503).
    """
    if db is None:
        return []
    try:
        res = (
            db.table("loyverse_config")
            .select(
                "brand_id, encrypted_access_token, enabled, store_branch_map, item_selection, payment_names"
            )
            .eq("enabled", True)
            .execute()
        )
        return [r for r in (res.data or []) if r.get("brand_id")]
    except Exception as e:  # noqa: BLE001 - fail-safe: never fabricate a brand set
        logger.error(f"[LOYVERSE-CRON] enabled-config enumeration failed: {e}", exc_info=True)
        return []


def _run_brand_sync(db: Optional[Client], config_row: dict) -> dict:
    """Sync ONE enabled brand; never raises — returns a per-brand result dict.

    Validate → skip (no token / empty map) → decrypt → parse store map →
    run the existing ``_run_sync``. Any per-brand error is caught, logged, and
    recorded as ``status=\"failed\"`` (error code only — the token or any
    decryption material is never echoed). The caller loops over all brands, so
    a single brand failure never aborts the run.
    """
    brand_id = str(config_row["brand_id"])
    result: Dict[str, Any] = {"brand_id": brand_id}

    encrypted = config_row.get("encrypted_access_token")
    store_map = config_row.get("store_branch_map") or []
    if not encrypted or not isinstance(store_map, list) or not store_map:
        # No token OR no mapped stores -> NOT an error, count as skipped.
        result["status"] = "skipped"
        result["reason"] = "missing_store_map_or_token"
        logger.info(f"[LOYVERSE-CRON] Skipping brand {brand_id} (no token or no mapped stores).")
        return result

    try:
        token = decrypt_refresh_token(str(encrypted))  # stays local; never logged/returned
    except Exception:  # noqa: BLE001 - never echo ciphertext/token
        logger.error(f"[LOYVERSE-CRON] token decryption failed for brand {brand_id}.")
        result["status"] = "failed"
        result["error"] = "LOYVERSE_TOKEN_DECRYPT_FAILED"
        return result

    try:
        store_entries = _parse_store_map(store_map, db, brand_id)
    except HTTPException:  # noqa: BLE001 - foreign branch / empty map -> per-brand failure
        logger.error(f"[LOYVERSE-CRON] store map invalid for brand {brand_id}.")
        result["status"] = "failed"
        result["error"] = "LOYVERSE_STORE_MAP_INVALID"
        return result

    try:
        variant_cost, item_cost = _fetch_variant_cost_map(token)
        included = _included_item_ids(config_row)
        payment_ok = _included_payment_names(config_row)
        summary = _run_sync(
            db, token, store_entries, brand_id, variant_cost, item_cost, included, payment_ok
        )
    except HTTPException as e:
        detail = e.detail if isinstance(e.detail, dict) else {}
        logger.error(f"[LOYVERSE-CRON] sync failed for brand {brand_id}: {detail.get('error')}")
        result["status"] = "failed"
        result["error"] = detail.get("error") or "LOYVERSE_SYNC_FAILED"
        return result
    except Exception:  # noqa: BLE001
        logger.error(f"[LOYVERSE-CRON] unexpected sync error for brand {brand_id}.", exc_info=True)
        result["status"] = "failed"
        result["error"] = "LOYVERSE_SYNC_FAILED"
        return result

    result["status"] = "synced"
    result.update(summary)
    return result


@router.post("/cron-sync", status_code=status.HTTP_200_OK)
@limiter.limit(settings.RATE_LIMIT_PER_MINUTE)
async def loyverse_cron_sync(
    request: Request,
    db: Optional[Client] = Depends(get_db),
) -> dict:
    """Cloud Scheduler-triggered sync of ALL enabled Loyverse brands.

    OIDC-authorized (the same Google-signed contract as the Gmail Pub/Sub
    webhook): requires ``Authorization: Bearer <oidc_token>`` whose audience
    equals ``settings.LOYVERSE_CRON_AUDIENCE`` (verified against Google's certs
    via the reused ``_verify_oidc_bearer``). 401 on any failure. FAILS CLOSED:
    an empty audience rejects every request with 401 CRON_OIDC_NOT_CONFIGURED.

    On success (200) or partial failure (200 with per-brand results), brand_id
    is never client-supplied — it comes from each enabled ``loyverse_config``
    row enumerated via the service-role client. A per-brand error is recorded
    in ``results`` and does not abort the remaining brands.
    """
    audience = (settings.LOYVERSE_CRON_AUDIENCE or "").strip()
    if not audience:
        # FAIL CLOSED: no OIDC audience configured -> endpoint is inert.
        logger.info("[LOYVERSE-CRON] Rejected request: LOYVERSE_CRON_AUDIENCE not configured.")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"error": "CRON_OIDC_NOT_CONFIGURED",
                    "message": "LOYVERSE_CRON_AUDIENCE is not configured; the cron sync endpoint is disabled."},
        )

    authorization = (request.headers.get("Authorization") or "").strip()
    if not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"error": "UNAUTHORIZED_CRON", "message": "Missing Authorization Bearer token."},
        )
    oidc_token = authorization[len("Bearer "):].strip()
    if not oidc_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"error": "UNAUTHORIZED_CRON", "message": "Authorization Bearer token is empty."},
        )
    _verify_oidc_bearer(oidc_token, audience)

    if db is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"error": "NO_DATABASE_CLIENT", "message": "Supabase client unavailable."},
        )

    config_rows = _list_enabled_configs(db)
    if not config_rows:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"error": "NO_ENABLED_LOYVERSE_CONFIGS",
                    "message": "No enabled Loyverse integrations found; aborting the cron run."},
        )

    results: List[dict] = []
    for row in config_rows:
        results.append(await asyncio.to_thread(_run_brand_sync, db, row))

    brands_total = len(results)
    brands_synced = sum(1 for r in results if r.get("status") == "synced")
    brands_failed = sum(1 for r in results if r.get("status") == "failed")
    brands_skipped = sum(1 for r in results if r.get("status") == "skipped")

    logger.info(
        f"[LOYVERSE-CRON] Run complete: total={brands_total} synced={brands_synced} "
        f"failed={brands_failed} skipped={brands_skipped}"
    )
    return {
        "success": brands_failed == 0,
        "brands_total": brands_total,
        "brands_synced": brands_synced,
        "brands_failed": brands_failed,
        "brands_skipped": brands_skipped,
        "results": results,
    }
