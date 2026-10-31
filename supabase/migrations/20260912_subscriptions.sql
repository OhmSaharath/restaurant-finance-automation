-- =============================================================================
-- Supabase Migration: 20260912_subscriptions.sql
-- Description: Stripe subscription billing — one row per brand (tenant-scoped,
--   RLS mirrors brands). Usage-based quantity = active branch count; money
--   flows brand -> platform only (no Stripe Connect).
-- Table: public.subscriptions
-- Fixed design decisions (from docs/stripe_integration_plan.md):
--   * One subscription per brand (UNIQUE brand_id); plan_key is a single
--     "starter" plan for now, priced per-branch (99 THB / month / branch).
--   * status values: active|trialing|past_due|canceled|incomplete.
--   * RLS: authenticated sees own brand rows via get_user_brand_ids();
--     service_role bypasses (server-side webhook writes use the service role).
--   * handle_updated_at() trigger (defined in db/01_init_schema.sql) keeps
--     updated_at fresh on every UPDATE.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Table: subscriptions
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_id UUID NOT NULL REFERENCES public.brands(id) ON DELETE CASCADE,
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    plan_key TEXT,
    status TEXT,
    branch_quantity INTEGER NOT NULL DEFAULT 1,
    trial_end TIMESTAMPTZ,
    current_period_start TIMESTAMPTZ,
    current_period_end TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_subscriptions_brand UNIQUE (brand_id)
);

COMMENT ON TABLE public.subscriptions IS
    'Stripe subscription per brand (usage-based quantity = active branch count).';
COMMENT ON COLUMN public.subscriptions.brand_id IS
    'Foreign key reference to tenant brand (one subscription per brand).';
COMMENT ON COLUMN public.subscriptions.stripe_customer_id IS
    'Stripe Customer id (cus_...) for the brand.';
COMMENT ON COLUMN public.subscriptions.stripe_subscription_id IS
    'Stripe Subscription id (sub_...) for the brand.';
COMMENT ON COLUMN public.subscriptions.plan_key IS
    'Plan identifier, e.g. starter (single plan for now).';
COMMENT ON COLUMN public.subscriptions.status IS
    'Subscription status: active|trialing|past_due|canceled|incomplete.';
COMMENT ON COLUMN public.subscriptions.branch_quantity IS
    'Usage-based quantity = number of active branches (priced per branch).';
COMMENT ON COLUMN public.subscriptions.trial_end IS
    'End of the 30-day free trial (NULL once the trial is over).';
COMMENT ON COLUMN public.subscriptions.current_period_start IS
    'Start of the current billing period.';
COMMENT ON COLUMN public.subscriptions.current_period_end IS
    'End of the current billing period.';
COMMENT ON CONSTRAINT uq_subscriptions_brand ON public.subscriptions IS
    'Ensures at most one subscription row per brand.';

-- -----------------------------------------------------------------------------
-- 2. Index on the tenant isolation key
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_subscriptions_brand_id
    ON public.subscriptions (brand_id);

-- -----------------------------------------------------------------------------
-- 3. Automatic updated_at trigger (handle_updated_at defined in 01_init_schema)
-- -----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_subscriptions_updated_at ON public.subscriptions;
CREATE TRIGGER trg_subscriptions_updated_at
    BEFORE UPDATE ON public.subscriptions
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_updated_at();

-- -----------------------------------------------------------------------------
-- 4. Row Level Security (mirrors brands / tenant_integrations)
-- -----------------------------------------------------------------------------
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

-- 4.1 Authenticated users: SELECT only for their own tenant brand(s).
--      No INSERT/UPDATE/DELETE policy is granted to authenticated — subscription
--      writes are restricted to the server-side Service Role client (webhook
--      sync + checkout persistence) only.
CREATE POLICY "subscriptions_select_tenant"
    ON public.subscriptions FOR SELECT TO authenticated
    USING (brand_id IN (SELECT public.get_user_brand_ids()));

-- 4.2 Service Role: full CRUD for server-side Stripe webhook sync + checkout.
CREATE POLICY "subscriptions_service_role_all"
    ON public.subscriptions FOR ALL TO service_role
    USING (true) WITH CHECK (true);

-- REVOKE default grants so no role bypasses RLS by implicit table privileges
REVOKE ALL ON public.subscriptions FROM PUBLIC;
REVOKE ALL ON public.subscriptions FROM anon;

-- =============================================================================
-- DOWN MIGRATION (rollback):
--   DROP POLICY IF EXISTS "subscriptions_service_role_all" ON public.subscriptions;
--   DROP POLICY IF EXISTS "subscriptions_select_tenant"     ON public.subscriptions;
--   ALTER TABLE public.subscriptions DISABLE ROW LEVEL SECURITY;
--   DROP TRIGGER IF EXISTS trg_subscriptions_updated_at ON public.subscriptions;
--   DROP TABLE IF EXISTS public.subscriptions;
-- =============================================================================
