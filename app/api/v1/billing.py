"""Stripe subscription billing endpoints (Phase: backend-only).

POST /api/v1/billing/checkout     create (or reuse) a Stripe Customer, then a
                                  Checkout Session for the per-branch price.
POST /api/v1/billing/portal       create a Billing Portal session for the brand.
POST /api/v1/billing/webhook      Stripe webhook (auth = Stripe-Signature, NOT
                                  the shared X-API-Key). Syncs subscription state.
GET  /api/v1/billing/subscription return the brand's subscription row.

Guardrails:
  * Data isolation — every DB read/write is brand-scoped (eq brand_id). Webhook
    rows are resolved ONLY from event metadata.brand_id; invoice events (which
    carry no brand metadata) are resolved against our own brand-bound rows by
    stripe_subscription_id / stripe_customer_id — never a fabricated brand.
  * Secrets — STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET come from settings/env
    only, never hardcoded, never logged.
  * Rate limiting — non-webhook endpoints use JWT auth (get_authenticated_user)
    + @limiter.limit. The webhook uses Stripe-Signature auth (not the shared key) and is rate-limited
    conservatively so Stripe retries are not throttled.
  * Money is NOT computed here — the per-branch price lives in the Stripe
    dashboard; this layer only passes the active-branch count as quantity.
"""
import logging
from datetime import datetime, timezone
from typing import Any, Dict, Optional

import stripe
from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field

from app.core.auth import (
    get_authenticated_user,
    get_tenant_scope,
    require_write_access,
    resolve_brand_id_from_scope,
)
from app.core.config import settings
from app.core.database import get_supabase_client
from app.core.rate_limit import limiter

logger = logging.getLogger("billing")

router = APIRouter(prefix="/billing", tags=["Billing"])

# Stripe subscription statuses we persist (subset of Stripe's own statuses).
_ACTIVE_STATUSES = {"active", "trialing"}


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------
class CheckoutRequest(BaseModel):
    brand_id: str = Field(min_length=1)
    price_id: Optional[str] = None
    success_url: Optional[str] = None
    cancel_url: Optional[str] = None


class PortalRequest(BaseModel):
    brand_id: str = Field(min_length=1)
    return_url: Optional[str] = None


class SubscriptionQuery(BaseModel):
    brand_id: str = Field(min_length=1)


class UrlResponse(BaseModel):
    url: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _stripe() -> Any:
    """Return the stripe module with the secret key applied from settings.

    Raises 503 when STRIPE_SECRET_KEY is not configured (server misconfig, not
    a client error). The key is read from settings/env only and never logged.
    """
    key = (settings.STRIPE_SECRET_KEY or "").strip()
    if not key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "error": "STRIPE_NOT_CONFIGURED",
                "message": "STRIPE_SECRET_KEY is not configured on the server.",
            },
        )
    stripe.api_key = key
    return stripe


def _db() -> Any:
    client = get_supabase_client()
    if client is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"error": "DB_UNAVAILABLE", "message": "Database client unavailable."},
        )
    return client


def _dt_from_epoch(ts: Any) -> Optional[str]:
    """Convert a Stripe unix-epoch timestamp to an ISO-8601 UTC string."""
    if ts is None:
        return None
    try:
        return datetime.fromtimestamp(int(ts), tz=timezone.utc).isoformat()
    except (TypeError, ValueError, OSError, OverflowError):
        return None


def _meta_brand_id(obj: Dict[str, Any]) -> Optional[str]:
    """Return brand_id from an event object's metadata, or None if unkeyed."""
    meta = obj.get("metadata") or {}
    brand = (meta.get("brand_id") or "").strip()
    return brand or None


def _load_subscription(db: Any, brand_id: str) -> Optional[Dict[str, Any]]:
    """Fetch the subscriptions row for a brand (strictly brand-scoped)."""
    try:
        resp = (
            db.table("subscriptions")
            .select("*")
            .eq("brand_id", brand_id)
            .limit(1)
            .execute()
        )
        rows = resp.data or []
        return dict(rows[0]) if rows else None
    except Exception as exc:  # noqa: BLE001
        logger.error(f"[BILLING] subscription read failed for brand {brand_id}: {exc}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"error": "DB_READ_FAILED", "message": "Could not read subscriptions."},
        )


def _upsert_subscription(db: Any, brand_id: str, payload: Dict[str, Any]) -> None:
    """Upsert a subscriptions row keyed on brand_id (idempotent)."""
    try:
        db.table("subscriptions").upsert(
            {"brand_id": brand_id, **payload}, on_conflict="brand_id"
        ).execute()
    except Exception as exc:  # noqa: BLE001
        logger.error(f"[BILLING] subscription upsert failed for brand {brand_id}: {exc}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"error": "DB_WRITE_FAILED", "message": "Could not write subscriptions."},
        )


def _apply_guard(db: Any, brand_id: str, event_created: Optional[str]) -> bool:
    """Return True when the event is at least as new as the last applied event.

    Stripe does not guarantee event ordering under retry, so a stale retry must
    not overwrite a newer status (e.g. a late "active" after "canceled"). Compare
    parsed datetimes (not lexicographic strings) to be robust to any timestamptz
    serialization variance.
    """
    if not event_created:
        return True
    row = _load_subscription(db, brand_id)
    last = (row or {}).get("last_event_created")
    if not last:
        return True
    try:
        event_dt = datetime.fromisoformat(str(event_created).replace("Z", "+00:00"))
        last_dt = datetime.fromisoformat(str(last).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return True  # unparseable timestamp -> do not block the event
    return event_dt >= last_dt


def _resolve_brand_for_subscription(db: Any, sub_obj: Dict[str, Any]) -> Optional[str]:
    """Resolve the brand for a subscription event.

    Precedence: (1) event metadata.brand_id (keyed event), (2) our own
    subscriptions row matched by stripe_subscription_id, (3) matched by
    stripe_customer_id. All lookups are against rows we previously bound to a
    brand via keyed events — never a fabricated brand.
    """
    brand = _meta_brand_id(sub_obj)
    if brand:
        return brand

    # Subscription objects expose their id at "id"; invoice objects expose the
    # subscription id at "subscription". Prefer "subscription" first so invoice
    # events (invoice.paid / payment_failed) resolve correctly.
    sub_id = (sub_obj.get("subscription") or sub_obj.get("id") or "").strip()
    customer_id = (sub_obj.get("customer") or "").strip()
    try:
        if sub_id:
            resp = (
                db.table("subscriptions")
                .select("brand_id")
                .eq("stripe_subscription_id", sub_id)
                .limit(1)
                .execute()
            )
            if resp.data:
                return resp.data[0]["brand_id"]
        if customer_id:
            resp = (
                db.table("subscriptions")
                .select("brand_id")
                .eq("stripe_customer_id", customer_id)
                .limit(1)
                .execute()
            )
            if resp.data:
                return resp.data[0]["brand_id"]
    except Exception as exc:  # noqa: BLE001
        logger.error(f"[BILLING] brand resolution failed: {exc}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"error": "DB_READ_FAILED", "message": "Could not resolve brand."},
        )
    return None


def _subscription_payload(sub_obj: Dict[str, Any]) -> Dict[str, Any]:
    """Build the subscriptions row payload from a Stripe subscription object."""
    payload: Dict[str, Any] = {
        "stripe_subscription_id": (sub_obj.get("id") or "").strip() or None,
        "status": (sub_obj.get("status") or "").strip() or None,
        "trial_end": _dt_from_epoch(sub_obj.get("trial_end")),
        "current_period_start": _dt_from_epoch(sub_obj.get("current_period_start")),
        "current_period_end": _dt_from_epoch(sub_obj.get("current_period_end")),
    }
    items = sub_obj.get("items") or {}
    data = items.get("data") or []
    if data:
        qty = data[0].get("quantity")
        if qty is not None:
            try:
                payload["branch_quantity"] = max(int(qty), 1)
            except (TypeError, ValueError):
                pass
    return payload


# ---------------------------------------------------------------------------
# POST /billing/checkout
# ---------------------------------------------------------------------------
@router.post(
    "/checkout",
    response_model=UrlResponse,
    status_code=status.HTTP_200_OK,
    summary="Create a Stripe Checkout Session for a brand's subscription",
)
@limiter.limit(settings.RATE_LIMIT_PER_MINUTE)
async def create_checkout_session(
    request: Request,
    body: CheckoutRequest,
    user_id: str = Depends(get_authenticated_user),
) -> UrlResponse:
    db = _db()
    # Billing mutations (creating a checkout session) are write operations.
    # Partners are intentionally read-only and must not be able to start a
    # subscription or create a new Stripe customer.
    require_write_access(db, user_id)

    # Tenant scope is DERIVED server-side from the authenticated user's
    # brand_users rows — never from a client field. The client brand_id is a
    # SELECTOR honored ONLY when it is a member of that scope (never widening);
    # an absent/blank selector resolves to the user's primary brand.
    _scope_user_id, tenant_brand_ids = get_tenant_scope(db, user_id)
    if not tenant_brand_ids:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "error": "NO_TENANT_BRAND",
                "message": "Authenticated user has no linked brand (brand_users).",
            },
        )
    brand_id = resolve_brand_id_from_scope(tenant_brand_ids, body.brand_id)
    if brand_id is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "error": "BRAND_NOT_IN_SCOPE",
                "message": "Requested brand_id is not a member of your tenant scope.",
            },
        )

    # Resolve the price id: explicit body value, else the env-configured default.
    price_id = (body.price_id or "").strip() or (settings.STRIPE_PRICE_ID or "").strip()
    if not price_id:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "error": "PRICE_NOT_CONFIGURED",
                "message": "No price_id provided and STRIPE_PRICE_ID is not configured.",
            },
        )

    # Usage-based quantity = number of active branches (never below 1).
    try:
        branches = (
            db.table("branches")
            .select("id")
            .eq("brand_id", brand_id)
            .eq("is_active", True)
            .execute()
        )
    except Exception as exc:  # noqa: BLE001
        logger.error(f"[BILLING] branch count failed for brand {brand_id}: {exc}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"error": "DB_READ_FAILED", "message": "Could not count branches."},
        )
    quantity = max(len(branches.data or []), 1)

    # Ensure a Stripe Customer exists for the brand.
    existing = _load_subscription(db, brand_id)
    customer_id = (existing or {}).get("stripe_customer_id") or ""
    if not customer_id:
        s = _stripe()
        try:
            customer = s.Customer.create(metadata={"brand_id": brand_id}).to_dict()
        except stripe.error.StripeError as exc:  # noqa: BLE001
            logger.error(f"[BILLING] customer create failed for brand {brand_id}: {exc}")
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail={"error": "STRIPE_ERROR", "message": "Could not create Stripe customer."},
            )
        customer_id = customer.get("id")
        _upsert_subscription(db, brand_id, {"stripe_customer_id": customer_id})

    # Redirect URLs: body value overrides the env-configured default.
    success_url = (body.success_url or "").strip() or (settings.STRIPE_SUCCESS_URL or "").strip()
    cancel_url = (body.cancel_url or "").strip() or (settings.STRIPE_CANCEL_URL or "").strip()
    if not success_url:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "error": "MISSING_SUCCESS_URL",
                "message": "success_url is required (Stripe requires an absolute URL).",
            },
        )

    s = _stripe()
    try:
        session = s.checkout.Session.create(
            mode="subscription",
            customer=customer_id,
            line_items=[{"price": price_id, "quantity": quantity}],
            subscription_data={
                "trial_period_days": 30,
                "metadata": {"brand_id": brand_id},
            },
            success_url=success_url,
            cancel_url=cancel_url or success_url,
            metadata={"brand_id": brand_id},
        ).to_dict()
    except stripe.error.StripeError as exc:  # noqa: BLE001
        logger.error(f"[BILLING] checkout session create failed for brand {brand_id}: {exc}")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={"error": "STRIPE_ERROR", "message": "Could not create Checkout Session."},
        )

    return UrlResponse(url=session.get("url") or "")


# ---------------------------------------------------------------------------
# POST /billing/portal
# ---------------------------------------------------------------------------
@router.post(
    "/portal",
    response_model=UrlResponse,
    status_code=status.HTTP_200_OK,
    summary="Create a Stripe Billing Portal session for a brand",
)
@limiter.limit(settings.RATE_LIMIT_PER_MINUTE)
async def create_billing_portal(
    request: Request,
    body: PortalRequest,
    user_id: str = Depends(get_authenticated_user),
) -> UrlResponse:
    db = _db()
    # Opening the portal permits subscription/payment changes, so it is also
    # restricted to owner/admin/manager/accountant roles (not partners).
    require_write_access(db, user_id)

    # Tenant scope derived server-side (GROUP 2 membership-checked selector).
    _scope_user_id, tenant_brand_ids = get_tenant_scope(db, user_id)
    if not tenant_brand_ids:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "error": "NO_TENANT_BRAND",
                "message": "Authenticated user has no linked brand (brand_users).",
            },
        )
    brand_id = resolve_brand_id_from_scope(tenant_brand_ids, body.brand_id)
    if brand_id is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "error": "BRAND_NOT_IN_SCOPE",
                "message": "Requested brand_id is not a member of your tenant scope.",
            },
        )

    existing = _load_subscription(db, brand_id)
    customer_id = (existing or {}).get("stripe_customer_id") or ""
    if not customer_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "error": "NO_STRIPE_CUSTOMER",
                "message": "No Stripe customer exists for this brand yet.",
            },
        )

    s = _stripe()
    try:
        session = s.billing_portal.Session.create(
            customer=customer_id,
            return_url=(body.return_url or "").strip() or None,
        ).to_dict()
    except stripe.error.StripeError as exc:  # noqa: BLE001
        logger.error(f"[BILLING] portal session create failed for brand {brand_id}: {exc}")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={"error": "STRIPE_ERROR", "message": "Could not create Billing Portal session."},
        )

    return UrlResponse(url=session.get("url") or "")


# ---------------------------------------------------------------------------
# POST /billing/webhook  (auth = Stripe-Signature, NOT the shared API key)
# ---------------------------------------------------------------------------
@router.post(
    "/webhook",
    status_code=status.HTTP_200_OK,
    summary="Stripe webhook — sync subscription state (Stripe-Signature auth)",
)
@limiter.limit("300/minute")
async def stripe_webhook(request: Request) -> Dict[str, Any]:
    payload = await request.body()
    sig_header = request.headers.get("Stripe-Signature", "")

    secret = (settings.STRIPE_WEBHOOK_SECRET or "").strip()
    if not secret:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "error": "WEBHOOK_NOT_CONFIGURED",
                "message": "STRIPE_WEBHOOK_SECRET is not configured on the server.",
            },
        )

    try:
        event = stripe.Webhook.construct_event(payload, sig_header, secret)
    except stripe.error.SignatureVerificationError:
        # Bad signature -> 400 (NOT 500) so Stripe stops retrying a spoofed/
        # misconfigured signature forever.
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": "INVALID_SIGNATURE", "message": "Invalid Stripe signature."},
        )

    # construct_event returns a stripe.Event object (not a dict) in this lib
    # version; normalize to a plain dict so the handlers below can use .get().
    event = event.to_dict()

    db = _db()
    event_type = event.get("type", "")
    obj = event.get("data", {}).get("object", {}) or {}

    # Event-id dedup: a duplicate delivery acks 200 without reprocessing.
    event_id = event.get("id", "")
    event_created = _dt_from_epoch(event.get("created"))
    if event_id:
        resp = db.table("webhook_events").upsert(
            {
                "event_id": event_id,
                "event_type": event.get("type", ""),
                "event_created": event_created,
            },
            on_conflict="event_id",
            ignore_duplicates=True,
        ).execute()
        if not resp.data:  # UNIQUE(event_id) conflict => already handled
            return {"received": True, "duplicate": True}

    try:
        if event_type == "checkout.session.completed":
            _handle_checkout_completed(db, obj, event_created)
        elif event_type in ("customer.subscription.created", "customer.subscription.updated"):
            _handle_subscription_upsert(db, obj, event_created)
        elif event_type == "customer.subscription.deleted":
            _handle_subscription_deleted(db, obj, event_created)
        elif event_type == "invoice.paid":
            _handle_invoice_paid(db, obj, event_created)
        elif event_type == "invoice.payment_failed":
            _handle_invoice_payment_failed(db, obj, event_created)
        elif event_type == "customer.created":
            _handle_customer_created(db, obj, event_created)
        else:
            logger.info(f"[BILLING] unhandled event type: {event_type}")
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        # Transient DB/processing failure -> let it bubble to the 500 handler so
        # Stripe retries. Signature failures are already handled above as 400.
        logger.error(f"[BILLING] webhook processing failed for {event_type}: {exc}")
        raise

    return {"received": True}


def _handle_checkout_completed(db: Any, obj: Dict[str, Any], event_created: Optional[str] = None) -> None:
    """checkout.session.completed -> persist customer + subscription (no status)."""
    brand_id = _meta_brand_id(obj)
    if not brand_id:
        logger.warning("[BILLING] checkout.session.completed without brand_id metadata; skipped.")
        return
    if not _apply_guard(db, brand_id, event_created):
        logger.info(f"[BILLING] stale checkout event skipped for brand {brand_id}")
        return
    payload: Dict[str, Any] = {
        "stripe_customer_id": (obj.get("customer") or "").strip() or None,
        "stripe_subscription_id": (obj.get("subscription") or "").strip() or None,
        "last_event_created": event_created,
    }
    # NOTE: status is deliberately NOT set here. The subscription is "trialing"
    # for 30 days, so checkout.session.completed must not overwrite it with
    # "active" — the customer.subscription.* events carry the authoritative status.
    _upsert_subscription(db, brand_id, payload)


def _handle_subscription_upsert(db: Any, obj: Dict[str, Any], event_created: Optional[str] = None) -> None:
    """customer.subscription.created/updated -> upsert subscription state."""
    brand_id = _resolve_brand_for_subscription(db, obj)
    if not brand_id:
        logger.warning("[BILLING] subscription event unkeyed and unresolvable; skipped.")
        return
    if not _apply_guard(db, brand_id, event_created):
        logger.info(f"[BILLING] stale subscription event skipped for brand {brand_id}")
        return
    payload = _subscription_payload(obj)
    payload["last_event_created"] = event_created
    _upsert_subscription(db, brand_id, payload)


def _handle_subscription_deleted(db: Any, obj: Dict[str, Any], event_created: Optional[str] = None) -> None:
    """customer.subscription.deleted -> status canceled."""
    brand_id = _resolve_brand_for_subscription(db, obj)
    if not brand_id:
        logger.warning("[BILLING] subscription.deleted unkeyed and unresolvable; skipped.")
        return
    if not _apply_guard(db, brand_id, event_created):
        logger.info(f"[BILLING] stale subscription.deleted skipped for brand {brand_id}")
        return
    _upsert_subscription(db, brand_id, {"status": "canceled", "last_event_created": event_created})


def _handle_invoice_paid(db: Any, obj: Dict[str, Any], event_created: Optional[str] = None) -> None:
    """invoice.paid -> status active (+ persist period dates if present)."""
    brand_id = _resolve_brand_for_subscription(db, obj)
    if not brand_id:
        logger.warning("[BILLING] invoice.paid unkeyed and unresolvable; skipped.")
        return
    if not _apply_guard(db, brand_id, event_created):
        logger.info(f"[BILLING] stale invoice.paid skipped for brand {brand_id}")
        return
    payload: Dict[str, Any] = {"status": "active", "last_event_created": event_created}
    period_start = _dt_from_epoch(obj.get("period_start"))
    period_end = _dt_from_epoch(obj.get("period_end"))
    if period_start:
        payload["current_period_start"] = period_start
    if period_end:
        payload["current_period_end"] = period_end
    _upsert_subscription(db, brand_id, payload)


def _handle_invoice_payment_failed(db: Any, obj: Dict[str, Any], event_created: Optional[str] = None) -> None:
    """invoice.payment_failed -> status past_due."""
    brand_id = _resolve_brand_for_subscription(db, obj)
    if not brand_id:
        logger.warning("[BILLING] invoice.payment_failed unkeyed and unresolvable; skipped.")
        return
    if not _apply_guard(db, brand_id, event_created):
        logger.info(f"[BILLING] stale invoice.payment_failed skipped for brand {brand_id}")
        return
    _upsert_subscription(db, brand_id, {"status": "past_due", "last_event_created": event_created})


def _handle_customer_created(db: Any, obj: Dict[str, Any], event_created: Optional[str] = None) -> None:
    """customer.created -> persist stripe_customer_id (keyed by brand_id only)."""
    brand_id = _meta_brand_id(obj)
    if not brand_id:
        logger.info("[BILLING] customer.created without brand_id metadata; best-effort no-op.")
        return
    customer_id = (obj.get("id") or "").strip()
    if not customer_id:
        return
    if not _apply_guard(db, brand_id, event_created):
        logger.info(f"[BILLING] stale customer.created skipped for brand {brand_id}")
        return
    _upsert_subscription(db, brand_id, {"stripe_customer_id": customer_id, "last_event_created": event_created})


# ---------------------------------------------------------------------------
# GET /billing/subscription
# ---------------------------------------------------------------------------
@router.get(
    "/subscription",
    status_code=status.HTTP_200_OK,
    summary="Return the brand's current subscription",
)
@limiter.limit(settings.RATE_LIMIT_PER_MINUTE)
async def get_subscription(
    request: Request,
    brand_id: str,
    user_id: str = Depends(get_authenticated_user),
) -> Dict[str, Any]:
    db = _db()

    # Tenant scope derived server-side (GROUP 2 membership-checked selector).
    _scope_user_id, tenant_brand_ids = get_tenant_scope(db, user_id)
    if not tenant_brand_ids:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "error": "NO_TENANT_BRAND",
                "message": "Authenticated user has no linked brand (brand_users).",
            },
        )
    resolved_brand = resolve_brand_id_from_scope(tenant_brand_ids, brand_id)
    if resolved_brand is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "error": "BRAND_NOT_IN_SCOPE",
                "message": "Requested brand_id is not a member of your tenant scope.",
            },
        )
    brand_id = resolved_brand
    row = _load_subscription(db, brand_id)
    if row is None:
        return {"status": "none"}
    return row
