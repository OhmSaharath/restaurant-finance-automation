"""Regression tests for source-ID menu names from Loyverse imports."""

from app.ingestion.menu_item_matcher import normalize_item_name


def test_trailing_source_uuid_is_not_menu_identity():
    assert normalize_item_name("ข้าวสวย") == normalize_item_name(
        "ข้าวสวย (หน้าร้าน) — 09e87d3d-aaab-4a29-a2ca-74aa26a11f29"
    )


def test_non_uuid_dash_is_preserved():
    assert normalize_item_name("เซ็ต A — 2 ชิ้น") == "เซ็ต a — 2 ชิ้น"
