from types import SimpleNamespace

from app.ingestion.resolver import _match_authoritative_in_scope, _normalize, _stable_branch_code


class _FakeQuery:
    def __init__(self, rows):
        self.rows = rows
        self.filters = {}

    def select(self, *_args):
        return self

    def eq(self, key, value):
        self.filters[key] = value
        return self

    def execute(self):
        rows = [
            row for row in self.rows
            if all(row.get(key) == value for key, value in self.filters.items())
        ]
        return SimpleNamespace(data=rows)


class _FakeDb:
    def __init__(self, rows):
        self.rows = rows

    def table(self, _name):
        return _FakeQuery(self.rows)


def test_branch_discovery_code_is_deterministic():
    """Concurrent workers must target one branch uniqueness key."""
    assert _stable_branch_code("HQ") == _stable_branch_code("HQ")
    assert _stable_branch_code("สุทธิสาร") == _stable_branch_code("สุทธิสาร")
    assert _stable_branch_code("HQ") != _stable_branch_code("สุทธิสาร")


def test_branch_discovery_code_is_bounded_and_prefixed():
    code = _stable_branch_code("แมวอ้วน & มาม่า ข้าวไก่ทอด ลาดพร้าว 48")
    assert code.startswith("AUTO-")
    assert len(code) == len("AUTO-") + 6


def test_existing_mapping_wins_before_new_brand_resolution():
    """A replay must reuse the existing branch even if a bad mapping exists."""
    db = _FakeDb([
        {
            "branch_id": "correct-branch",
            "raw_shop_name": "น้ำเต้าหู้สี่แยกภาษีเจริญ ซอย 54",
            "created_at": "2026-09-08T09:31:51Z",
            "platform": "LINE MAN",
        },
        {
            "branch_id": "duplicate-branch",
            "raw_shop_name": "น้ำเต้าหู้สี่แยกภาษีเจริญ ซอย 54",
            "created_at": "2026-09-19T23:43:12Z",
            "platform": "LINE MAN",
        },
    ])
    assert _match_authoritative_in_scope(
        db,
        "LINE MAN",
        _normalize("น้ำเต้าหู้สี่แยกภาษีเจริญ ซอย 54"),
        {"correct-branch", "duplicate-branch"},
    ) == "correct-branch"


def test_thai_sara_am_variants_share_one_normalized_key():
    """LINE MAN's composed/decomposed น้ำ must not create a second branch."""
    assert _normalize("น้ำเต้าหู้สี่แยกภาษีเจริญ ซอย 54") == _normalize(
        "น้ําเต้าหู้สี่แยกภาษีเจริญ ซอย 54"
    )


def test_manual_hq_mapping_beats_auto_branch_mapping():
    """A corrected HQ branch must win over a provisional AUTO branch."""
    db = _FakeDb([
        {
            "branch_id": "auto-branch",
            "raw_shop_name": "น้ำเต้าหู้สี่แยกภาษีเจริญ ซอย 54",
            "created_at": "2026-09-08T09:31:51Z",
            "platform": "LINE MAN",
        },
        {
            "branch_id": "hq-branch",
            "raw_shop_name": "น้ําเต้าหู้สี่แยกภาษีเจริญ ซอย 54",
            "created_at": "2026-09-25T19:07:36Z",
            "platform": "LINE MAN",
        },
    ])
    branches = [
        {"id": "auto-branch", "branch_code": "น้ำเต้าห-AUTO"},
        {"id": "hq-branch", "branch_code": "HQ"},
    ]
    assert _match_authoritative_in_scope(
        db,
        "LINE MAN",
        _normalize("น้ำเต้าหู้สี่แยกภาษีเจริญ ซอย 54"),
        {"auto-branch", "hq-branch"},
        branches,
    ) == "hq-branch"
