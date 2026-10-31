"""Menu-item merge endpoint (Phase 3): deduplicate near-duplicate menu_items.

POST /api/v1/menu-items/merge
  Merge one or more duplicate menu_items into a single primary. This is the
  "learning" path: the surviving primary keeps its cost, and every
  menu_item_platform_mappings row that pointed at a merged duplicate is
  repointed to the primary, so future uploads resolve instantly via the
  tier-0 mapping fast-path (match_item_name -> STATUS_MAPPED).

Per-merge semantics (all brand-scoped; every row is verified to belong to
brand_id before any write):
  a. Load the primary + each merge item from menu_items (eq brand_id).
  b. Effective cost = primary.cost if > 0, else the first merge item with
     cost > 0. If the primary has no cost (null/0) and an effective cost is
     found, the primary's cost is backfilled so the merged dish carries it.
  c. For each merge_id:
       - repoint daily_item_sales.menu_item_id -> primary_id and re-snapshot
         unit_cost + cogs = effective_cost * quantity (NUMERIC(12,2)
         ROUND_HALF_UP; NULL when no effective cost — never fabricated);
       - repoint menu_item_platform_mappings.menu_item_id -> primary_id,
         dropping any row that would violate UNIQUE(brand_id,platform,
         raw_item_name) — a duplicate is safe to delete because it now points
         at the same primary;
       - delete the merged menu_items row.
       - repoint recipe_boms rows to the primary; when the primary already has
         the same ingredient, keep the primary BOM row and remove only the
         duplicate row (never cascade-delete a recipe by merging).
  d. Returns { status, merged_count, primary_id, effective_cost }.

Guardrails: get_authenticated_user (JWT) + slowapi rate limit; every read/write
brand-scoped (client brand_id honored only via tenant-scope membership);
money as Decimal / NUMERIC(12,2) ROUND_HALF_UP; secrets via env-only config.
"""
import logging
from decimal import Decimal, ROUND_HALF_UP
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field

from app.core.auth import get_authenticated_user, get_tenant_scope, require_write_access, resolve_brand_id_from_scope
from app.core.config import settings
from app.core.database import get_supabase_client
from app.core.rate_limit import limiter

logger = logging.getLogger("menu_items")

router = APIRouter(prefix="/menu-items", tags=["Menu Items"])


class MenuItemsMergeRequest(BaseModel):
    brand_id: str
    primary_id: str
    merge_ids: List[str] = Field(default_factory=list, min_length=1)


class MenuItemsMergeResponse(BaseModel):
    status: str = "ok"
    merged_count: int = 0
    primary_id: Optional[str] = None
    effective_cost: Optional[Decimal] = Field(default=None, decimal_places=2, max_digits=12)


def _cost_value(cost: Any) -> Optional[Decimal]:
    """Return the cost as a positive Decimal, or None when it is missing/zero.

    A menu_items.cost of 0 means "no cost" (treated as NULL), consistent with
    the ingest path — a missing/zero cost is NEVER fabricated into a number.
    """
    if cost is None:
        return None
    try:
        d = Decimal(str(cost))
    except (TypeError, ValueError, ArithmeticError):
        return None
    if d <= Decimal("0.00"):
        return None
    return d


def _quantize2(value: Decimal) -> Decimal:
    return value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def _load_menu_item(db: Any, brand_id: str, item_id: str) -> Optional[Dict[str, Any]]:
    """Fetch one menu_items row, strictly brand-scoped. Returns None if absent."""
    try:
        resp = (
            db.table("menu_items")
            .select("id, brand_id, cost")
            .eq("id", item_id)
            .eq("brand_id", brand_id)
            .limit(1)
            .execute()
        )
        rows = resp.data or []
        return dict(rows[0]) if rows else None
    except Exception as exc:  # noqa: BLE001
        logger.error(f"[MENU ITEMS] load failed for {item_id!r} (brand {brand_id}): {exc}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"error": "DB_READ_FAILED", "message": "Could not read menu_items."},
        )


def _repoint_sales(db: Any, brand_id: str, merge_id: str, primary_id: str,
                   effective_cost: Optional[Decimal]) -> None:
    """Re-point every daily_item_sales row for merge_id to primary_id.

    Re-snapshots unit_cost + cogs = effective_cost * quantity (half-up to 2dp),
    or NULL when there is no effective cost. Rows are fetched by id so the
    quantity multiplier is read from the row itself (Supabase's update API
    cannot evaluate unit_cost * quantity in SQL).
    """
    try:
        resp = (
            db.table("daily_item_sales")
            .select("id, quantity")
            .eq("brand_id", brand_id)
            .eq("menu_item_id", merge_id)
            .execute()
        )
    except Exception as exc:  # noqa: BLE001
        logger.error(f"[MENU ITEMS] daily_item_sales read failed: {exc}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"error": "DB_READ_FAILED", "message": "Could not read daily_item_sales."},
        )
    for row in resp.data or []:
        cogs: Optional[Decimal] = None
        if effective_cost is not None:
            try:
                qty = Decimal(str(row.get("quantity") or "0"))
            except (TypeError, ValueError, ArithmeticError):
                qty = Decimal("0")
            cogs = _quantize2(effective_cost * qty)
        payload: Dict[str, Any] = {
            "menu_item_id": primary_id,
            "unit_cost": str(_quantize2(effective_cost)) if effective_cost is not None else None,
            "cogs": str(cogs) if cogs is not None else None,
        }
        try:
            db.table("daily_item_sales").update(payload).eq("id", row["id"]).execute()
        except Exception as exc:  # noqa: BLE001
            logger.error(f"[MENU ITEMS] daily_item_sales update failed for row {row['id']}: {exc}")
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail={"error": "DB_WRITE_FAILED", "message": "Could not repoint daily_item_sales."},
            )


def _repoint_mappings(db: Any, brand_id: str, merge_id: str, primary_id: str) -> None:
    """Re-point menu_item_platform_mappings rows for merge_id to primary_id.

    A mapping whose (brand_id, platform, raw_item_name) already exists (e.g. the
    primary already has it) would violate the UNIQUE constraint, so it is
    dropped — safe because it now points at the same primary. Others are
    updated in place so the persisted "learning" mapping survives the merge.
    """
    try:
        resp = (
            db.table("menu_item_platform_mappings")
            .select("id, platform, raw_item_name")
            .eq("brand_id", brand_id)
            .eq("menu_item_id", merge_id)
            .execute()
        )
    except Exception as exc:  # noqa: BLE001
        logger.error(f"[MENU ITEMS] mappings read failed: {exc}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"error": "DB_READ_FAILED", "message": "Could not read menu_item_platform_mappings."},
        )
    for row in resp.data or []:
        try:
            existing = (
                db.table("menu_item_platform_mappings")
                .select("id")
                .eq("brand_id", brand_id)
                .eq("platform", row.get("platform"))
                .eq("raw_item_name", row.get("raw_item_name"))
                .neq("id", row["id"])
                .limit(1)
                .execute()
            )
            if existing.data:
                # Duplicate (same primary already mapped) -> drop safely.
                db.table("menu_item_platform_mappings").delete().eq("id", row["id"]).execute()
            else:
                db.table("menu_item_platform_mappings").update(
                    {"menu_item_id": primary_id}
                ).eq("id", row["id"]).execute()
        except Exception as exc:  # noqa: BLE001
            logger.error(f"[MENU ITEMS] mappings repoint failed for {row['id']}: {exc}")
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail={"error": "DB_WRITE_FAILED", "message": "Could not repoint menu_item_platform_mappings."},
            )


def _repoint_boms(db: Any, merge_id: str, primary_id: str) -> None:
    """Move recipe BOM rows without losing ingredients on a merge.

    ``recipe_boms`` is unique on ``(menu_item_id, ingredient_id)``.  If the
    primary already contains an ingredient, the duplicate row is redundant;
    otherwise the existing row can be safely moved to the primary.  This keeps
    a future merge from cascading away a recipe definition.
    """
    try:
        resp = (
            db.table("recipe_boms")
            .select("id, ingredient_id")
            .eq("menu_item_id", merge_id)
            .execute()
        )
    except Exception as exc:  # noqa: BLE001
        logger.error(f"[MENU ITEMS] recipe_boms read failed: {exc}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"error": "DB_READ_FAILED", "message": "Could not read recipe_boms."},
        )
    for row in resp.data or []:
        try:
            existing = (
                db.table("recipe_boms")
                .select("id")
                .eq("menu_item_id", primary_id)
                .eq("ingredient_id", row.get("ingredient_id"))
                .limit(1)
                .execute()
            )
            if existing.data:
                db.table("recipe_boms").delete().eq("id", row["id"]).execute()
            else:
                db.table("recipe_boms").update(
                    {"menu_item_id": primary_id}
                ).eq("id", row["id"]).execute()
        except Exception as exc:  # noqa: BLE001
            logger.error(f"[MENU ITEMS] recipe_boms repoint failed for {row.get('id')}: {exc}")
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail={"error": "DB_WRITE_FAILED", "message": "Could not repoint recipe_boms."},
            )


def _delete_menu_item(db: Any, brand_id: str, merge_id: str) -> None:
    """Delete a merged menu_items row, strictly brand-scoped."""
    try:
        db.table("menu_items").delete().eq("id", merge_id).eq("brand_id", brand_id).execute()
    except Exception as exc:  # noqa: BLE001
        logger.error(f"[MENU ITEMS] delete failed for {merge_id!r}: {exc}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"error": "DB_WRITE_FAILED", "message": "Could not delete merged menu_items row."},
        )


@router.post(
    "/merge",
    response_model=MenuItemsMergeResponse,
    status_code=status.HTTP_200_OK,
    summary="Merge duplicate menu items into a single primary",
    description="Re-points sales + platform mappings to the primary and deletes "
    "the duplicates. Brand-scoped; effective cost is the primary's cost or the "
    "first duplicate with a cost (never fabricated).",
)
@limiter.limit(settings.RATE_LIMIT_PER_MINUTE)
async def merge_menu_items(
    request: Request,
    body: MenuItemsMergeRequest,
    user_id: str = Depends(get_authenticated_user),
) -> MenuItemsMergeResponse:
    db = get_supabase_client()
    if db is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"error": "DB_UNAVAILABLE", "message": "Database client unavailable."},
        )

    require_write_access(db, user_id)

    # Tenant scope is DERIVED server-side (GROUP 2): the client brand_id is a
    # SELECTOR honored ONLY when it is a member of the authenticated user's
    # brand set — never widening. Non-member / no-scope -> 403.
    _scope_user_id, tenant_brand_ids = get_tenant_scope(db, user_id)
    if not tenant_brand_ids:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "error": "NO_TENANT_BRAND",
                "message": "Authenticated user has no linked brand (brand_users).",
            },
        )
    brand_id = resolve_brand_id_from_scope(tenant_brand_ids, body.brand_id)
    if brand_id is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "error": "BRAND_NOT_IN_SCOPE",
                "message": "Requested brand_id is not a member of your tenant scope.",
            },
        )
    primary_id = body.primary_id.strip()
    merge_ids = [m.strip() for m in body.merge_ids if m and m.strip()]
    merge_ids = list(dict.fromkeys(merge_ids))  # dedupe (keeps merged_count truthful)
    if not merge_ids:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"error": "EMPTY_MERGE_LIST", "message": "merge_ids must contain at least one item."},
        )
    if primary_id in merge_ids:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"error": "PRIMARY_IN_MERGE", "message": "primary_id must not appear in merge_ids."},
        )

    # a. Load primary + merge items, verifying every row belongs to brand_id.
    primary = _load_menu_item(db, brand_id, primary_id)
    if primary is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error": "PRIMARY_NOT_FOUND",
                    "message": "Primary menu item not found for this brand."},
        )

    merge_items: List[Dict[str, Any]] = []
    for mid in merge_ids:
        row = _load_menu_item(db, brand_id, mid)
        if row is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail={"error": "MERGE_ITEM_NOT_FOUND",
                        "message": f"Menu item {mid!r} not found for this brand."},
            )
        merge_items.append(row)

    # b. Effective cost: primary's cost if > 0, else first merge item with cost.
    effective_cost = _cost_value(primary.get("cost"))
    if effective_cost is None:
        for row in merge_items:
            c = _cost_value(row.get("cost"))
            if c is not None:
                effective_cost = c
                break

    # Backfill the primary's cost when it had none and an effective cost exists.
    if effective_cost is not None and _cost_value(primary.get("cost")) is None:
        try:
            db.table("menu_items").update(
                {"cost": str(effective_cost)}
            ).eq("id", primary_id).eq("brand_id", brand_id).execute()
        except Exception as exc:  # noqa: BLE001
            logger.error(f"[MENU ITEMS] cost backfill failed for {primary_id}: {exc}")
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail={"error": "DB_WRITE_FAILED", "message": "Could not backfill primary cost."},
            )

    # c. Repoint sales + mappings, then delete each duplicate.
    for mid in merge_ids:
        _repoint_sales(db, brand_id, mid, primary_id, effective_cost)
        _repoint_mappings(db, brand_id, mid, primary_id)
        _repoint_boms(db, mid, primary_id)
        _delete_menu_item(db, brand_id, mid)

    return MenuItemsMergeResponse(
        status="ok",
        merged_count=len(merge_ids),
        primary_id=primary_id,
        effective_cost=effective_cost,
    )
