"""Phase 0 auth unit test: Supabase ES256-access-token verification via JWKS.

Specced in docs/per_tenant_auth_design.md (asymmetric ES256 correction). This
project's Supabase uses ASYMMETRIC ES256 keys published at
<SUPABASE_URL>/auth/v1/.well-known/jwks.json — NOT the legacy HS256
supabase_jwt_secret. The test proves:

  1. PyJWKClient smoke: a real JWKS endpoint (served locally) is fetched, the
     matching signing key is selected from the token's `kid`, and a token signed
     ES256 by that key verifies.
  2. Wrong-key rejection: a token signed by a DIFFERENT EC key fails to verify
     (the exact failure mode that blocks cross-tenant forgery).
  3. get_authenticated_user accepts a valid signed token and returns `sub`.
  4. get_authenticated_user rejects a wrong-key token (HTTPException 401).
  5. The JWKS URL is derived from SUPABASE_URL (public value, not a secret).

Runner: /Library/Frameworks/Python.framework/Versions/3.12/bin/python3 \
         tests/test_auth_jwt.py  (no pytest dependency; exits non-zero on failure)
"""
import base64
import http.server
import json
import os
import socketserver
import sys
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import jwt
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.serialization import load_pem_public_key
from jwt import PyJWKClient

# Allow running from repo root OR from within tests/.
ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.core import auth as auth_mod  # noqa: E402
from app.core.config import settings  # noqa: E402

USER_SUB = "3f6f11a2-2a5e-4b7b-9c0c-deadbeef0001"


def _b64url_int(n: int) -> str:
    length = (n.bit_length() + 7) // 8
    return base64.urlsafe_b64encode(n.to_bytes(length, "big")).rstrip(b"=").decode()


def _build_jwks(public_key, kid: str) -> dict:
    pub = public_key.public_numbers()
    return {
        "keys": [
            {
                "kty": "EC",
                "crv": "P-256",
                "kid": kid,
                "alg": "ES256",
                "use": "sig",
                "x": _b64url_int(pub.x),
                "y": _b64url_int(pub.y),
            }
        ]
    }


class _JWKSServer(socketserver.TCPServer):
    allow_reuse_address = True


class _Handler(http.server.BaseHTTPRequestHandler):
    jwks: dict = {}

    def do_GET(self):  # noqa: N802
        body = json.dumps(self.jwks).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):  # silence
        pass


def _make_token(priv_key, kid: str, sub: str) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": sub,
        "aud": "authenticated",
        "iss": "https://example.supabase.co/auth/v1",
        "iat": now,
        "exp": now + timedelta(minutes=60),
    }
    headers = {"kid": kid, "alg": "ES256"}
    return jwt.encode(payload, priv_key, algorithm="ES256", headers=headers)


def _start_jwks_server(priv_key, kid: str):
    _Handler.jwks = _build_jwks(priv_key.public_key(), kid)
    server = _JWKSServer(("127.0.0.1", 0), _Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, f"http://127.0.0.1:{server.server_address[1]}/jwks.json"


def test_pyjwk_smoke_and_verify():
    """(1)+(2) Real JWKS fetch + ES256 verify, and wrong-key rejection."""
    key1 = ec.generate_private_key(ec.SECP256R1())
    key2 = ec.generate_private_key(ec.SECP256R1())  # impostor key (wrong tenant)
    server, jwks_url = _start_jwks_server(key1, "test-key-1")
    try:
        client = PyJWKClient(jwks_url)
        # (1) correct-key token verifies end-to-end via the fetched JWKS.
        token = _make_token(key1, "test-key-1", USER_SUB)
        signing_key = client.get_signing_key_from_jwt(token)
        assert signing_key.key  # a public key object was selected
        payload = jwt.decode(token, signing_key.key, algorithms=["ES256"], audience="authenticated")
        assert payload["sub"] == USER_SUB
        print(f"[1] PyJWKClient fetched {jwks_url}; ES256 verify OK; sub={USER_SUB}")

        # (2) wrong-key token is REJECTED (the forgery failure mode).
        forged = _make_token(key2, "test-key-1", USER_SUB)
        forged_signing_key = client.get_signing_key_from_jwt(forged)
        try:
            jwt.decode(forged, forged_signing_key.key, algorithms=["ES256"], audience="authenticated")
        except jwt.PyJWTError:
            print("[2] Wrong-key ES256 token rejected (InvalidSignature) OK")
            return
        raise AssertionError("wrong-key token was accepted!")
    finally:
        server.shutdown()


def test_auth_dependency():
    """(3)+(4) get_authenticated_user accepts valid token / rejects forged."""
    key1 = ec.generate_private_key(ec.SECP256R1())

    def fake_client(token):
        # Deterministic public key in PEM for PyJWT decode (no network).
        return SimpleNamespace(
            key=key1.public_key().public_bytes(
                serialization.Encoding.PEM,
                serialization.PublicFormat.SubjectPublicKeyInfo,
            )
        )

    auth_mod._get_jwks_client = lambda: SimpleNamespace(
        get_signing_key_from_jwt=fake_client
    )

    good = _make_token(key1, "test-key-1", USER_SUB)
    req = SimpleNamespace(headers={"Authorization": f"Bearer {good}"})
    assert auth_mod.get_authenticated_user(req) == USER_SUB
    print("[3] get_authenticated_user returned sub for a valid ES256 token OK")

    # Missing header -> 401.
    try:
        auth_mod.get_authenticated_user(SimpleNamespace(headers={}))
        raise AssertionError("missing header did not 401")
    except Exception as exc:
        assert getattr(exc, "status_code", None) == 401
    print("[4a] get_authenticated_user 401 on missing header OK")

    # Forged token: signed by a DIFFERENT key, but the (trusted) JWKS client
    # still returns key1's public key -> signature verification must fail.
    key_wrong = ec.generate_private_key(ec.SECP256R1())
    forged = _make_token(key_wrong, "test-key-1", USER_SUB)
    def verify_with_trusted_key(_):
        return SimpleNamespace(
            key=key1.public_key().public_bytes(
                serialization.Encoding.PEM,
                serialization.PublicFormat.SubjectPublicKeyInfo,
            )
        )

    auth_mod._get_jwks_client = lambda: SimpleNamespace(get_signing_key_from_jwt=verify_with_trusted_key)
    try:
        auth_mod.get_authenticated_user(SimpleNamespace(headers={"Authorization": f"Bearer {forged}"}))
        raise AssertionError("forged-key token was accepted")
    except Exception as exc:
        assert getattr(exc, "status_code", None) == 401
    print("[4b] get_authenticated_user 401 on forged (wrong-key) token OK")


def test_jwks_url_derived():
    """(5) JWKS URL is derived from SUPABASE_URL (public), no secret value."""
    base = (settings.SUPABASE_URL or "").rstrip("/")
    expected = f"{base}/auth/v1/.well-known/jwks.json"
    src = (ROOT / "app/core/auth.py").read_text(encoding="utf-8")
    assert "SUPABASE_URL" in src and "auth/v1/.well-known/jwks.json" in src
    # No SUPABASE_JWT_SECRET *setting* (all-caps env var) exists; HS256 is not used.
    assert "SUPABASE_JWT_SECRET" not in src
    print(f"[5] JWKS URL = {expected!r} (derived from public SUPABASE_URL; no HS256 secret in module) OK")


if __name__ == "__main__":
    test_pyjwk_smoke_and_verify()
    test_auth_dependency()
    test_jwks_url_derived()
    print("ALL AUTH JWT TESTS PASSED")