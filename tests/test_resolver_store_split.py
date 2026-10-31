from app.ingestion.resolver import _split_store_branch


def test_known_store_prefix_beats_mashed_store_name():
    """A settlement shop name must reuse the known store, not create a brand."""
    brands = [
        {"id": "old", "name": "น้ำเต้าหู้"},
        {"id": "other", "name": "แมวอ้วนต้มน้ำปลา"},
    ]
    assert _split_store_branch(
        "น้ำเต้าหู้สี่แยกภาษีเจริญ ซอย 54", brands
    ) == ("น้ำเต้าหู้", "สี่แยกภาษีเจริญ ซอย 54")


def test_longest_known_store_prefix_is_deterministic():
    brands = [
        {"id": "short", "name": "น้ำเต้าหู้"},
        {"id": "long", "name": "น้ำเต้าหู้สี่แยกภาษีเจริญ ซอย 54"},
    ]
    assert _split_store_branch(
        "น้ำเต้าหู้สี่แยกภาษีเจริญ ซอย 54", brands
    ) == ("น้ำเต้าหู้สี่แยกภาษีเจริญ ซอย 54", "HQ")
