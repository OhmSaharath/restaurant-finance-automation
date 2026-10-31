from decimal import Decimal, ROUND_HALF_UP
from typing import Any, Dict, List, Optional
from uuid import UUID


def calculate_menu_item_cogs(recipe_items: List[Dict[str, Any]]) -> Decimal:
    """
    Calculate total Unit Cost of Goods Sold (COGS) for a menu item given its Recipe BOM items.
    Each item in recipe_items must have:
      - quantity: Decimal | float | int | str (e.g., in g, ml, piece)
      - cost_per_unit: Decimal | float | int | str (cost per UOM)
    """
    total_cost = Decimal("0.0000")
    for item in recipe_items:
        qty = Decimal(str(item.get("quantity", "0.0000")))
        cost_unit = Decimal(str(item.get("cost_per_unit", "0.0000")))
        line_cost = qty * cost_unit
        total_cost += line_cost
    return total_cost.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def calculate_real_net_profit(
    net_sale: Decimal,
    cogs: Decimal,
    other_expenses: Decimal = Decimal("0.00")
) -> Decimal:
    """
    Calculate Real Net Profit:
    Real Net Profit = Net Delivery Payout - COGS - Other Operational Expenses
    """
    profit = net_sale - cogs - other_expenses
    return profit.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def calculate_net_margin_percentage(
    real_net_profit: Decimal,
    gross_sales: Decimal
) -> Decimal:
    """
    Calculate Net Profit Margin Percentage:
    (Real Net Profit / Gross Sales) * 100
    """
    if gross_sales <= Decimal("0.00"):
        return Decimal("0.00")
    pct = (real_net_profit / gross_sales) * Decimal("100.00")
    return pct.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def calculate_deduction_percentage(
    deductions: Decimal,
    gross_sales: Decimal
) -> Decimal:
    """
    Calculate Platform Deduction Percentage (GP + Marketing + Promo fees):
    (Deductions / Gross Sales) * 100
    """
    if gross_sales <= Decimal("0.00"):
        return Decimal("0.00")
    pct = (deductions / gross_sales) * Decimal("100.00")
    return pct.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def estimate_sales_cogs(
    gross_sales: Decimal,
    default_cogs_ratio: Decimal = Decimal("0.32")
) -> Decimal:
    """
    Fallback estimate of COGS when itemized recipe sales are aggregated at day level.
    Default benchmark: 32% food cost of gross sales.
    """
    cogs = gross_sales * default_cogs_ratio
    return cogs.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def compute_itemized_cogs(item_sales: list) -> Decimal:
    """Sum itemized COGS = SUM(unit_cost x quantity) over costed rows.

    Rows where ``unit_cost`` is NULL contribute NOTHING (never fabricated as
    0.00) — a missing cost stays unknown, exactly per the Phase 1 contract.
    Each row is a dict with at least ``quantity`` and, when known, ``unit_cost``
    (Decimal, float, int, or str). The result is quantized to NUMERIC(12,2)
    half-up.
    """
    total = Decimal("0.0000")
    for row in item_sales:
        unit_cost = row.get("unit_cost")
        quantity = row.get("quantity")
        if unit_cost is None or quantity is None:
            # No cost -> contributes nothing. Never fabricate 0.00.
            continue
        try:
            line = Decimal(str(unit_cost)) * Decimal(str(quantity))
        except (TypeError, ValueError):
            # A malformed cost/quantity must not silently become zero — skip,
            # the invariant is that we only sum what we can trust.
            continue
        total += line
    return total.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
