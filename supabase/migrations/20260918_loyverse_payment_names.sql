-- Add per-brand in-store payment method allowlist to loyverse_config.
-- Each restaurant declares its OWN in-store payment method names (e.g. "Cash",
-- "ถุงเงิน", "QR Promtpay", "ไทยช่วยไทย(หน้าร้าน)") as a JSONB array of strings.
-- NULL/empty means "use the backend DEFAULT_INSTORE_PAYMENT_NAMES fallback",
-- so existing tenants keep working without any data change.
-- This keeps the filter MULTI-TENANT: no single hardcoded list is shared.

ALTER TABLE loyverse_config
    ADD COLUMN IF NOT EXISTS payment_names JSONB;

COMMENT ON COLUMN loyverse_config.payment_names IS
    'Per-brand allowlist of Loyverse payment-method names that count as in-store (front-of-house) sales. Online E-Payment names (Lineman/Grabfood/Robinhood/Shoppee) are excluded so they are not double-counted against the Gmail settlement pipeline. NULL/empty falls back to DEFAULT_INSTORE_PAYMENT_NAMES.';