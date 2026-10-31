-- =============================================================================
-- Supabase Migration: 20260913_loyverse_config.sql
-- Description: Loyverse in-store ("storefront") revenue integration config.
-- Table: loyverse_config (per-tenant, brand-scoped Loyverse token + mapping).
-- Phase 1: token storage + store<->branch mapping + VAT toggle/rate. No receipt
-- ingestion yet (receipt sync is a later phase).
-- =============================================================================

-- 1. Table: loyverse_config
-- One row per brand. Stores the Loyverse Personal Access Token ONLY encrypted
-- (AES-256-GCM, via the shared encryptSecret helper in web/lib/gmail/crypto.ts)
-- plus the store<->branch mapping and per-storeframe VAT toggle/rate. The token
-- ciphertext is never plaintext; the raw token is never readable via RLS or any
-- GET/status route (metadata only).
CREATE TABLE IF NOT EXISTS public.loyverse_config (
    brand_id UUID PRIMARY KEY REFERENCES public.brands(id) ON DELETE CASCADE,
    encrypted_access_token TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true,
    vat_enabled BOOLEAN NOT NULL DEFAULT false,
    vat_rate NUMERIC(5,2) NULL,
    store_branch_map JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.loyverse_config IS
    'Brand-scoped Loyverse integration config: AES-256-GCM encrypted access token, per-store branch mapping, and VAT toggle/rate for in-store revenue.';

COMMENT ON COLUMN public.loyverse_config.encrypted_access_token IS
    'AES-256-GCM ciphertext of the Loyverse Personal Access Token (never plaintext, never returned by any read route).';

COMMENT ON COLUMN public.loyverse_config.vat_enabled IS
    'Whether in-store revenue is subject to VAT in this brand''s reports.';

COMMENT ON COLUMN public.loyverse_config.vat_rate IS
    'Owner-entered VAT percentage, e.g. 7.00 (Thailand). NULL means no VAT applies.';

COMMENT ON COLUMN public.loyverse_config.store_branch_map IS
    'JSONB array of { store_id, store_name, branch_id } mapping each Loyverse store to one of our branches.';

-- 2. Index on the tenant isolation key (PK already covers brand_id; explicit
--    index added for clarity / query planning consistency).
CREATE INDEX IF NOT EXISTS idx_loyverse_config_brand_id
    ON public.loyverse_config (brand_id);

-- 3. Row Level Security
ALTER TABLE public.loyverse_config ENABLE ROW LEVEL SECURITY;

-- 3.1 Authenticated users: SELECT + DELETE only for their own tenant brand(s)
--     (membership is derived from public.brand_users via get_user_brand_ids()).
--     No INSERT/UPDATE policy is granted to authenticated — token + map writes
--     are restricted to the server-side Service Role client only.
CREATE POLICY "loyverse_config_select_tenant"
    ON public.loyverse_config FOR SELECT TO authenticated
    USING (brand_id IN (SELECT public.get_user_brand_ids()));

CREATE POLICY "loyverse_config_delete_tenant"
    ON public.loyverse_config FOR DELETE TO authenticated
    USING (brand_id IN (SELECT public.get_user_brand_ids()));

-- 3.2 Service Role: full CRUD for server-side token upsert + config writes
CREATE POLICY "loyverse_config_service_role_all"
    ON public.loyverse_config FOR ALL TO service_role
    USING (true) WITH CHECK (true);

-- REVOKE default grants so no role bypasses RLS by implicit table privileges
REVOKE ALL ON public.loyverse_config FROM PUBLIC;
REVOKE ALL ON public.loyverse_config FROM anon;

-- =============================================================================
-- DOWN MIGRATION (rollback):
--   DROP POLICY IF EXISTS "loyverse_config_service_role_all"  ON public.loyverse_config;
--   DROP POLICY IF EXISTS "loyverse_config_delete_tenant"     ON public.loyverse_config;
--   DROP POLICY IF EXISTS "loyverse_config_select_tenant"     ON public.loyverse_config;
--   ALTER TABLE public.loyverse_config DISABLE ROW LEVEL SECURITY;
--   DROP TABLE IF EXISTS public.loyverse_config;
-- =============================================================================
