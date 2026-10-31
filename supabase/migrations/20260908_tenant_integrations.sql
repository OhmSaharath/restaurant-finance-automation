-- =============================================================================
-- Supabase Migration: 20260908_tenant_integrations.sql
-- Description: Native Google OAuth / Gmail settlement ingestion pipeline.
-- Table: tenant_integrations (per-tenant, brand-scoped Google token store).
-- Replaces legacy Make.com webhooks with an in-house Gmail ingestion pipeline.
-- =============================================================================

-- 1. Table: tenant_integrations
-- Stores encrypted OAuth refresh tokens per (brand_id, provider) so settlement
-- emails from Grab / LINE MAN can be pulled and reconciled without external
-- Make.com webhooks. Refresh tokens are stored ONLY encrypted (AES-256-GCM)
-- via server-side code; plaintext tokens are never persisted.
CREATE TABLE IF NOT EXISTS public.tenant_integrations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_id UUID NOT NULL REFERENCES public.brands(id) ON DELETE CASCADE,
    provider TEXT NOT NULL DEFAULT 'google_gmail'
        CHECK (provider IN ('google_gmail')),
    encrypted_refresh_token TEXT NOT NULL,
    email_address TEXT NOT NULL,
    sync_status TEXT NOT NULL DEFAULT 'idle'
        CHECK (sync_status IN ('idle', 'syncing', 'error')),
    last_synced_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_tenant_integrations_brand_provider UNIQUE (brand_id, provider)
);

COMMENT ON TABLE public.tenant_integrations IS
    'Brand-scoped Google/Gmail OAuth integration: encrypted refresh token + last sync metadata.';

COMMENT ON COLUMN public.tenant_integrations.encrypted_refresh_token IS
    'AES-256-GCM ciphertext of the Google OAuth refresh_token (never plaintext).';

-- 2. Index on the tenant isolation key
CREATE INDEX IF NOT EXISTS idx_tenant_integrations_brand_id
    ON public.tenant_integrations (brand_id);

-- 3. Row Level Security
ALTER TABLE public.tenant_integrations ENABLE ROW LEVEL SECURITY;

-- 3.1 Authenticated users: SELECT + DELETE only for their own tenant brand(s)
--     (membership is derived from public.brand_users via get_user_brand_ids()).
--     No INSERT/UPDATE policy is granted to authenticated — token writes are
--     restricted to the server-side Service Role client only.
CREATE POLICY "tenant_integrations_select_tenant"
    ON public.tenant_integrations FOR SELECT TO authenticated
    USING (brand_id IN (SELECT public.get_user_brand_ids()));

CREATE POLICY "tenant_integrations_delete_tenant"
    ON public.tenant_integrations FOR DELETE TO authenticated
    USING (brand_id IN (SELECT public.get_user_brand_ids()));

-- 3.2 Service Role: full CRUD for server-side OAuth token upsert + sync workers
CREATE POLICY "tenant_integrations_service_role_all"
    ON public.tenant_integrations FOR ALL TO service_role
    USING (true) WITH CHECK (true);

-- REVOKE default grants so no role bypasses RLS by implicit table privileges
REVOKE ALL ON public.tenant_integrations FROM PUBLIC;
REVOKE ALL ON public.tenant_integrations FROM anon;

-- =============================================================================
-- DOWN MIGRATION (rollback):
--   DROP POLICY IF EXISTS "tenant_integrations_service_role_all"  ON public.tenant_integrations;
--   DROP POLICY IF EXISTS "tenant_integrations_delete_tenant"     ON public.tenant_integrations;
--   DROP POLICY IF EXISTS "tenant_integrations_select_tenant"     ON public.tenant_integrations;
--   ALTER TABLE public.tenant_integrations DISABLE ROW LEVEL SECURITY;
--   DROP TABLE IF EXISTS public.tenant_integrations;
-- =============================================================================