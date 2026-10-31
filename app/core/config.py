import os
from pathlib import Path
from typing import Optional

from pydantic_settings import BaseSettings, SettingsConfigDict


def _fallback_key(name: str) -> Optional[str]:
    """Read a secret from web/.env.local as a development fallback.

    Precedence: real environment variable > project-root .env (via Settings) >
    web/.env.local (Next.js env file, which holds the same secrets the OAuth /
    Pub/Sub / Stripe pipelines use), so the back-end and the Next.js app never
    drift on the credentials they derive from it.
    """
    env_val = os.environ.get(name)
    if env_val and env_val.strip():
        return env_val.strip()

    # Look up the repo tree for web/.env.local relative to this file, and also
    # allow an explicit override path.
    candidates = [
        Path(os.environ.get("WEB_ENV_FILE", "")),
        Path(__file__).resolve().parent.parent.parent / "web" / ".env.local",
        Path.cwd() / "web" / ".env.local",
    ]
    for p in candidates:
        if not p or not p.is_file():
            continue
        try:
            for raw in p.read_text(encoding="utf-8").splitlines():
                line = raw.strip()
                if line.startswith(name + "="):
                    val = line.split("=", 1)[1].strip().strip('"').strip("'")
                    if val:
                        return val
        except OSError:
            continue
    return None


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    PROJECT_NAME: str = "finance-delivery-project"
    VERSION: str = "0.2.0"
    ENVIRONMENT: str = "development"
    DEBUG: bool = False

    # Supabase Credentials (Read from environment variables)
    SUPABASE_URL: str = ""
    SUPABASE_SERVICE_ROLE_KEY: str = ""

    # Native Google OAuth / Gmail Pub/Sub push pipeline (replaces Make.com).
    # All optional + empty default; resolved env-first then web/.env.local via
    # _fallback_key() so local dev keeps working. Never hardcode real secrets.
    GOOGLE_CLIENT_ID: Optional[str] = None
    GOOGLE_CLIENT_SECRET: Optional[str] = None
    # 32+ char server-only secret for AES-256-GCM token encryption + OAuth state HMAC.
    ENCRYPTION_KEY: Optional[str] = None
    # Full Pub/Sub topic string, e.g. "projects/<project-id>/topics/gmail-delivery-sync".
    GMAIL_PUBSUB_TOPIC: Optional[str] = None
    # Optional shared secret for the push webhook (X-Goog-Channel-Token). When
    # set (and GMAIL_PUBSUB_AUDIENCE is empty), a matching token is REQUIRED.
    GMAIL_PUBSUB_VERIFICATION_TOKEN: Optional[str] = None
    # Optional OIDC push-auth audience for the Pub/Sub webhook. When set (to
    # the PUBLIC webhook URL), an `Authorization: Bearer <jwt>` on the push is
    # REQUIRED and verified as a Google-signed OIDC token (issuer
    # accounts.google.com, audience == this value). When empty, OIDC is not
    # enforced. The webhook FAILS CLOSED: if NEITHER the audience NOR
    # GMAIL_PUBSUB_VERIFICATION_TOKEN is configured, every push is rejected
    # with 401. Env-only (never resolved from web/.env.local). Never a secret.
    GMAIL_PUBSUB_AUDIENCE: Optional[str] = None

    # OIDC audience for the cron-triggered "sync all Loyverse brands" endpoint
    # (/integrations/loyverse/cron-sync). This is the cron endpoint's PUBLIC URL
    # that Cloud Scheduler (via an OIDC token-using impersonation service
    # account) targets; the scheduler attaches an `Authorization: Bearer ***
    # Google-signed OIDC token whose audience must equal this value. Env-only
    # (never resolved from web/.env.local) and never a secret. When EMPTY the
    # cron endpoint FAILS CLOSED: every request is rejected with 401
    # (CRON_OIDC_NOT_CONFIGURED), so an unconfigured scheduler can never trigger
    # a cross-brand sync.
    LOYVERSE_CRON_AUDIENCE: Optional[str] = None

    # Stripe subscription billing (server-side). Stripe ID/secret resolved
    # env-first then web/.env.local via _fallback_key(), same as the other keys.
    # STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET are secrets — never hardcoded and
    # never logged. STRIPE_PRICE_ID is the single plan's per-branch price
    # (99 THB / month / branch, configured in the Stripe dashboard).
    STRIPE_SECRET_KEY: Optional[str] = None
    STRIPE_WEBHOOK_SECRET: Optional[str] = None
    STRIPE_PRICE_ID: Optional[str] = None
    # Absolute redirect URLs for Checkout (Stripe requires success_url to be
    # absolute). Optional — body values override these when provided.
    STRIPE_SUCCESS_URL: Optional[str] = None
    STRIPE_CANCEL_URL: Optional[str] = None

    # Rate Limiting
    RATE_LIMIT_PER_MINUTE: str = "30/minute"


settings = Settings()

# Resolve the native Google OAuth / Gmail Pub/Sub fields env-first, then from
# web/.env.local (same file the Next.js sync worker reads), so dev never has
# two divergent copies of the OAuth / crypto keys.
for _google_field in (
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "ENCRYPTION_KEY",
    "GMAIL_PUBSUB_TOPIC",
    "GMAIL_PUBSUB_VERIFICATION_TOKEN",
):
    if getattr(settings, _google_field) is None:
        setattr(settings, _google_field, _fallback_key(_google_field))

# Resolve Stripe billing keys env-first, then web/.env.local (dev fallback).
for _stripe_field in (
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_PRICE_ID",
    "STRIPE_SUCCESS_URL",
    "STRIPE_CANCEL_URL",
):
    if getattr(settings, _stripe_field) is None:
        setattr(settings, _stripe_field, _fallback_key(_stripe_field))
