import logging
from datetime import date, timedelta
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import List, Optional, Set, Tuple
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from supabase import Client

from app.core.auth import get_authenticated_user, get_tenant_scope, resolve_brand_id_from_scope
from app.core.database import get_db
from app.core.config import settings
from app.core.rate_limit import limiter
from app.reconciliation.anomaly_detector import detect_settlement_anomalies
from app.reconciliation.cost_engine import (
    calculate_deduction_percentage,
    calculate_net_margin_percentage,
    calculate_real_net_profit,
    estimate_sales_cogs,
)
from schemas.cogs_models import (
    AnomalyAlertModel,
    BranchPNLSummary,
    FinancialSummaryResponse,
)

logger = logging.getLogger("ingestion_audit")

router = APIRouter(prefix="/analytics", tags=["Financial Analytics & P&L"])


# PostgREST applies a server-side row cap (currently 1,000 rows by default).
# Itemized sales and daily reports can exceed that cap over historical windows,
# so a single request silently returns an incomplete window. Always page these
# queries and use a deterministic order so every date contributes to the P&L.
_ITEM_SALES_PAGE_SIZE = 500
_DAILY_REPORTS_PAGE_SIZE = 500


def _fetch_daily_reports(
    db: Optional[Client],
    brand_ids: List[str],
    s_date: date,
    e_date: date,
    branch_id: Optional[UUID] = None,
    select_cols: str = "*, branches!inner(brand_id)",
) -> List[dict]:
    """Fetch all in-scope daily_reports rows with deterministic pagination."""
    if db is None or not brand_ids:
        return []

    rows: List[dict] = []
    offset = 0
    while True:
        query = (
            db.table("daily_reports")
            .select(select_cols)
            .in_("branches.brand_id", brand_ids)
            .eq("branches.is_active", True)
            .gte("report_date", str(s_date))
            .lte("report_date", str(e_date))
        )
        if branch_id:
            query = query.eq("branch_id", str(branch_id))
        query = (
            query.order("report_date", desc=False)
            .order("id", desc=False)
            .range(offset, offset + _DAILY_REPORTS_PAGE_SIZE - 1)
        )
        page = query.execute().data or []
        rows.extend(page)
        if len(page) < _DAILY_REPORTS_PAGE_SIZE:
            break
        offset += _DAILY_REPORTS_PAGE_SIZE
    return rows


def _fetch_item_sales(
    db: Optional[Client],
    brand_ids: List[str],
    s_date: date,
    e_date: date,
    branch_id: Optional[UUID] = None,
) -> List[dict]:
    """Fetch all in-scope item sales, not just PostgREST's first page."""
    if db is None or not brand_ids:
        return []

    rows: List[dict] = []
    offset = 0
    while True:
        query = (
            db.table("daily_item_sales")
            .select("id, brand_id, branch_id, platform, report_date, quantity, item_gross, menu_items(cost)")
            .in_("brand_id", brand_ids)
            .gte("report_date", str(s_date))
            .lte("report_date", str(e_date))
            .order("report_date", desc=False)
            .order("id", desc=False)
            .range(offset, offset + _ITEM_SALES_PAGE_SIZE - 1)
        )
        if branch_id:
            query = query.eq("branch_id", str(branch_id))
        page = query.execute().data or []
        rows.extend(page)
        if len(page) < _ITEM_SALES_PAGE_SIZE:
            break
        offset += _ITEM_SALES_PAGE_SIZE
    return rows


def _itemized_cogs(
    db: Optional[Client],
    brand_ids: List[str],
    s_date: date,
    e_date: date,
    branch_id: Optional[UUID] = None,
) -> Tuple[Decimal, Set[str], dict, bool]:
    """Read the REAL itemized COGS from daily_item_sales for a brand + window.

    ``brand_ids`` is the tenant scope resolved server-side (a single member when
    the client selected a brand, or the user's WHOLE brand set when no selector
    was given). When ``branch_id`` is provided, only itemized sales for that
    branch are included. Returns ``(itemized_total, covered_platforms,
    branch_itemized, has_rows)``.
    """
    itemized_total = Decimal("0.00")
    covered_platforms: Set[str] = set()
    branch_itemized: dict = {}
    has_rows = False
    if db is None or not brand_ids:
        return itemized_total, covered_platforms, branch_itemized, has_rows
    try:
        for row in _fetch_item_sales(db, brand_ids, s_date, e_date, branch_id=branch_id):
            platform = str(row.get("platform") or "")
            # LIVE cost: read the CURRENT menu_items.cost and multiply by the
            # sales quantity. The daily_item_sales.cogs snapshot column is stale
            # (NULL when costs were entered AFTER ingest), so it is NOT trusted.
            mi = row.get("menu_items")
            if isinstance(mi, list):
                mi = mi[0] if mi else None
            cost = mi.get("cost") if isinstance(mi, dict) else None
            qty = row.get("quantity")
            if cost is None or qty is None:
                continue  # unknown cost -> contributes nothing (never fabricate)
            try:
                amt = Decimal(str(cost)) * Decimal(str(qty))
            except (TypeError, ValueError, InvalidOperation):
                continue  # malformed cost/quantity must not become 0.00 silently
            # Only a successfully COSTED row marks a platform "covered" — a
            # platform whose rows are all uncosted must still get the 32% fallback.
            has_rows = True
            if platform:
                covered_platforms.add(platform)
            itemized_total += amt
            bid = row.get("branch_id")
            if bid:
                bid_s = str(bid)
                branch_itemized.setdefault(bid_s, {})
                branch_itemized[bid_s][platform] = (
                    branch_itemized[bid_s].get(platform, Decimal("0.00")) + amt
                )
    except Exception:  # noqa: BLE001 - a DB hiccup must not fabricate COGS
        return Decimal("0.00"), set(), {}, False
    return (
        itemized_total.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP),
        covered_platforms,
        branch_itemized,
        has_rows,
    )


@router.get(
    "/daily-pnl",
    status_code=status.HTTP_200_OK,
    summary="Get daily P&L breakdown (gross -> deductions -> net -> cogs -> net profit)",
    description="Per-day profit-and-loss with live itemized COGS where available and a clearly labelled historical weighted food-cost estimate for uncovered days.",
)
@limiter.limit(settings.RATE_LIMIT_PER_MINUTE)
async def get_daily_pnl(
    request: Request,
    start_date: Optional[date] = Query(None, description="Start date (default: 30 days ago)"),
    end_date: Optional[date] = Query(None, description="End date (default: today)"),
    brand_id: Optional[UUID] = Query(None, description="Filter by tenant brand UUID"),
    branch_id: Optional[UUID] = Query(None, description="Filter by a single branch (default: all branches)"),
    cogs_ratio: Decimal = Query(Decimal("0.32"), ge=Decimal("0.00"), le=Decimal("1.00")),
    user_id: str = Depends(get_authenticated_user),
    db: Optional[Client] = Depends(get_db),
):
    today = date.today()
    e_date = end_date or today
    s_date = start_date or (e_date - timedelta(days=30))
    if s_date > e_date:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": "INVALID_DATE_RANGE", "message": "start_date cannot be greater than end_date."},
        )

    _scope_user_id, tenant_brand_ids = get_tenant_scope(db, user_id)
    if not tenant_brand_ids:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "error": "NO_TENANT_BRAND",
                "message": "Authenticated user has no linked brand (brand_users).",
            },
        )
    if brand_id is not None:
        resolved = resolve_brand_id_from_scope(tenant_brand_ids, str(brand_id))
        if resolved is None:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail={
                    "error": "BRAND_NOT_IN_SCOPE",
                    "message": "Requested brand_id is not a member of your tenant scope.",
                },
            )
        scope_brand_ids = [resolved]
    else:
        scope_brand_ids = tenant_brand_ids

    daily: dict = {}
    cogs_by_date: dict = {}
    covered_dates: set = set()
    historical_cogs = Decimal("0.00")
    historical_item_gross = Decimal("0.00")
    historical_costed_dates: set = set()
    baseline_start = max(date.min, e_date - timedelta(days=90))
    if db is not None:
        try:
            report_rows = _fetch_daily_reports(
                db,
                scope_brand_ids,
                s_date,
                e_date,
                branch_id=branch_id,
                select_cols="id, report_date, platform, gross_sales, deductions, net_sale, branches!inner(brand_id)",
            )
            for r in report_rows:
                d = str(r.get("report_date"))
                row = daily.setdefault(
                    d,
                    {
                        "gross": Decimal("0.00"),
                        "deductions": Decimal("0.00"),
                        "net": Decimal("0.00"),
                        "platforms": set(),
                    },
                )
                row["gross"] += Decimal(str(r.get("gross_sales", "0")))
                row["deductions"] += Decimal(str(r.get("deductions", "0")))
                row["net"] += Decimal(str(r.get("net_sale", "0")))
                platform = str(r.get("platform") or "").strip()
                if platform:
                    row["platforms"].add(platform)

            # 2. daily_item_sales (LIVE join) -> itemized COGS per report_date.
            for r in _fetch_item_sales(
                db, scope_brand_ids, baseline_start, e_date, branch_id=branch_id
            ):
                d = str(r.get("report_date"))
                mi = r.get("menu_items")
                if isinstance(mi, list):
                    mi = mi[0] if mi else None
                cost = mi.get("cost") if isinstance(mi, dict) else None
                qty = r.get("quantity")
                if cost is None or qty is None:
                    continue
                try:
                    amt = Decimal(str(cost)) * Decimal(str(qty))
                except (TypeError, ValueError, InvalidOperation):
                    continue
                if s_date <= date.fromisoformat(d) <= e_date if len(d) == 10 else True:
                    covered_dates.add(d)
                    cogs_by_date[d] = cogs_by_date.get(d, Decimal("0.00")) + amt
                historical_costed_dates.add(d)
                historical_cogs += amt
                try:
                    item_gross = Decimal(str(r.get("item_gross")))
                    if item_gross > Decimal("0.00"):
                        historical_item_gross += item_gross
                except (TypeError, ValueError, InvalidOperation):
                    pass
        except HTTPException:
            raise
        except Exception as exc:
            logger.error(f"[ANALYTICS ERROR] get_daily_pnl database query failed: {exc}", exc_info=True)
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail={
                    "error": "ANALYTICS_DB_UNAVAILABLE",
                    "message": "Database query failed while loading daily P&L.",
                },
            ) from exc

    historical_ratio: Optional[Decimal] = None
    if len(historical_costed_dates) >= 3 and historical_item_gross > Decimal("0.00"):
        candidate = historical_cogs / historical_item_gross
        if Decimal("0.05") <= candidate <= Decimal("0.80"):
            historical_ratio = candidate.quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)

    result = []
    for d in sorted(daily.keys()):
        gross = daily[d]["gross"]
        ded = daily[d]["deductions"]
        net = daily[d]["net"]
        is_itemized = d in covered_dates
        if is_itemized:
            cogs = cogs_by_date.get(d, Decimal("0.00"))
            cogs_source = "itemized"
        elif historical_ratio is not None:
            cogs = estimate_sales_cogs(gross, default_cogs_ratio=historical_ratio)
            cogs_source = "statistical_estimated"
        else:
            cogs = estimate_sales_cogs(gross, default_cogs_ratio=cogs_ratio)
            cogs_source = "benchmark_estimated"
        cogs = cogs.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        profit = calculate_real_net_profit(net, cogs)
        platforms = daily[d].get("platforms", set())
        complete_platforms = "Grab" in platforms and "LINE MAN" in platforms
        result.append(
            {
                "date": d,
                "gross_sales": str(gross.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)),
                "deductions": str(ded.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)),
                "net_sale": str(net.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)),
                "cogs": str(cogs),
                "net_profit": str(profit),
                "cogs_source": cogs_source,
                "cogs_ratio": str(
                    (historical_ratio if historical_ratio is not None else cogs_ratio).quantize(
                        Decimal("0.0001"), rounding=ROUND_HALF_UP
                    )
                ),
                "platform_coverage": "complete" if complete_platforms else "partial",
            }
        )

    return {
        "start_date": str(s_date),
        "end_date": str(e_date),
        "brand_id": str(brand_id) if brand_id else None,
        "food_cost_ratio": str(
            (historical_ratio if historical_ratio is not None else cogs_ratio).quantize(
                Decimal("0.0001"), rounding=ROUND_HALF_UP
            )
        ),
        "food_cost_ratio_source": "historical_weighted" if historical_ratio is not None else "benchmark",
        "food_cost_sample_days": len(historical_costed_dates),
        "complete_platform_days": sum(
            1
            for row in daily.values()
            if "Grab" in row.get("platforms", set()) and "LINE MAN" in row.get("platforms", set())
        ),
        "daily": result,
    }


@router.get(
    "/pnl",
    response_model=FinancialSummaryResponse,
    status_code=status.HTTP_200_OK,
    summary="Get Multi-Branch P&L and Financial Reconciliation Summary",
    description="Retrieve consolidated Profit & Loss summary across branches, including Gross Sales, Deductions, Net Payout, COGS, Real Net Profit, and platform fee anomaly alerts."
)
@limiter.limit(settings.RATE_LIMIT_PER_MINUTE)
async def get_pnl_summary(
    request: Request,
    start_date: Optional[date] = Query(None, description="Start date for reporting period (default: 30 days ago)"),
    end_date: Optional[date] = Query(None, description="End date for reporting period (default: today)"),
    branch_id: Optional[UUID] = Query(None, description="Filter by single branch UUID"),
    brand_id: Optional[UUID] = Query(None, description="Filter by tenant brand UUID"),
    cogs_ratio: Decimal = Query(Decimal("0.32"), ge=Decimal("0.00"), le=Decimal("1.00"), description="Estimated benchmark food cost ratio of gross sales (default: 0.32 / 32%)"),
    user_id: str = Depends(get_authenticated_user),
    db: Optional[Client] = Depends(get_db)
) -> FinancialSummaryResponse:
    today = date.today()
    e_date = end_date or today
    s_date = start_date or (e_date - timedelta(days=30))

    if s_date > e_date:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": "INVALID_DATE_RANGE", "message": "start_date cannot be greater than end_date."}
        )

    scope_user_id, tenant_brand_ids = get_tenant_scope(db, user_id)
    if not tenant_brand_ids:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "error": "NO_TENANT_BRAND",
                "message": "Authenticated user has no linked brand (brand_users).",
            },
        )
    if brand_id is not None:
        resolved_brand = resolve_brand_id_from_scope(tenant_brand_ids, str(brand_id))
        if resolved_brand is None:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail={
                    "error": "BRAND_NOT_IN_SCOPE",
                    "message": "Requested brand_id is not a member of your tenant scope.",
                },
            )
        scope_brand_ids = [resolved_brand]
        brand_id = UUID(resolved_brand)
    else:
        scope_brand_ids = tenant_brand_ids

    reports_data: List[dict] = []
    branches_map: dict = {}

    if db is not None:
        try:
            b_query = (
                db.table("branches")
                .select("id, branch_name, brand_id")
                .in_("brand_id", scope_brand_ids)
            )
            if branch_id:
                b_query = b_query.eq("id", str(branch_id))
            b_res = b_query.execute()
            if b_res.data:
                for b in b_res.data:
                    branches_map[b["id"]] = b.get("branch_name", "Branch")

            reports_data = _fetch_daily_reports(
                db,
                scope_brand_ids,
                s_date,
                e_date,
                branch_id=branch_id,
                select_cols="*, branches!inner(brand_id)",
            )
        except HTTPException:
            raise
        except Exception as exc:
            logger.error(f"[ANALYTICS ERROR] get_pnl_summary database query failed: {exc}", exc_info=True)
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail={
                    "error": "ANALYTICS_DB_UNAVAILABLE",
                    "message": "Database query failed while loading P&L summary.",
                },
            ) from exc

    total_orders = 0
    total_gross = Decimal("0.00")
    total_deductions = Decimal("0.00")
    total_net = Decimal("0.00")
    total_cogs = Decimal("0.00")

    branch_aggregates: dict = {}
    gross_by_platform: dict = {}
    all_anomalies: List[AnomalyAlertModel] = []

    for r in reports_data:
        b_id_str = str(r.get("branch_id"))
        if branch_id and b_id_str != str(branch_id):
            continue

        orders = int(r.get("order_count", 0))
        gross = Decimal(str(r.get("gross_sales", "0.00")))
        deductions = Decimal(str(r.get("deductions", "0.00")))
        net = Decimal(str(r.get("net_sale", "0.00")))
        details = r.get("details", {})
        platform = str(r.get("platform") or "")

        total_orders += orders
        total_gross += gross
        total_deductions += deductions
        total_net += net

        if platform:
            gross_by_platform[platform] = (
                gross_by_platform.get(platform, Decimal("0.00")) + gross
            )

        anomalies = detect_settlement_anomalies(gross, deductions, net, details)
        all_anomalies.extend(anomalies)

        if b_id_str not in branch_aggregates:
            branch_aggregates[b_id_str] = {
                "branch_id": UUID(b_id_str) if b_id_str and b_id_str != "None" else UUID("00000000-0000-0000-0000-000000000000"),
                "branch_name": branches_map.get(b_id_str, f"Branch {b_id_str[:8]}"),
                "order_count": 0,
                "gross_sales": Decimal("0.00"),
                "deductions": Decimal("0.00"),
                "net_sale": Decimal("0.00"),
                "platform_gross": {},
            }
        b_agg = branch_aggregates[b_id_str]
        b_agg["order_count"] += orders
        b_agg["gross_sales"] += gross
        b_agg["deductions"] += deductions
        b_agg["net_sale"] += net
        if platform:
            b_agg["platform_gross"][platform] = (
                b_agg["platform_gross"].get(platform, Decimal("0.00")) + gross
            )

    itemized_total, covered_platforms, branch_itemized, has_itemized_rows = _itemized_cogs(
        db, scope_brand_ids, s_date, e_date, branch_id=branch_id
    )

    if has_itemized_rows:
        uncovered_gross = Decimal("0.00")
        for plat, plat_gross in gross_by_platform.items():
            if plat not in covered_platforms:
                uncovered_gross += plat_gross
        total_cogs = itemized_total + estimate_sales_cogs(
            uncovered_gross, default_cogs_ratio=cogs_ratio
        )
    else:
        total_cogs = estimate_sales_cogs(total_gross, default_cogs_ratio=cogs_ratio)
    total_cogs = total_cogs.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)

    branches_summary_list: List[BranchPNLSummary] = []
    for b_id_str, b_agg in branch_aggregates.items():
        b_gross = b_agg["gross_sales"].quantize(Decimal("0.01"))
        b_deductions = b_agg["deductions"].quantize(Decimal("0.01"))
        b_net = b_agg["net_sale"].quantize(Decimal("0.01"))
        if has_itemized_rows:
            b_plat_map = branch_itemized.get(b_id_str, {})
            b_itemized = sum(b_plat_map.values(), Decimal("0.00"))
            b_covered = set(b_plat_map.keys())
            b_uncovered_gross = Decimal("0.00")
            for plat, plat_gross in b_agg["platform_gross"].items():
                if plat not in b_covered:
                    b_uncovered_gross += plat_gross
            b_cogs = b_itemized + estimate_sales_cogs(
                b_uncovered_gross, default_cogs_ratio=cogs_ratio
            )
            b_cogs = b_cogs.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        else:
            b_cogs = estimate_sales_cogs(b_gross, default_cogs_ratio=cogs_ratio)
        b_profit = calculate_real_net_profit(b_net, b_cogs)
        b_margin = calculate_net_margin_percentage(b_profit, b_gross)
        b_gp_pct = calculate_deduction_percentage(b_deductions, b_gross)

        branches_summary_list.append(
            BranchPNLSummary(
                branch_id=b_agg["branch_id"],
                branch_name=b_agg["branch_name"],
                order_count=b_agg["order_count"],
                gross_sales=b_gross,
                deductions=b_deductions,
                net_sale=b_net,
                total_cogs=b_cogs,
                real_net_profit=b_profit,
                net_margin_pct=b_margin,
                gp_deduction_pct=b_gp_pct,
            )
        )

    total_gross = total_gross.quantize(Decimal("0.01"))
    total_deductions = total_deductions.quantize(Decimal("0.01"))
    total_net = total_net.quantize(Decimal("0.01"))
    real_net_profit = calculate_real_net_profit(total_net, total_cogs)
    net_margin_pct = calculate_net_margin_percentage(real_net_profit, total_gross)

    return FinancialSummaryResponse(
        start_date=s_date,
        end_date=e_date,
        brand_id=brand_id,
        total_branches=len(branches_summary_list),
        total_orders=total_orders,
        gross_sales=total_gross,
        deductions=total_deductions,
        net_sale=total_net,
        total_cogs=total_cogs,
        other_expenses=Decimal("0.00"),
        real_net_profit=real_net_profit,
        net_margin_pct=net_margin_pct,
        branches_summary=branches_summary_list,
        anomalies=all_anomalies
    )
