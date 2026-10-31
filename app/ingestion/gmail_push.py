"""Raw-HTTP Google OAuth + Gmail Pub/Sub push client (no heavy googleapis SDK).

Mirrors the existing Next.js pattern in web/lib/gmail/google.ts ("plain fetch, no
heavy googleapis SDK"). Only the already-installed ``httpx`` + ``cryptography``
are used — no google-api-python-client / google-auth / google-cloud-pubsub.

Transport note: the token exchange and all Gmail reads go through ``httpx``
(v0.28.1, already a pinned dependency) instead of ``requests`` because the
latter proved TLS-fragile in this container (observed
``SSLError(SSLEOFError(8, 'UNEXPECTED_EOF_WHILE_READING'))`` on transient
network/TLS conditions while the same container's httpx->Supabase calls kept
succeeding). Every function retries transient connect/read/TLS/timeout errors
with exponential backoff so a momentary TLS blip does not drop a settlement
message; 4xx auth errors are never retried.

Security contract:
  - decrypt_refresh_token matches web/lib/gmail/crypto.ts EXACTLY (AES-256-GCM,
    key = SHA256(ENCRYPTION_KEY), 12-byte nonce, "<iv>.<tag>.<ct>" standard b64)
    so Python can decrypt tokens the app already stored.
  - Access tokens are never persisted; refresh tokens live encrypted at rest.
"""
import base64
import binascii
import hashlib
import json
import logging
import ssl
import time
from typing import Any, Dict, List, Optional

import httpx
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.core.config import settings

logger = logging.getLogger("ingestion_audit")

GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me"

# Settlement-email senders — mirrors GRAB_QUERY / LINEMAN_QUERY in
# web/lib/gmail/google.ts. Matched (substring, lowercased) against the message
# `From` header to decide which platform a push belongs to.
GRAB_SENDER = "no-reply@grab.com"
LINEMAN_SENDER = "no-reply-merchant@lmwn.com"

# Application-level exclusion markers - mirrors SETTLEMENT_EXCLUDE_MARKERS
# in web/lib/gmail/google.ts EXACTLY, so the Pub/Sub push pipeline applies
# the same invoice/receipt subject filter as the manual sync route. Thai
# "tax invoice" stays as raw ASCII (safe) escapes - never raw glyphs.
#
# IMPORTANT: Grab sends TWO emails per day — (1) the sales summary "สรุปยอดขาย
# ... GrabFood" which we MUST ingest, and (2) the "Grab: Receipt/Tax Invoice
# No. IM..." tax-invoice copy which we must SKIP (it is a tax document, not the
# settlement). These markers correctly filter out ONLY the tax-invoice copy.
SETTLEMENT_EXCLUDE_MARKERS = [
    "Invoice",
    "Tax Invoice",
    "Receipt",
    "\u0E43\u0E1A\u0E01\u0E33\u0E01\u0E31\u0E1A\u0E20\u0E32\u0E29\u0E35",  # Thai: tax invoice
]

# Timeouts for Google endpoints. 60s for attachment downloads (largest payloads),
# 30s for token/history/message.
_DEFAULT_TIMEOUT = 30.0
_ATTACHMENT_TIMEOUT = 60.0

# Retry policy for Google-facing HTTP calls.
DEFAULT_RETRY_ATTEMPTS = 3
DEFAULT_RETRY_BASE_DELAY = 0.5  # seconds; backoff = base_delay * 2^(attempt-1)

# Transient (connect/read/TLS/timeout) errors worth retrying. These arrive as
# raised exceptions. HTTP 4xx auth errors (invalid_grant etc.) arrive as normal
# responses (status >= 400 handled by each caller), NOT as exceptions, so the
# retry loop below never masks them.
_RETRYABLE_TRANSIENT_ERRORS = (
    httpx.TransportError,  # parent of NetworkError / ConnectError / ReadError
    httpx.RemoteProtocolError,  # server dropped the connection mid-request
    httpx.TimeoutException,  # ConnectTimeout / ReadTimeout
    ssl.SSLError,
    OSError,
)


def _retry(
    fn,
    *,
    label: str,
    attempts: int = DEFAULT_RETRY_ATTEMPTS,
    base_delay: float = DEFAULT_RETRY_BASE_DELAY,
) -> httpx.Response:
    """Run ``fn`` (must return an ``httpx.Response``), retrying transient errors.

    Backoff: base_delay * 2^(attempt-1). Never retries on HTTP status codes —
    a 4xx auth response is returned to the caller immediately. Raises
    RuntimeError once ``attempts`` are exhausted.
    """
    last_exc = None
    for attempt in range(1, attempts + 1):
        try:
            return fn()
        except _RETRYABLE_TRANSIENT_ERRORS as exc:
            last_exc = exc
            if attempt < attempts:
                delay = base_delay * (2 ** (attempt - 1))
                logger.warning(
                    f"[GMAIL PUSH] {label} transient error "
                    f"(attempt {attempt}/{attempts}): {exc!r}; retrying in {delay:.1f}s"
                )
                time.sleep(delay)
    raise RuntimeError(f"{label} failed after {attempts} attempts: {last_exc!r}") from last_exc


# ---------------------------------------------------------------------------
# Crypto (must interop with web/lib/gmail/crypto.ts)
# ---------------------------------------------------------------------------
def _encryption_key() -> bytes:
    key = (settings.ENCRYPTION_KEY or "").strip()
    if not key:
        raise RuntimeError("ENCRYPTION_KEY is not configured; cannot decrypt stored tokens.")
    return hashlib.sha256(key.encode("utf-8")).digest()


def decrypt_refresh_token(payload: str) -> str:
    """Decrypt an AES-256-GCM token stored as "<iv_b64>.<tag_b64>.<ct_b64>".

    Raises a clear error on wrong format, bad base64, wrong key, or tampering
    (AESGCM raises cryptography.exceptions.InvalidTag on auth-tag mismatch).
    """
    parts = (payload or "").strip().split(".")
    if len(parts) != 3:
        raise ValueError("Invalid encrypted payload format: expected '<iv>.<tag>.<ct>'")
    iv_b64, tag_b64, ct_b64 = parts
    try:
        iv = base64.b64decode(iv_b64, validate=True)
        tag = base64.b64decode(tag_b64, validate=True)
        ct = base64.b64decode(ct_b64, validate=True)
    except (ValueError, binascii.Error) as e:
        raise ValueError(f"Invalid base64 in encrypted payload: {e}") from e

    if len(iv) != 12:
        raise ValueError("Invalid IV: AES-256-GCM requires a 12-byte nonce.")
    if len(tag) != 16:
        raise ValueError("Invalid tag: AES-256-GCM auth tag must be 16 bytes.")

    aesgcm = AESGCM(_encryption_key())
    try:
        plaintext = aesgcm.decrypt(nonce=iv, data=ct + tag, associated_data=None)
    except InvalidTag as e:
        raise ValueError("Decryption failed: auth tag mismatch (tampered ciphertext or wrong ENCRYPTION_KEY).") from e
    except Exception as e:  # pragma: no cover - defensive
        raise ValueError(f"Decryption failed: {e}") from e
    return plaintext.decode("utf-8")


# ---------------------------------------------------------------------------
# Google OAuth 2.0 (raw POST)
# ---------------------------------------------------------------------------
def refresh_access_token(refresh_token: str) -> str:
    """Exchange a refresh token for a fresh access token (raw form POST).

    Retries transient network/TLS/timeout errors with backoff. A 4xx auth error
    (invalid_grant etc.) is permanent and is surfaced immediately as RuntimeError
    (never retried). Same request body and error semantics as before.
    """
    client_id = (settings.GOOGLE_CLIENT_ID or "").strip()
    client_secret = (settings.GOOGLE_CLIENT_SECRET or "").strip()
    if not client_id or not client_secret:
        raise RuntimeError("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not configured.")

    def _do() -> httpx.Response:
        return httpx.post(
            GOOGLE_TOKEN_ENDPOINT,
            data={
                "grant_type": "refresh_token",
                "refresh_token": refresh_token,
                "client_id": client_id,
                "client_secret": client_secret,
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            timeout=_DEFAULT_TIMEOUT,
        )

    resp = _retry(_do, label="Google token refresh", attempts=DEFAULT_RETRY_ATTEMPTS)

    try:
        body = resp.json()
    except ValueError:
        body = {}

    if resp.status_code >= 400 or not body.get("access_token"):
        error = body.get("error") or body.get("error_description") or f"HTTP {resp.status_code}"
        raise RuntimeError(f"Google token refresh failed: {error}")
    return str(body["access_token"])


# ---------------------------------------------------------------------------
# Gmail API (raw HTTP GET/POST)
# ---------------------------------------------------------------------------
def _auth_headers(access_token: str) -> Dict[str, str]:
    return {"Authorization": f"Bearer {access_token}"}


def gmail_watch(access_token: str, topic_name: str) -> dict:
    """Register the push watch for the Gmail account (POST /me/watch)."""
    if not (topic_name or "").strip():
        raise RuntimeError("GMAIL_PUBSUB_TOPIC is not configured; cannot establish a watch.")

    def _do() -> httpx.Response:
        return httpx.post(
            f"{GMAIL_API_BASE}/watch",
            json={"topicName": topic_name.strip(), "labelIds": ["INBOX"]},
            headers=_auth_headers(access_token),
            timeout=_DEFAULT_TIMEOUT,
        )

    resp = _retry(_do, label="Gmail watch request", attempts=DEFAULT_RETRY_ATTEMPTS)

    try:
        body = resp.json()
    except ValueError:
        body = {}

    if resp.status_code >= 400:
        error = body.get("error", {}).get("message") if isinstance(body.get("error"), dict) else body
        raise RuntimeError(f"Gmail watch failed ({resp.status_code}): {error}")
    if not body.get("historyId"):
        raise RuntimeError(f"Gmail watch returned no historyId: {body}")
    return body


def list_history(access_token: str, start_history_id: str) -> List[dict]:
    """Fetch history records since start_history_id (GET /me/history)."""
    def _do() -> httpx.Response:
        return httpx.get(
            f"{GMAIL_API_BASE}/history",
            params={"startHistoryId": str(start_history_id)},
            headers=_auth_headers(access_token),
            timeout=_DEFAULT_TIMEOUT,
        )

    resp = _retry(_do, label="Gmail history request", attempts=DEFAULT_RETRY_ATTEMPTS)

    try:
        body = resp.json()
    except ValueError:
        body = {}

    if resp.status_code >= 400:
        error = body.get("error", {}).get("message") if isinstance(body.get("error"), dict) else body
        raise RuntimeError(f"Gmail history failed ({resp.status_code}): {error}")
    return list(body.get("history") or [])


def _walk_parts(node: Any, out: List[dict]) -> None:
    """Recursively collect (attachmentId, filename, mimeType) from a message payload."""
    if not node or not isinstance(node, dict):
        return
    for part in node.get("parts") or []:
        _walk_parts(part, out)
    body = node.get("body") or {}
    if body.get("attachmentId") and node.get("filename"):
        out.append(
            {
                "attachmentId": str(body["attachmentId"]),
                "filename": str(node.get("filename") or ""),
                "mimeType": str(node.get("mimeType") or "application/octet-stream"),
                "size": body.get("size"),
            }
        )


def get_message(access_token: str, message_id: str) -> dict:
    """Fetch one message: id + From/Subject/Date headers + attachment list."""
    def _do() -> httpx.Response:
        return httpx.get(
            f"{GMAIL_API_BASE}/messages/{message_id}",
            params={"format": "full"},
            headers=_auth_headers(access_token),
            timeout=_DEFAULT_TIMEOUT,
        )

    resp = _retry(_do, label="Gmail message fetch", attempts=DEFAULT_RETRY_ATTEMPTS)

    try:
        body = resp.json()
    except ValueError:
        body = {}

    if resp.status_code >= 400 or not body.get("id"):
        error = body.get("error", {}).get("message") if isinstance(body.get("error"), dict) else body
        raise RuntimeError(f"Gmail message fetch failed ({resp.status_code}): {error}")

    headers: Dict[str, str] = {}
    for h in body.get("payload", {}).get("headers") or []:
        name = str(h.get("name") or "").lower()
        headers[name] = str(h.get("value") or "")

    attachments: List[dict] = []
    _walk_parts(body.get("payload"), attachments)

    return {
        "id": str(body["id"]),
        "threadId": str(body.get("threadId") or ""),
        "headers": {
            "subject": headers.get("subject", ""),
            "from": headers.get("from", ""),
            "date": headers.get("date", ""),
        },
        "attachments": attachments,
    }


def get_attachment(
    access_token: str,
    message_id: str,
    attachment_id: str,
    mime_type: str = "application/octet-stream",
) -> bytes:
    """Download a message attachment body as raw bytes (base64url-decodable)."""
    def _do() -> httpx.Response:
        return httpx.get(
            f"{GMAIL_API_BASE}/messages/{message_id}/attachments/{attachment_id}",
            params={"mimeType": mime_type},
            headers=_auth_headers(access_token),
            timeout=_ATTACHMENT_TIMEOUT,
        )

    resp = _retry(_do, label="Gmail attachment fetch", attempts=DEFAULT_RETRY_ATTEMPTS)

    try:
        body = resp.json()
    except ValueError:
        body = {}

    if resp.status_code >= 400 or not body.get("data"):
        error = body.get("error", {}).get("message") if isinstance(body.get("error"), dict) else body
        raise RuntimeError(f"Gmail attachment fetch failed ({resp.status_code}): {error}")
    return _base64_decode(str(body["data"]))


# ---------------------------------------------------------------------------
# Pub/Sub helpers
# ---------------------------------------------------------------------------
def _base64_decode(s: str) -> bytes:
    """Base64-decode tolerantly: handles missing padding and both standard &
    urlsafe alphabets (Gmail attachment bodies are base64url)."""
    data = s.strip()
    pad = (-len(data)) % 4
    if pad:
        data += "=" * pad
    try:
        return base64.b64decode(data, validate=True)
    except (ValueError, binascii.Error):
        return base64.urlsafe_b64decode(data + "=" * ((-len(data)) % 4))


def base64_decode_pubsub_message(data: str) -> dict:
    """Decode Pub/Sub ``message.data`` (standard base64) into a JSON object."""
    if not isinstance(data, str) or not data.strip():
        raise ValueError("Pub/Sub message data is empty.")
    try:
        raw = base64.b64decode(data.strip())  # Pub/Sub uses standard base64
        decoded = json.loads(raw.decode("utf-8"))
    except (ValueError, binascii.Error, KeyError, UnicodeDecodeError) as e:
        # Be defensive: a push may arrive urlsafe / unpadded.
        try:
            raw = _base64_decode(data)
            decoded = json.loads(raw.decode("utf-8"))
        except Exception as fallback_err:
            raise ValueError(f"Invalid Pub/Sub message data: {fallback_err}") from e
    if not isinstance(decoded, dict):
        raise ValueError("Pub/Sub message data is not a JSON object.")
    return decoded


def classify_sender(from_header: str) -> Optional[str]:
    """Return 'grab' | 'lineman' when the From header is a settlement sender, else None.

    Mirrors the sender filters in web/lib/gmail/google.ts. ``None`` means the
    message is NOT a settlement email and must be skipped (never processed).
    """
    h = (from_header or "").lower()
    if GRAB_SENDER in h:
        return "grab"
    if LINEMAN_SENDER in h:
        return "lineman"
    return None