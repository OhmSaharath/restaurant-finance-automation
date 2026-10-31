# -*- coding: utf-8 -*-
"""One-time backfill: repair Grab's Thai PUA marks (U+F70A/F70B/F70E + defensive
F70C/F70D/F70F) in EXISTING rows. Idempotent pure-string rewrite — never touches
branch_id, platform, report_date, or any financial figure.

Usage:
    python3 scripts/backfill_thai_pua.py            # DRY-RUN (report only)
    python3 scripts/backfill_thai_pua.py --apply    # actually update rows
"""
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from app.ingestion.grab_parser import _fix_thai_pua
from app.core.database import get_supabase_client

APPLY = "--apply" in sys.argv


def _has_pua(s: str) -> bool:
    return any(0xE000 <= ord(c) <= 0xF8FF for c in s)


def _fix_cols(row: dict, cols: list) -> tuple:
    """Return (changed_dict_or_None, list_of_diffs)."""
    new_vals = {}
    diffs = []
    for c in cols:
        v = row.get(c)
        if isinstance(v, str) and v and _has_pua(v):
            fixed = _fix_thai_pua(v)
            if fixed != v:
                new_vals[c] = fixed
                diffs.append((c, v, fixed))
    return (new_vals or None), diffs


def scan_and_maybe_apply(table: str, cols: list, key_col: str = "id") -> None:
    select_cols = ",".join([key_col] + cols)
    res = client.table(table).select(select_cols).execute()
    rows = res.data or []
    changed = []
    for r in rows:
        new_vals, diffs = _fix_cols(r, cols)
        if new_vals:
            changed.append((r, new_vals, diffs))

    print(f"\n=== {table} ({len(rows)} rows scanned, {len(changed)} need fix) ===")

    if not changed:
        print("  nothing to fix")
        return

    # Collision check for tables with a UNIQUE on a text col (mappings).
    if table == "branch_platform_mappings":
        seen = {}
        for r, new_vals, diffs in changed:
            plat = r.get("platform")
            name = new_vals.get("raw_shop_name", r.get("raw_shop_name"))
            key = (plat, name)
            if key in seen:
                print(f"  !! COLLISION: {key!r} already targeted by id={seen[key]}; skipping id={r[key_col]}")
                continue
            seen[key] = r[key_col]

    for r, new_vals, diffs in changed:
        for c, before, after in diffs:
            print(f"  {r[key_col]}  {c}: {before!r} -> {after!r}")
        if APPLY:
            try:
                client.table(table).update(new_vals).eq(key_col, r[key_col]).execute()
            except Exception as e:
                print(f"  !! UPDATE FAILED id={r[key_col]}: {e}")

    if APPLY:
        print(f"  [APPLIED {len(changed)} row(s)]")
    else:
        print(f"  [DRY-RUN — no writes. Re-run with --apply to commit.]")


client = get_supabase_client()
if client is None:
    print("ERROR: no Supabase client (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing)")
    sys.exit(1)

print("MODE:", "APPLY" if APPLY else "DRY-RUN")

scan_and_maybe_apply("branches", ["branch_name"])
scan_and_maybe_apply("branch_platform_mappings", ["raw_shop_name"])
scan_and_maybe_apply("daily_reports", ["shop_name_raw"])
