"""Per-tenant authentication helpers (Phase 0 of per-tenant auth).

This module replaces "trust a client-supplied brand_id" with "authenticate the
caller and derive the tenant server-side". The Next.js proxy forwards the user's
Supabase access token (a JWT); we verify it against the project's published
asymmetric ES256 signing keys (JWKS) and extract the real ``sub`` (user UUID).
The tenant's brand set is then derived from ``brand_users`` — the client never
supplies any tenant identifier on authenticated paths.

Supabase uses ASYMMETRIC ES256 keys (JWKS at
``<SUPABASE_URL>/auth/v1/.well-known/jwks.json``, kty=EC alg=ES256), NOT the
legacy HS256 ``supabase_jwt_secret``. The JWKS URL is derived from the existing
``SUPABASE_URL`` setting and is PUBLIC (a signing-key-discovery endpoint, not a
secret) — no secret value is ever configured here.
"""
import logging
from typing import List, Optional, Tuple

import jwt
from fastapi import HTTPException, Request, status
from jwt import PyJWKClient
from supabase import Client

from app.core.config import settings

logger = logging.getLogger("auth")

# Module-level JWKS client cache: Supabase rotates its public signing keys rarely,
# and PyJWKClient caches the fetched JWKS set (only re-fetching on key rotation),
# so a single module instance avoids a network round-trip on every request.
_jwks_client: Optional[PyJWKClient] = None


def _get_jwks_client() -> PyJWKClient:
    """Return the cached JWKS client; the JWKS URL is PUBLIC and derived from
    SUPABASE_URL, never a configured secret."""
    global _jwks_client
    if _jwks_client is None:
        base = (settings.SUPABASE_URL or "").rstrip("/")
        jwks_url = f"{base}/auth/v1/.well-known/jwks.json"
        if not base:
            logger.error("[AUTH] SUPABASE_URL is not configured; cannot build the JWKS URL.")
        _jwks_client = PyJWKClient(jwks_url)
    return _jwks_client


def get_authenticated_user(request: Request) -> str:
    """FastAPI dependency: verify the Supabase access token (ES256 via JWKS).

    Reads ``Authorization: Bearer <token>``, verifies the signature against the
    project's JWKS public keys, and returns ``str(payload["sub"])`` (the user
    UUID). Raises 401 on a missing/malformed header, any PyJWT error
    (invalid/expired token, unknown signing key), or a missing ``sub`` claim.
    """
    auth = (request.headers.get("Authorization") or "").strip()
    if not auth.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "error": "MISSING_OR_MALFORMED_TOKEN",
                "message": "Missing or malformed 'Authorization: Bearer <token>' header.",
            },
        )
    token = auth[len("Bearer "):].strip()
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"error": "MISSING_TOKEN", "message": "Authorization header has no token."},
        )

    try:
        signing_key = _get_jwks_client().get_signing_key_from_jwt(token)
        payload = jwt.decode(
            token,
            signing_key.key,
            algorithms=["ES256"],
            audience="authenticated",
            options={"require": ["exp", "sub"]},
        )
    except jwt.PyJWTError as exc:
        logger.info(f"[AUTH] JWT verification failed: {exc}")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"error": "INVALID_TOKEN", "message": f"Invalid or expired access token: {exc}"},
        )

    sub = payload.get("sub")
    if not sub:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"error": "MISSING_SUB", "message": "Access token has no 'sub' claim."},
        )
    return str(sub)


def get_tenant_scope(db: Optional[Client], user_id: Optional[str]) -> Tuple[Optional[str], List[str]]:
    """Server-side tenant derivation: brand_users WHERE user_id -> (user_id, brand_ids).

    Returns ``(user_id, [brand_id, ...])`` — the authenticated user's FULL brand
    set. The client NEVER supplies a brand_id on authenticated paths; the tenant
    scope comes only from the authenticated user's brand_users rows. Returns
    ``(None, [])`` on any error (fail-safe, never fabricates) — mirroring the
    resolver's fail-closed behavior so a calling write path can abort rather than
    write to an arbitrary brand.
    """
    if db is None or not user_id:
        return None, []
    try:
        rows = (
            db.table("brand_users")
            .select("brand_id")
            .eq("user_id", str(user_id))
            .execute()
            .data
            or []
        )
    except Exception as exc:  # noqa: BLE001 - fail-safe on DB error
        logger.error(f"[AUTH] brand_users lookup for user_id={user_id} failed: {exc}")
        return None, []
    brand_ids = [str(r["brand_id"]) for r in rows if r.get("brand_id")]
    return str(user_id), brand_ids


def require_write_access(db: Optional[Client], user_id: Optional[str]) -> None:
    """Reject read-only partner memberships on every authenticated write path.

    A user may belong to more than one brand. We fail closed when any of the
    caller's memberships is partner-only, because write endpoints currently
    operate on the full tenant scope and must never let a mixed-scope account
    mutate a partner brand accidentally.
    """
    if db is None or not user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"error": "NO_TENANT_SCOPE", "message": "Authenticated user has no writable tenant scope."},
        )
    try:
        rows = (
            db.table("brand_users")
            .select("role")
            .eq("user_id", str(user_id))
            .execute()
            .data
            or []
        )
    except Exception as exc:  # noqa: BLE001 - fail closed on DB errors
        logger.error(f"[AUTH] writable membership lookup for user_id={user_id} failed: {exc}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"error": "TENANT_LOOKUP_FAILED", "message": "Could not verify tenant write access."},
        )
    if not rows or any((row.get("role") or "") == "partner" for row in rows):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"error": "PARTNER_READ_ONLY", "message": "Partner accounts have read-only access."},
        )


def resolve_brand_id_from_scope(
    tenant_brand_ids: List[str],
    requested: Optional[str],
) -> Optional[str]:
    """Membership-check a client-requested brand_id against the authenticated scope.

    GROUP 2 single-brand-selector endpoints call this so a client-supplied
    ``brand_id`` can NEVER widen the tenant scope:

      - ``requested`` None / "ALL" / "*" / ""  -> return the FIRST (primary) brand;
      - ``requested`` names a MEMBER           -> return it unchanged;
      - ``requested`` names a NON-member       -> return None (caller rejects
        with 403 — the request is never honored or widened);
      - ``tenant_brand_ids`` empty             -> return None (caller 403s).

    Edge: FastAPI UUID validation coerces absent/blank to None, so the empty
    string special case is belt-and-braces for text selectors.
    """
    if not tenant_brand_ids:
        return None
    if requested is None:
        return tenant_brand_ids[0]
    req = str(requested).strip()
    if req.lower() in ("", "all", "*"):
        return tenant_brand_ids[0]
    for b in tenant_brand_ids:
        if str(b) == req:
            return req
    return None  # non-member brand -> never widen
