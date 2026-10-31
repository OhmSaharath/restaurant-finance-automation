-- =============================================================================
-- Supabase Migration: 20260912_webhook_events.sql
-- Description: Event-id dedup + ordering guard for the Stripe webhook, so a
--   duplicate delivery is acked without reprocessing and a stale/out-of-order
--   retry never overwrites a newer subscription status.
-- Tables: webhook_events (new), subscriptions.last_event_created (new column)
-- =============================================================================

-- 1. Event receipt log (idempotency). Only the service role ever reads/writes
--    this — it is NOT tenant-visible, so no authenticated RLS policy.
CREATE TABLE IF NOT EXISTS public.webhook_events (
    id BIGSERIAL PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE,
    brand_id UUID REFERENCES public.brands(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    event_created TIMESTAMPTZ,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_event_id
    ON public.webhook_events (event_id);

ALTER TABLE public.webhook_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "webhook_events_service_role_all" ON public.webhook_events;
CREATE POLICY "webhook_events_service_role_all"
    ON public.webhook_events FOR ALL TO service_role
    USING (true) WITH CHECK (true);

REVOKE ALL ON public.webhook_events FROM PUBLIC;
REVOKE ALL ON public.webhook_events FROM anon;

-- 2. Ordering guard: track the latest applied event timestamp per subscription
--    so a stale retry is skipped.
ALTER TABLE public.subscriptions
    ADD COLUMN IF NOT EXISTS last_event_created TIMESTAMPTZ;

-- =============================================================================
-- DOWN MIGRATION (rollback):
--   ALTER TABLE public.subscriptions DROP COLUMN IF EXISTS last_event_created;
--   DROP TABLE IF EXISTS public.webhook_events;
-- =============================================================================
