import asyncio
import unittest
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID

from fastapi import HTTPException, Request

from app.api.v1.analytics import _itemized_cogs, get_daily_pnl, get_pnl_summary
from app.api.v1.gmail_ingestion import _try_claim_sync
from app.api.v1.loyverse import _list_enabled_configs, loyverse_sync
from app.main import generic_exception_handler


class _MockResponse:
    def __init__(self, data):
        self.data = data


class TestBugfixesSuperpowers(unittest.TestCase):
    def test_1_loyverse_list_enabled_configs_selects_payment_names(self):
        """Bug 1: _list_enabled_configs must select payment_names for cron-sync parity."""
        selected_cols = []

        class _Table:
            def select(self, cols):
                selected_cols.append(cols)
                return self

            def eq(self, *_args):
                return self

            def execute(self):
                return _MockResponse([{"brand_id": "b1", "payment_names": ["Cash"]}])

        class _DB:
            def table(self, _name):
                return _Table()

        rows = _list_enabled_configs(_DB())
        self.assertEqual(len(rows), 1)
        self.assertTrue(
            any("payment_names" in c for c in selected_cols),
            f"Expected 'payment_names' in select columns, got {selected_cols}",
        )

    def test_2_itemized_cogs_accepts_and_forwards_branch_id(self):
        """Bug 2a: _itemized_cogs must accept branch_id and filter _fetch_item_sales."""
        branch_uuid = UUID("11111111-1111-1111-1111-111111111111")
        with patch("app.api.v1.analytics._fetch_item_sales", return_value=[]) as mock_fetch:
            _itemized_cogs(
                MagicMock(),
                ["brand-1"],
                date(2026, 9, 1),
                date(2026, 9, 2),
                branch_id=branch_uuid,
            )
            mock_fetch.assert_called_once()
            _, kwargs = mock_fetch.call_args
            pos_args = mock_fetch.call_args[0]
            passed_branch = kwargs.get("branch_id") if "branch_id" in kwargs else (pos_args[4] if len(pos_args) > 4 else None)
            self.assertEqual(passed_branch, branch_uuid)

    def test_3_pnl_summary_per_branch_cogs_includes_all_uncovered_platforms(self):
        """Bug 2b: When LOYVERSE_INSTORE is itemized, uncovered Grab + LINE MAN must both get fallback COGS per branch."""
        brand_id = "22222222-2222-2222-2222-222222222222"
        branch_id = "11111111-1111-1111-1111-111111111111"

        reports = [
            {
                "id": 1,
                "branch_id": branch_id,
                "platform": "LOYVERSE_INSTORE",
                "report_date": "2026-09-01",
                "order_count": 5,
                "gross_sales": "1000.00",
                "deductions": "0.00",
                "net_sale": "1000.00",
                "details": {},
            },
            {
                "id": 2,
                "branch_id": branch_id,
                "platform": "Grab",
                "report_date": "2026-09-01",
                "order_count": 5,
                "gross_sales": "1000.00",
                "deductions": "300.00",
                "net_sale": "700.00",
                "details": {},
            },
        ]

        itemized_ret = (
            Decimal("400.00"),
            {"LOYVERSE_INSTORE"},
            {branch_id: {"LOYVERSE_INSTORE": Decimal("400.00")}},
            True,
        )

        class _Query:
            def __init__(self, table_name):
                self.table_name = table_name

            def select(self, *_args):
                return self

            def in_(self, *_args):
                return self

            def eq(self, *_args):
                return self

            def gte(self, *_args):
                return self

            def lte(self, *_args):
                return self

            def order(self, *_args, **_kwargs):
                return self

            def range(self, start, *_args):
                if start > 0:
                    self._empty = True
                return self

            def execute(self):
                if getattr(self, "_empty", False):
                    return _MockResponse([])
                if self.table_name == "branches":
                    return _MockResponse([{"id": branch_id, "branch_name": "HQ", "brand_id": brand_id}])
                if self.table_name == "daily_reports":
                    return _MockResponse(reports)
                return _MockResponse([])

        class _DB:
            def table(self, name):
                return _Query(name)

        req = MagicMock(spec=Request)
        with patch("app.api.v1.analytics.get_tenant_scope", return_value=("user-1", [brand_id])), \
             patch("app.api.v1.analytics._itemized_cogs", return_value=itemized_ret):
            res = asyncio.run(
                get_pnl_summary(
                    request=req,
                    start_date=date(2026, 9, 1),
                    end_date=date(2026, 9, 1),
                    branch_id=None,
                    brand_id=UUID(brand_id),
                    cogs_ratio=Decimal("0.32"),
                    user_id="user-1",
                    db=_DB(),
                )
            )
        self.assertEqual(res.total_cogs, Decimal("720.00"))
        self.assertEqual(len(res.branches_summary), 1)
        self.assertEqual(
            res.branches_summary[0].total_cogs,
            Decimal("720.00"),
            f"Expected branch total_cogs 720.00 to match overall total_cogs, got {res.branches_summary[0].total_cogs}",
        )

    def test_4_analytics_raises_503_on_db_error_instead_of_silent_zero(self):
        """Code Standard 1: Database failures in get_daily_pnl must not silently return 200 OK with empty data."""
        class _BrokenDB:
            def table(self, _name):
                raise RuntimeError("Supabase connection reset")

        req = MagicMock(spec=Request)
        with patch("app.api.v1.analytics.get_tenant_scope", return_value=("user-1", ["brand-1"])):
            with self.assertRaises(HTTPException) as ctx:
                asyncio.run(
                    get_daily_pnl(
                        request=req,
                        start_date=date(2026, 9, 1),
                        end_date=date(2026, 9, 2),
                        brand_id=None,
                        branch_id=None,
                        cogs_ratio=Decimal("0.32"),
                        user_id="user-1",
                        db=_BrokenDB(),
                    )
                )
            self.assertEqual(ctx.exception.status_code, 503)

    def test_5_try_claim_sync_recovers_stale_syncing_lock(self):
        """Bug 5: _try_claim_sync must recover a lock stuck in 'syncing' for > 15 minutes."""
        stale_ts = (datetime.now(timezone.utc) - timedelta(minutes=30)).isoformat()

        class _StaleLockTable:
            def __init__(self):
                self.mode = None
                self.neq_called = False
                self.reclaimed = False

            def update(self, _payload):
                self.mode = "update"
                return self

            def select(self, *_args):
                if self.mode is None:
                    self.mode = "select"
                return self

            def eq(self, col, val):
                if col == "sync_status" and val == "syncing":
                    self.reclaimed = True
                return self

            def neq(self, *_args):
                self.neq_called = True
                return self

            def lt(self, *_args):
                self.reclaimed = True
                return self

            def limit(self, *_args):
                return self

            def execute(self):
                if self.mode == "update" and self.neq_called:
                    return _MockResponse([])
                if self.mode == "select":
                    return _MockResponse([{"id": "row-1", "sync_status": "syncing", "last_synced_at": stale_ts}])
                if self.mode == "update" and self.reclaimed:
                    return _MockResponse([{"id": "row-1"}])
                return _MockResponse([])

        class _DB:
            def table(self, _name):
                return _StaleLockTable()

        claimed = _try_claim_sync(_DB(), "shop@example.com")
        self.assertTrue(claimed, "Expected stale 'syncing' lock (>15m old) to be reclaimed")

    def test_6_generic_exception_handler_does_not_leak_internal_details(self):
        """Code Standard 2: generic_exception_handler must not expose raw exception text in HTTP 500."""
        req = MagicMock(spec=Request)
        secret_exc = RuntimeError("FATAL: password authentication failed for user postgres at 10.0.0.5")
        resp = asyncio.run(generic_exception_handler(req, secret_exc))
        self.assertEqual(resp.status_code, 500)
        body_text = resp.body.decode("utf-8")
        self.assertNotIn("10.0.0.5", body_text)
        self.assertNotIn("password authentication failed", body_text)

    def test_7_loyverse_sync_honors_multi_brand_selector_in_body(self):
        """Bug 3: loyverse_sync must resolve brand_id from request body when user belongs to multiple brands."""
        req = MagicMock(spec=Request)
        req.query_params = {}
        req.json = AsyncMock(return_value={"brand_id": "brand-second"})

        looked_up_brands = []

        def fake_lookup(_db, bid):
            looked_up_brands.append(bid)
            return {
                "brand_id": bid,
                "encrypted_access_token": "enc-tok",
                "enabled": False,
                "store_branch_map": [],
            }

        with patch("app.api.v1.loyverse.require_write_access"), \
             patch("app.api.v1.loyverse.get_tenant_scope", return_value=("user-1", ["brand-first", "brand-second"])), \
             patch("app.api.v1.loyverse._lookup_config", side_effect=fake_lookup):
            res = asyncio.run(loyverse_sync(request=req, user_id="user-1", db=MagicMock()))
            self.assertEqual(looked_up_brands, ["brand-second"])
            self.assertFalse(res["success"])


if __name__ == "__main__":
    unittest.main()
