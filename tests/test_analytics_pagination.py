from datetime import date

from app.api.v1.analytics import _ITEM_SALES_PAGE_SIZE, _fetch_item_sales


class _Response:
    def __init__(self, data):
        self.data = data


class _Query:
    def __init__(self, pages):
        self.pages = pages
        self.start = 0

    def select(self, *_args):
        return self

    def in_(self, *_args):
        return self

    def gte(self, *_args):
        return self

    def lte(self, *_args):
        return self

    def order(self, *_args, **_kwargs):
        return self

    def range(self, start, _end):
        self.start = start
        return self

    def execute(self):
        page = self.start // _ITEM_SALES_PAGE_SIZE
        return _Response(self.pages[page] if page < len(self.pages) else [])


class _DB:
    def __init__(self, pages):
        self.pages = pages

    def table(self, _name):
        return _Query(self.pages)


def test_fetch_item_sales_reads_every_postgrest_page():
    first = [{"id": i, "report_date": "2026-09-01"} for i in range(_ITEM_SALES_PAGE_SIZE)]
    second = [{"id": _ITEM_SALES_PAGE_SIZE, "report_date": "2026-09-02"}]

    rows = _fetch_item_sales(
        _DB([first, second]),
        ["brand-id"],
        date(2026, 9, 1),
        date(2026, 9, 2),
    )

    assert len(rows) == _ITEM_SALES_PAGE_SIZE + 1
    assert rows[-1]["id"] == _ITEM_SALES_PAGE_SIZE
