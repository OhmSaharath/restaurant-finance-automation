"""Regression tests for repeated line-items in Grab exports."""

from decimal import Decimal

from app.api.v1.menu_sales import _aggregate_source_rows


def test_repeated_exact_source_rows_are_summed_without_merging_promos():
    rows = [
        {"platform": "Grab", "branch_name": "HQ", "report_date": "2026-09-19",
         "raw_item_name": "ซุปสาหร่ายวากาเมะ", "quantity": Decimal("1"), "item_gross": Decimal("35")},
        {"platform": "Grab", "branch_name": "HQ", "report_date": "2026-09-19",
         "raw_item_name": "ซุปสาหร่ายวากาเมะ", "quantity": Decimal("2"), "item_gross": Decimal("70")},
        {"platform": "Grab", "branch_name": "HQ", "report_date": "2026-09-19",
         "raw_item_name": "ซุปสาหร่ายวากาเมะ ลด 10%", "quantity": Decimal("1"), "item_gross": Decimal("30")},
    ]
    out = _aggregate_source_rows(rows)
    assert len(out) == 2
    plain = next(r for r in out if r["raw_item_name"] == "ซุปสาหร่ายวากาเมะ")
    assert plain["quantity"] == Decimal("3")
    assert plain["item_gross"] == Decimal("105")
