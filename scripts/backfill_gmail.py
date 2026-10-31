# -*- coding: utf-8 -*-
"""Backfill a Gmail settlement gap for every registered google_gmail tenant.

A Pub/Sub push is ACKed (HTTP 200) as soon as the webhook returns; if the
background sync then fails under a transient TLS/network error, Google never
redelivers that historyId and the settlement is dropped. This script re-runs
the SAME `_sync_history_for_brand` pipeline from an OLD history id so it
re-fetches and idempotently re-upserts the missed Grab / LINE MAN settlement.

It is transport + cursor only: it reuses the production decryption
(`decrypt_refresh_token`), token refresh (`refresh_access_token`) and sync
(`_sync_history_for_brand`) routines verbatim — no parsing/accounting logic is
re-implemented here, so financial precision and tenant isolation semantics are
identical to the live push path.

Usage:
    python3 scripts/backfill_gmail.py [HISTORY_ID]

    HISTORY_ID  start-historyId to re-fetch from (default "1", safely older than
                any stuck email). Anything already ingested is re-upserted
                idempotently, so an over-broad window is safe.

Requires the same env the app uses (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
ENCRYPTION_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET) either exported or in
the project-root .env. Exit code is non-zero if any tenant fails.
"""
import argparse
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

try:
    from dotenv import load_dotenv

    load_dotenv(PROJECT_ROOT / ".env")
except ImportError:  # pragma: no cover - pydantic-settings vendors dotenv
    pass

from app.api.v1.gmail_ingestion import _sync_history_for_brand, _tenant_context_for_brand  # noqa: E402
from app.core.database import get_supabase_client  # noqa: E402
from app.ingestion.gmail_push import decrypt_refresh_token, refresh_access_token  # noqa: E402


def _all_gmail_integrations(db):
    """Every registered google_gmail row — one row = one tenant (never crosses scopes)."""
    try:
        res = (
            db.table("tenant_integrations")
            .select("brand_id, email_address, encrypted_refresh_token")
            .eq("provider", "google_gmail")
            .execute()
        )
    except Exception as e:  # noqa: BLE001
        print(f"ERROR: tenant_integrations lookup failed: {e}")
        sys.exit(1)
    return res.data or []


def main() -> int:
    ap = argparse.ArgumentParser(description="Backfill a Gmail settlement gap.")
    ap.add_argument(
        "history_id",
        nargs="?",
        default="1",
        help='Gmail startHistoryId to re-fetch from (default "1"). Anything already '
        "ingested is re-upserted idempotently, so an over-broad window is safe.",
    )
    args = ap.parse_args()
    start_history_id = str(args.history_id).strip() or "1"

    db = get_supabase_client()
    if db is None:
        print("ERROR: no Supabase client (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing)")
        return 1

    rows = _all_gmail_integrations(db)
    if not rows:
        print("No registered google_gmail tenant_integrations rows found.")
        return 1

    print(f"Backfilling from startHistoryId={start_history_id} across {len(rows)} tenant(s)...")

    failures = 0
    total = 0
    for row in rows:
        email = str(row.get("email_address") or "?")
        brand_id = str(row["brand_id"])
        enc = row.get("encrypted_refresh_token")
        if not enc:
            print(f"[SKIP] {email}: no encrypted_refresh_token")
            continue
        try:
            refresh_token = decrypt_refresh_token(str(enc))
            access_token = refresh_access_token(refresh_token)
            user_id, tenant_brand_ids = _tenant_context_for_brand(db, brand_id)
            processed = _sync_history_for_brand(
                db,
                brand_id,
                access_token,
                start_history_id,
                user_id=user_id,
                tenant_brand_ids=tenant_brand_ids,
            )
            total += int(processed or 0)
            print(f"[OK] email={email} brand_id={brand_id} processed={processed}")
        except Exception as e:  # noqa: BLE001
            failures += 1
            print(f"[FAIL] email={email} brand_id={brand_id}: {e}")

    print(f"DONE: total_processed={total} failures={failures}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())