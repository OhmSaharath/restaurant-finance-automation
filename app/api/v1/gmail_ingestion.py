"""Native Gmail ingestion endpoints (replaces Make.com webhooks).

These are the FastAPI targets the Next.js sync worker forwards scanned
attachment files to. Each endpoint is platform-specific (one parser contract per
route), enforces the shared financial guardrail (net = gross - deductions,
NUMERIC(12,2)) via the ingestion core, and performs an idempotent upsert against
daily_reports. Original email metadata is preserved so the daily_reports.details
JSONB payload stays auditable end-to-end.
"""
import asyncio
import hmac
import io
import json
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from uuid import UUID

import jwt
from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, Request, UploadFile, status
from jwt import PyJWKClient
from pydantic import BaseModel, Field, ValidationError
from supabase import Client

from app.api.v1.ingestion import IngestionResponse, _process_and_upsert_records
from app.core.auth import get_authenticated_user, get_tenant_scope, require_write_access, resolve_brand_id_from_scope
from app.core.config import settings
from app.core.database import get_db
from app.core.rate_limit import limiter
from app.ingestion.base import SettlementParsingError
from app.ingestion.grab_parser import GrabParser, parse_grab_pdf
from app.ingestion.gmail_push import (
    base64_decode_pubsub_message,
    classify_sender,
    decrypt_refresh_token,
    get_attachment,
    get_message,
    gmail_watch,
    list_history,
    refresh_access_token,
    SETTLEMENT_EXCLUDE_MARKERS,
)
from app.ingestion.lineman_parser import LineManParser
from schemas.models import GmailHistoryNotification, PlatformEnum, PubSubPushNotification

logger = logging.getLogger("ingestion_audit")

router = APIRouter(prefix="/ingestion", tags=["Gmail Settlement Ingestion"])


async def read_upload(file: UploadFile) -> bytes:
    content = await file.read()
    if not content:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": "EMPTY_ATTACHMENT", "message": "Settlement attachment is empty."},
        )
    return content


def _to_csv_bytes(content: bytes, filename: str) -> bytes:
    """Convert Excel (.xlsx/.xls) attachment to CSV in-memory for the CSV parser."""
    import pandas as pd

    df = pd.read_excel(io.BytesIO(content))
    if df.empty:
        raise SettlementParsingError("Excel settlement contains no rows.")
    return df.to_csv(index=False).encode("utf-8-sig")


def _parse_platform(
    platform: PlatformEnum,
    content: bytes,
    filename: str,
    sender: str,
    subject: str,
    brand_id: Optional[str] = None,
):
    """Parse the attachment into normalized records with email provenance attached."""
    if platform == PlatformEnum.GRAB:
        if filename.lower().endswith(".pdf") or content[:5].lstrip().startswith(b"%PDF"):
            records = parse_grab_pdf(content, filename)
        else:
            records = GrabParser().parse(content, filename=filename)
    else:  # LINE MAN
        fn = (filename or "").lower()
        if fn.endswith((".xlsx", ".xls")):
            content = _to_csv_bytes(content, filename)
        records = LineManParser().parse(content, filename=filename)

    # Stamp email provenance + tenant brand id so every row's JSONB `details`
    # (persisted into daily_reports.details) is scoped and auditable end-to-end.
    for r in records:
        meta = {"sender": sender, "subject": subject}
        if brand_id:
            meta["brand_id"] = brand_id
        r.setdefault("details", {})["source_email"] = meta
    return records


def _tenant_context_for_brand(
    db: Optional[Client], brand_id: Optional[str]
) -> tuple:
    """Derive (user_id, tenant_brand_ids) from a single resolved brand_id.

    The tenant user is the owner of that brand (role='owner', else first
    row), and the brand SET is that user's FULL brand set. Everything is gated
    on the resolved brand_id -> its owner user -> that user's own brands, so it
    can never cross tenant boundaries. Returns (None, []) on any error
    (fail-safe, never fabricates) — mirroring the resolver's behavior of
    falling back to the explicit brand only.
    """
    if db is None or not brand_id:
        return None, []
    try:
        rows = (
            db.table("brand_users")
            .select("user_id, role")
            .eq("brand_id", str(brand_id))
            .execute()
            .data
            or []
        )
    except Exception as e:
        logger.error(f"[GMAIL PUSH ERROR] brand_users lookup for brand_id={brand_id} failed: {e}")
        return None, []
    if not rows:
        return None, []

    user_id = None
    for r in rows:
        if (r.get("role") or "") == "owner":
            user_id = str(r["user_id"])
            break
    if user_id is None:
        user_id = str(rows[0]["user_id"])

    try:
        brand_rows = (
            db.table("brand_users")
            .select("brand_id")
            .eq("user_id", user_id)
            .execute()
            .data
            or []
        )
    except Exception as e:
        logger.error(f"[GMAIL PUSH ERROR] brand set lookup for user_id={user_id} failed: {e}")
        return None, []
    brand_ids = [str(b["brand_id"]) for b in brand_rows if b.get("brand_id")]
    return user_id, brand_ids


def _finalize(
    records: list,
    db: Optional[Client],
    filename: str = "",
    brand_id: Optional[str] = None,
    platform: Optional[str] = None,
    user_id: Optional[str] = None,
    tenant_brand_ids: Optional[List[str]] = None,
) -> IngestionResponse:
    if not records:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"error": "NO_RECORDS_FOUND", "message": "No valid settlement records extracted from attachment."},
        )
    # Tenant context originates from the authenticated caller's JWT sub (the
    # scope is derived server-side via get_tenant_scope); brand_id is the primary
    # brand of that scope. Client-supplied user_id / tenant_brand_ids are never
    # honored (matches the push path, which derives scope from the emailAddress
    # -> tenant_integrations row).
    if not user_id or not tenant_brand_ids:
        user_id, tenant_brand_ids = get_tenant_scope(db, user_id)
    if not user_id or not tenant_brand_ids:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"error": "NO_TENANT_SCOPE", "message": "Authenticated user has no tenant brand scope."},
        )
    if not brand_id:
        brand_id = resolve_brand_id_from_scope(tenant_brand_ids, brand_id)
    logger.info(
        f"[GMAIL INGEST DEBUG] Endpoint ingest: filename={filename!r} platform={platform} "
        f"brand_id={brand_id} user_id={user_id} rows_parsed={len(records)}"
    )
    return _process_and_upsert_records(
        records,
        db,
        brand_id=brand_id,
        platform=platform,
        source_label=f"gmail:{platform or '?'}",
        tenant_brand_ids=tenant_brand_ids,
        user_id=user_id,
    )


@router.post(
    "/grab",
    response_model=IngestionResponse,
    status_code=status.HTTP_200_OK,
    summary="Ingest Grab/GrabFood settlement attachment (PDF or CSV)",
)
async def ingest_grab(
    request: Request,
    file: UploadFile = File(..., description="Grab settlement statement (PDF) or CSV export"),
    sender: Optional[str] = Form(None),
    subject: Optional[str] = Form(None),
    brand_id: Optional[str] = Form(None),
    user_id: str = Depends(get_authenticated_user),
    db: Optional[Client] = Depends(get_db),
) -> IngestionResponse:
    require_write_access(db, user_id)
    content = await read_upload(file)
    scope_user_id, tenant_brand_ids = get_tenant_scope(db, user_id)
    if not scope_user_id or not tenant_brand_ids:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"error": "NO_TENANT_SCOPE", "message": "Authenticated user has no tenant brand scope."},
        )
    brand_id = resolve_brand_id_from_scope(tenant_brand_ids, brand_id)
    if brand_id is None:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail={"error": "BRAND_NOT_IN_SCOPE", "message": "Requested brand_id is not part of the authenticated user's tenant scope."},
        )
    try:
        records = _parse_platform(PlatformEnum.GRAB, content, file.filename or "", sender or "", subject or "", brand_id)
    except SettlementParsingError as spe:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail={"error": "PARSER_ERROR", "message": spe.message})
    except Exception as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail={"error": "PARSE_FAILED", "message": str(e)})
    return _finalize(
        records, db,
        filename=file.filename or "",
        brand_id=brand_id, platform="grab",
        user_id=scope_user_id, tenant_brand_ids=tenant_brand_ids,
    )


@router.post(
    "/lineman",
    response_model=IngestionResponse,
    status_code=status.HTTP_200_OK,
    summary="Ingest LINE MAN daily settlement attachment (CSV or Excel)",
)
async def ingest_lineman(
    request: Request,
    file: UploadFile = File(..., description="LINE MAN daily settlement CSV/Excel export"),
    sender: Optional[str] = Form(None),
    subject: Optional[str] = Form(None),
    brand_id: Optional[str] = Form(None),
    user_id: str = Depends(get_authenticated_user),
    db: Optional[Client] = Depends(get_db),
) -> IngestionResponse:
    require_write_access(db, user_id)
    content = await read_upload(file)
    scope_user_id, tenant_brand_ids = get_tenant_scope(db, user_id)
    if not scope_user_id or not tenant_brand_ids:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"error": "NO_TENANT_SCOPE", "message": "Authenticated user has no tenant brand scope."},
        )
    brand_id = resolve_brand_id_from_scope(tenant_brand_ids, brand_id)
    if brand_id is None:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail={"error": "BRAND_NOT_IN_SCOPE", "message": "Requested brand_id is not part of the authenticated user's tenant scope."},
        )
    try:
        records = _parse_platform(PlatformEnum.LINE_MAN, content, file.filename or "", sender or "", subject or "", brand_id)
    except SettlementParsingError as spe:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail={"error": "PARSER_ERROR", "message": spe.message})
    except Exception as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail={"error": "PARSE_FAILED", "message": str(e)})
    return _finalize(
        records, db,
        filename=file.filename or "",
        brand_id=brand_id, platform="lineman",
        user_id=scope_user_id, tenant_brand_ids=tenant_brand_ids,
    )


# =============================================================================
# Google Gmail Pub/Sub push webhook + watch() — replaces the Make.com pipeline.
#
# Data isolation: the tenant brand_id is ALWAYS derived from the registered
# emailAddress -> tenant_integrations row. An emailAddress with no matching
# integration is logged and dropped; nothing is ever processed cross-tenant.
# =============================================================================

class WatchRequest(BaseModel):
    """Body for (re)establishing a brand's Google Gmail push watch."""
    brand_id: UUID = Field(..., description="Tenant brand UUID whose google_gmail watch to (re)establish")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _lookup_integration(
    db: Optional[Client],
    *,
    email_address: Optional[str] = None,
    brand_id: Optional[str] = None,
) -> Optional[dict]:
    """Return the single registered ``google_gmail`` integration row.

    Every selector is tenant-scoped (email OR brand) so a lookup can never cross
    tenant boundaries. Returns None when the DB is unavailable or unregistered.

    Uses ``.limit(1).execute()`` (the same pattern used by ingestion.py) instead
    of ``maybeSingle()`` for broader client compatibility.
    """
    if db is None:
        return None
    try:
        query = db.table("tenant_integrations").select(
            "brand_id, email_address, encrypted_refresh_token"
        ).eq("provider", "google_gmail")
        if email_address is not None:
            query = query.eq("email_address", email_address)
        if brand_id is not None:
            query = query.eq("brand_id", str(brand_id))
        query = query.limit(1)
        res = query.execute()
        data = res.data or []
        return data[0] if data else None
    except Exception as e:
        logger.error(f"[GMAIL PUSH ERROR] Integration lookup failed: {e}", exc_info=True)
        return None


def _set_tenant_status(db: Optional[Client], email_address: str, status_value: str) -> None:
    """Best-effort sync_status update scoped to one registered tenant email."""
    if db is None:
        return
    try:
        (
            db.table("tenant_integrations")
            .update({"sync_status": status_value, "last_synced_at": _now_iso()})
            .eq("email_address", email_address)
            .execute()
        )
    except Exception as e:
        logger.warning(f"[GMAIL PUSH DEBUG] Could not set sync_status={status_value}: {e}")


STALE_SYNC_LOCK_SECONDS = 15 * 60


def _is_stale_sync_timestamp(raw_ts: Any) -> bool:
    """Return True when last_synced_at is missing, malformed, or older than 15 minutes."""
    if not raw_ts:
        return True
    try:
        text = str(raw_ts).strip()
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        parsed = datetime.fromisoformat(text)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        age = (datetime.now(timezone.utc) - parsed).total_seconds()
        return age >= STALE_SYNC_LOCK_SECONDS
    except Exception:
        return True


def _try_claim_sync(db: Optional[Client], email_address: str) -> bool:
    """Atomically claim one Gmail sync for a tenant, recovering stale locks (>15m).

    Pub/Sub may deliver the same notification more than once and the webhook
    starts background tasks concurrently.  A read-then-write status update is
    racy; this conditional UPDATE makes only one worker transition an idle/error
    integration to ``syncing``.  If a previous worker crashed or timed out while
    holding ``sync_status = 'syncing'``, a lock older than 15 minutes is
    automatically reclaimed so the tenant is never wedged permanently.
    """
    if db is None or not email_address:
        return False
    now_iso = _now_iso()
    try:
        result = (
            db.table("tenant_integrations")
            .update({"sync_status": "syncing", "last_synced_at": now_iso})
            .eq("email_address", email_address)
            .neq("sync_status", "syncing")
            .select("id")
            .execute()
        )
        if result.data:
            return True

        # Check if the existing 'syncing' lock is stale (>15 minutes old)
        check_res = (
            db.table("tenant_integrations")
            .select("id, sync_status, last_synced_at")
            .eq("email_address", email_address)
            .limit(1)
            .execute()
        )
        rows = check_res.data or []
        if rows and rows[0].get("sync_status") == "syncing":
            if _is_stale_sync_timestamp(rows[0].get("last_synced_at")):
                logger.warning(
                    f"[GMAIL PUSH] Reclaiming stale 'syncing' lock for {email_address!r} "
                    f"(last_synced_at={rows[0].get('last_synced_at')!r})."
                )
                reclaim_res = (
                    db.table("tenant_integrations")
                    .update({"sync_status": "syncing", "last_synced_at": now_iso})
                    .eq("email_address", email_address)
                    .eq("sync_status", "syncing")
                    .select("id")
                    .execute()
                )
                return bool(reclaim_res.data)
        return False
    except Exception as e:
        logger.warning(f"[GMAIL PUSH DEBUG] Could not claim sync for {email_address!r}: {e}")
        return False


# ---------------------------------------------------------------------------
# History cursor (self-healing gap backfill)
#
# A Gmail Pub/Sub push is ACKed with HTTP 200 as soon as the webhook returns,
# so if the background sync later fails Google never redelivers that historyId.
# We therefore persist a durable per-tenant history cursor on `last_history_id`
# and start every push from it (instead of only the notification's historyId),
# so an acked-but-failed push leaves the cursor behind and the NEXT push
# re-fetches and backfills the gap idempotently. The cursor only advances on a
# SUCCESSFUL sync.
#
# The `last_history_id` column may not exist yet on a given environment — the
# cursor is read via a SEPARATE defensive query (`_read_history_cursor`, below)
# that tolerates PostgREST 400 on a missing column, so an unmigrated schema
# degrades to the previous behavior (start from the notification's historyId)
# instead of dropping the push. Apply on the production Supabase database (DO
# NOT run migrations from application code):
#
#   ALTER TABLE tenant_integrations
#       ADD COLUMN IF NOT EXISTS last_history_id TEXT;
#
# ---------------------------------------------------------------------------
def _read_history_cursor(db: Optional[Client], email_address: str) -> Optional[str]:
    """Best-effort read of the durable cursor; None when the column/row is absent.

    Unlike the main integration SELECT, this tolerates the column not existing
    yet (PostgREST 400s on a missing column), so an unmigrated schema keeps the
    previous behavior instead of dropping the push.
    """
    if db is None:
        return None
    try:
        res = (
            db.table("tenant_integrations")
            .select("last_history_id")
            .eq("email_address", email_address)
            .limit(1)
            .execute()
        )
        rows = res.data or []
        if not rows:
            return None
        return str(rows[0].get("last_history_id") or "").strip() or None
    except Exception as e:
        logger.warning(f"[GMAIL PUSH DEBUG] Could not read last_history_id: {e}")
        return None


def _persist_history_cursor(db: Optional[Client], email_address: str, history_id: str) -> None:
    """Best-effort persist of the highest historyId seen, scoped to one tenant email.

    Only called on a SUCCESSFUL sync; on failure the cursor is left behind so
    the next push re-fetches and backfills the gap. The notification's
    historyId is a safe upper bound for the mailbox at that point.
    """
    val = str(history_id or "").strip()
    if db is None or not val:
        return
    try:
        (
            db.table("tenant_integrations")
            .update({"last_history_id": val})
            .eq("email_address", email_address)
            .execute()
        )
    except Exception as e:
        logger.warning(f"[GMAIL PUSH DEBUG] Could not persist last_history_id={val}: {e}")


async def process_gmail_push(db_client: Optional[Client], email_address: str, history_id: str) -> None:
    """Background consumer for one Gmail push (delegated to a worker thread).

    All downstream work (postgrest + requests) is synchronous, so it is run via
    ``asyncio.to_thread`` to keep the event loop responsive. The tenant brand_id
    is derived ONLY from the registered emailAddress -> tenant_integrations map.
    """
    await asyncio.to_thread(_run_push_sync, db_client, email_address, history_id)


def _run_push_sync(db: Optional[Client], email_address: str, history_id: str) -> None:
    if db is None:
        logger.error("[GMAIL PUSH ERROR] No Supabase client; dropping push.")
        return

    # 1. Tenant resolution (ISOLATION): unregistered email -> drop, never process.
    row = _lookup_integration(db, email_address=email_address)
    if not row or not row.get("encrypted_refresh_token"):
        logger.info(
            f"[GMAIL PUSH] Unregistered email {email_address!r}; dropping push "
            "(no tenant_integrations row — nothing processed cross-tenant)."
        )
        return
    brand_id = str(row["brand_id"])
    # Tenant context for store auto-creation during sync: derive the owner
    # user and that user's full brand set from the resolved brand_id (scoped to
    # the registered email -> integration row; never cross-tenant).
    user_id, tenant_brand_ids = _tenant_context_for_brand(db, brand_id)

    # Claim the tenant before reading the cursor. Without this atomic claim,
    # duplicate Pub/Sub deliveries all read the same cursor and process the
    # same settlement concurrently.
    if not _try_claim_sync(db, email_address):
        logger.info(f"[GMAIL PUSH] Sync already in progress for {email_address!r}; skipping duplicate delivery.")
        return

    # Effective start history id: self-heal gaps. If a previous push was acked
    # but its sync failed BEFORE persisting the cursor, the stored
    # last_history_id stays behind and the next push re-fetches + backfills.
    # Only falls back to the notification's historyId when no cursor exists yet.
    stored_cursor = _read_history_cursor(db, email_address)
    start_history_id = stored_cursor if stored_cursor else history_id

    # 2. Status lifecycle: mark syncing, then idle/error in finally.
    outcome = "idle"
    try:
        refresh_token = decrypt_refresh_token(str(row["encrypted_refresh_token"]))
        access_token = refresh_access_token(refresh_token)
        processed = _sync_history_for_brand(
            db, brand_id, access_token, start_history_id,
            user_id=user_id, tenant_brand_ids=tenant_brand_ids,
        )
        # Only a SUCCESSFUL sync advances the cursor (notification historyId is
        # a safe upper bound of what we've now consumed). On failure the except
        # below returns early, leaving the cursor behind for the next push.
        # Monotonic guard: Pub/Sub delivery is not order-guaranteed and
        # background tasks run concurrently, so an out-of-order/older push must
        # not regress the cursor (Gmail historyIds are decimal integers; compare
        # numerically when both parse, else persist unconditionally — the
        # downstream upsert is idempotent either way).
        def _newer(a: str, b: str) -> bool:
            try:
                return int(a) > int(b)
            except (TypeError, ValueError):
                return True

        if not stored_cursor or _newer(history_id, stored_cursor):
            _persist_history_cursor(db, email_address, history_id)
        logger.info(
            f"[GMAIL PUSH DEBUG] brand_id={brand_id} start_history_id={start_history_id} "
            f"(push history_id={history_id}) messages_processed={processed}"
        )
    except Exception as e:
        outcome = "error"
        logger.error(
            f"[GMAIL PUSH ERROR] brand_id={brand_id} email={email_address} "
            f"history_id={history_id} failed: {e}",
            exc_info=True,
        )
    finally:
        _set_tenant_status(db, email_address, outcome)


def _sync_history_for_brand(
    db: Optional[Client],
    brand_id: str,
    access_token: str,
    history_id: str,
    user_id: Optional[str] = None,
    tenant_brand_ids: Optional[List[str]] = None,
) -> int:
    """Fetch history since history_id, filter to settlement senders, ingest."""
    records = list_history(access_token, history_id)

    message_ids: list = []
    for rec in records or []:
        for msg in rec.get("messages") or []:
            if msg.get("id"):
                message_ids.append(str(msg["id"]))

    processed = 0
    for message_id in message_ids:
        try:
            message = get_message(access_token, message_id)
        except Exception as e:
            logger.warning(f"[GMAIL PUSH DEBUG] get_message {message_id} failed: {e}")
            continue

        from_header = (message.get("headers") or {}).get("from", "")
        subject = (message.get("headers") or {}).get("subject", "")

        # Application-level exclusion marker (invoices / tax invoices /
        # receipts) - identical semantics to the SETTLEMENT_EXCLUDE_MARKERS
        # check in web/lib/gmail/google.ts used by the manual sync route. Skip
        # BEFORE sender classification / parsing so invoice/receipt emails from
        # settlement senders are never fetched-and-parsed pointlessly.
        subject_lower = (subject or "").lower()
        if any(marker.lower() in subject_lower for marker in SETTLEMENT_EXCLUDE_MARKERS):
            logger.info(
                f"[GMAIL PUSH] Skipping excluded message {message_id} "
                f"(subject {subject!r}) - matches invoice/receipt exclusion marker."
            )
            continue

        platform_label = classify_sender(from_header)
        if platform_label is None:
            logger.info(
                f"[GMAIL PUSH] Skipping non-settlement message {message_id} "
                f"(sender {from_header!r})."
            )
            continue

        platform = PlatformEnum.GRAB if platform_label == "grab" else PlatformEnum.LINE_MAN
        try:
            for att in message.get("attachments") or []:
                processed += _ingest_attachment(
                    db, brand_id, access_token,
                    message_id, from_header, subject, platform, att,
                    user_id=user_id, tenant_brand_ids=tenant_brand_ids,
                )
        except Exception as e:  # one bad message must not fail the whole push
            logger.error(
                f"[GMAIL PUSH ERROR] processing message {message_id} failed: {e}",
                exc_info=True,
            )
    return processed


def _ingest_attachment(
    db: Optional[Client],
    brand_id: str,
    access_token: str,
    message_id: str,
    sender: str,
    subject: str,
    platform: PlatformEnum,
    attachment: Dict[str, Any],
    user_id: Optional[str] = None,
    tenant_brand_ids: Optional[List[str]] = None,
) -> int:
    """Download one attachment, parse it, and idempotently upsert (brand-scoped)."""
    attachment_id = attachment.get("attachmentId")
    filename = attachment.get("filename") or f"attachment-{attachment_id}"
    mime_type = attachment.get("mimeType") or "application/octet-stream"

    content = get_attachment(access_token, message_id, attachment_id, mime_type)
    records = _parse_platform(platform, content, filename, sender, subject, brand_id)
    if not records:
        logger.info(f"[GMAIL PUSH] No records parsed from {filename!r}; skipping upsert.")
        return 0

    # Lowercase label ("grab"/"lineman") — the same convention the existing
    # /grab and /lineman routes pass to _finalize(). The resolver normalizes
    # these to the canonical values ("Grab"/"LINE MAN"); passing the enum's
    # .value ("LINE MAN") would survive _canonical_platform as the unresolvable
    # lowercase "line man".
    platform_label = "grab" if platform is PlatformEnum.GRAB else "lineman"
    resp = _process_and_upsert_records(
        records,
        db,
        brand_id=brand_id,
        platform=platform_label,
        source_label=f"gmail-push:{platform_label}",
        tenant_brand_ids=tenant_brand_ids,
        user_id=user_id,
    )
    return getattr(resp, "total_processed", len(records))


# =============================================================================
# Pub/Sub push authentication — FAIL CLOSED.
#
#  1. OIDC (enforced when GMAIL_PUBSUB_AUDIENCE is set): a Bearer token is
#     MANDATORY. The push must carry `Authorization: Bearer <token>` and the
#     token is verified as a Google-signed OIDC token (Google's published
#     certs; issuer accounts.google.com; audience == the configured public
#     webhook URL). On ANY failure -> 401. The legacy shared secret is NOT a
#     fallback for tokenless requests.
#  2. Legacy shared secret (enforced when only GMAIL_PUBSUB_VERIFICATION_TOKEN
#     is set): requires a matching X-Goog-Channel-Token / X-Pubsub-Token.
# When NEITHER the audience nor the shared secret is configured, the webhook
# FAILS CLOSED with 401 — no push authentication is configured, so no push is
# accepted.
# =============================================================================

GOOGLE_OIDC_ISSUERS = ("accounts.google.com", "https://accounts.google.com")
GOOGLE_CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs"

# Module-level certs client cache: Google publishes a small static cert set
# that rotates rarely; PyJWKClient re-fetches only on key rotation, so one
# instance avoids a network round-trip on every push while never going stale.
_google_certs_client: Optional[PyJWKClient] = None


def _get_google_certs_client() -> PyJWKClient:
    global _google_certs_client
    if _google_certs_client is None:
        _google_certs_client = PyJWKClient(GOOGLE_CERTS_URL)
    return _google_certs_client


def _verify_oidc_bearer(token: str, audience: str) -> None:
    """Verify a Google-signed OIDC push token (Pub/Sub OIDC subscription auth).

    Decodes the JWT against Google's published signing certs, requiring the
    issuer to be ``accounts.google.com`` and the audience to equal the
    configured public webhook URL (``GMAIL_PUBSUB_AUDIENCE``). Raises 401 on any
    failure — a push is never accepted unless it is both Google-signed AND
    targeted at this exact webhook, so a stolen token for a different endpoint
    cannot replay here.
    """
    try:
        signing_key = _get_google_certs_client().get_signing_key_from_jwt(token)
        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            audience=audience,  # native aud validation vs. the configured URL
            options={"require": ["iss", "aud", "exp"]},
        )
    except jwt.PyJWTError as exc:
        logger.info(f"[GMAIL PUSH] OIDC verification failed: {exc}")
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            detail={"error": "UNAUTHORIZED_PUSH", "message": "Invalid Google OIDC push token."},
        )
    if claims.get("iss") not in GOOGLE_OIDC_ISSUERS:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            detail={
                "error": "UNAUTHORIZED_PUSH",
                "message": f"Unexpected OIDC issuer: {claims.get('iss')!r}.",
            },
        )


@router.post("/gmail/webhook", status_code=status.HTTP_200_OK)
@limiter.limit(settings.RATE_LIMIT_PER_MINUTE)
async def gmail_webhook(
    request: Request,
    payload: PubSubPushNotification,
    background_tasks: BackgroundTasks,
    db: Optional[Client] = Depends(get_db),
) -> dict:
    """Google Cloud Pub/Sub push receiver.

    Acknowledges well-formed pushes with an immediate HTTP 200 and queues the
    heavy lifting as a background task. Malformed/undecodable pushes return
    400/422 (never 500) so a misconfigured topic is visible without forcing
    Google to retry bad payloads forever. Auth FAILS CLOSED: OIDC (when
    GMAIL_PUBSUB_AUDIENCE is set, Bearer mandatory) -> legacy shared secret
    -> 401 when neither is configured; see the module comment above.
    """
    # Pub/Sub push auth — FAIL CLOSED. Every unauthenticated path ends in 401:
    # OIDC (Bearer mandatory) -> legacy shared secret -> 401 when neither is
    # configured. There is no unauthenticated fall-through.
    pubsub_audience = (settings.GMAIL_PUBSUB_AUDIENCE or "").strip()
    verification_token = (settings.GMAIL_PUBSUB_VERIFICATION_TOKEN or "").strip()

    if pubsub_audience:
        # OIDC mode (STRICT): a valid Google-signed Bearer token is REQUIRED.
        authorization = (request.headers.get("Authorization") or "").strip()
        if not authorization.startswith("Bearer "):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail={
                "error": "UNAUTHORIZED_PUSH",
                "message": "Missing Authorization Bearer token; OIDC push auth is enforced.",
            })
        oidc_token = authorization[len("Bearer "):].strip()
        if not oidc_token:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail={
                "error": "UNAUTHORIZED_PUSH",
                "message": "Authorization Bearer token is empty.",
            })
        _verify_oidc_bearer(oidc_token, pubsub_audience)
    elif verification_token:
        # Legacy shared-secret mode: require a matching X-Goog-Channel-Token.
        supplied = (
            request.headers.get("X-Goog-Channel-Token")
            or request.headers.get("X-Pubsub-Token")
            or ""
        ).strip()
        if not supplied or not hmac.compare_digest(supplied, verification_token):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail={
                "error": "UNAUTHORIZED_PUSH",
                "message": "Invalid or missing push verification token.",
            })
    else:
        # FAIL CLOSED: neither audience nor shared secret is configured.
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail={
            "error": "UNAUTHORIZED_PUSH",
            "message": "No push authentication is configured (set GMAIL_PUBSUB_AUDIENCE or GMAIL_PUBSUB_VERIFICATION_TOKEN).",
        })

    try:
        decoded = base64_decode_pubsub_message(payload.message.data)
        notification = GmailHistoryNotification.model_validate(decoded)
    except ValidationError as ve:
        logger.warning(f"[GMAIL PUSH DEBUG] Invalid history payload: {ve.errors()}")
        # pydantic v2 embeds the raw exception under errors[].ctx.error, which is
        # not JSON-serializable — emit a JSON-safe summary instead.
        safe_errors = json.loads(ve.json(include_url=False, include_context=False))
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "error": "INVALID_PUSH_PAYLOAD",
                "message": "Malformed Gmail history notification payload.",
                "error_count": len(ve.errors()),
                "details": safe_errors,
            },
        )
    except Exception as e:
        logger.warning(f"[GMAIL PUSH DEBUG] Undecodable push payload: {e}")
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail={"error": "INVALID_PUSH_PAYLOAD", "message": f"Could not decode Pub/Sub payload: {e}"},
        )

    logger.info(
        f"[GMAIL PUSH DEBUG] Push ack: email={notification.emailAddress} historyId={notification.historyId}"
    )
    background_tasks.add_task(
        process_gmail_push,
        db_client=db,
        email_address=notification.emailAddress,
        history_id=notification.historyId,
    )
    return {"status": "ack"}


@router.post("/gmail/watch", status_code=status.HTTP_200_OK)
@limiter.limit(settings.RATE_LIMIT_PER_MINUTE)
async def gmail_watch_for_brand(
    request: Request,
    payload: WatchRequest,
    user_id: str = Depends(get_authenticated_user),
    db: Optional[Client] = Depends(get_db),
) -> dict:
    """(Re)establish a brand's Gmail push watch. JWT auth + rate-limited.

    The tenant brand set comes from the authenticated user's ``brand_users``
    scope (server-side, via get_tenant_scope); the requested ``brand_id`` is
    membership-checked by resolve_brand_id_from_scope and rejected with 403 if
    it is not one of the caller's brands, so a client can never watch a brand
    outside its own tenant.
    """
    require_write_access(db, user_id)
    scope_user_id, tenant_brand_ids = get_tenant_scope(db, user_id)
    if not scope_user_id or not tenant_brand_ids:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail={
                "error": "NO_TENANT_SCOPE",
                "message": "Authenticated user has no tenant brand scope.",
            },
        )
    brand_id = resolve_brand_id_from_scope(tenant_brand_ids, str(payload.brand_id))
    if brand_id is None:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail={
                "error": "BRAND_NOT_IN_SCOPE",
                "message": "Requested brand_id is not part of the authenticated user's tenant scope.",
            },
        )
    topic = (settings.GMAIL_PUBSUB_TOPIC or "").strip()
    if not topic:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "error": "PUBSUB_NOT_CONFIGURED",
                "message": "GMAIL_PUBSUB_TOPIC is not configured; push watch is unavailable. "
                "Set it to projects/<project-id>/topics/gmail-delivery-sync.",
            },
        )
    result = await asyncio.to_thread(_ensure_watch_sync, db, brand_id, topic)
    return result


def _ensure_watch_sync(db: Optional[Client], brand_id: str, topic: str) -> dict:
    """Look up the brand, decrypt its refresh token, and register the watch."""
    if db is None:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"error": "NO_DATABASE_CLIENT", "message": "Supabase client unavailable."},
        )
    row = _lookup_integration(db, brand_id=brand_id)
    if not row or not row.get("encrypted_refresh_token"):
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            detail={"error": "INTEGRATION_NOT_FOUND", "message": "No registered Google Gmail integration for this brand_id."},
        )
    refresh_token = decrypt_refresh_token(str(row["encrypted_refresh_token"]))
    access_token = refresh_access_token(refresh_token)
    result = gmail_watch(access_token, topic)

    email = str(row.get("email_address") or brand_id)
    _set_tenant_status(db, email, "idle")
    logger.info(f"[GMAIL PUSH DEBUG] Watch established for brand_id={brand_id}: {result}")
    return result
