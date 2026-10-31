-- =============================================================================
-- Migration: 001_initial_schema.sql
-- Description: Initial database schema for multi-tenant delivery finance system
-- Tables: brands, branches, brand_users, daily_reports
-- Features: Strict financial precision (NUMERIC 12,2), RLS data isolation,
--           idempotency constraints, performance indexes, and audit triggers.
-- =============================================================================

-- Ensure required extension for UUID generation is available
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- -----------------------------------------------------------------------------
-- 1. Table: brands (Top-level Tenant Entity)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.brands (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    tax_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.brands IS 'Top-level business/brand entity for multi-tenant data isolation.';
COMMENT ON COLUMN public.brands.id IS 'Primary key UUID generated automatically.';
COMMENT ON COLUMN public.brands.tax_id IS 'Official business tax identification number.';

-- -----------------------------------------------------------------------------
-- 2. Table: branches (Store / Location Entity)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.branches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_id UUID NOT NULL REFERENCES public.brands(id) ON DELETE CASCADE,
    branch_code TEXT NOT NULL,
    branch_name TEXT NOT NULL,
    address TEXT,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_branches_brand_id_branch_code UNIQUE (brand_id, branch_code)
);

COMMENT ON TABLE public.branches IS 'Individual store locations associated with a parent brand.';
COMMENT ON CONSTRAINT uq_branches_brand_id_branch_code ON public.branches IS 'Ensures branch code uniqueness within a single brand.';

-- -----------------------------------------------------------------------------
-- 3. Table: brand_users (Role-Based Access Control)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.brand_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    brand_id UUID NOT NULL REFERENCES public.brands(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'manager', 'accountant')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_brand_users_user_id_brand_id UNIQUE (user_id, brand_id)
);

COMMENT ON TABLE public.brand_users IS 'Mapping between Supabase Auth users and brands with assigned roles.';
COMMENT ON CONSTRAINT uq_brand_users_user_id_brand_id ON public.brand_users IS 'Enforces unique user assignment per brand.';

-- -----------------------------------------------------------------------------
-- 4. Table: daily_reports (Financial Delivery Platform Reports)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.daily_reports (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    branch_id UUID NOT NULL REFERENCES public.branches(id) ON DELETE RESTRICT,
    platform TEXT NOT NULL CHECK (platform IN ('Grab', 'LINE MAN', 'Shopee Food', 'Robinhood')),
    report_date DATE NOT NULL,
    shop_name_raw TEXT,
    order_count INTEGER NOT NULL DEFAULT 0 CHECK (order_count >= 0),
    gross_sales NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    deductions NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    net_sale NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_daily_reports_branch_platform_date UNIQUE (branch_id, platform, report_date)
);

COMMENT ON TABLE public.daily_reports IS 'Daily ingested settlement and financial data per platform and branch.';
COMMENT ON COLUMN public.daily_reports.gross_sales IS 'Total gross sales in THB with exact precision NUMERIC(12,2).';
COMMENT ON COLUMN public.daily_reports.deductions IS 'Total commission and deductions in THB with exact precision NUMERIC(12,2).';
COMMENT ON COLUMN public.daily_reports.net_sale IS 'Net payout amount in THB with exact precision NUMERIC(12,2).';
COMMENT ON COLUMN public.daily_reports.details IS 'Structured platform-specific metadata (fees, item breakdowns, promos, payout status).';
COMMENT ON CONSTRAINT uq_daily_reports_branch_platform_date ON public.daily_reports IS 'Composite unique constraint ensuring idempotency for pipeline re-ingestion.';

-- -----------------------------------------------------------------------------
-- 5. Indexes for Query Performance & FK Traversal
-- -----------------------------------------------------------------------------
-- Performance index for chronological queries per branch
CREATE INDEX IF NOT EXISTS idx_daily_reports_branch_date
    ON public.daily_reports (branch_id, report_date DESC);

-- GIN index for deep querying inside raw platform payload details
CREATE INDEX IF NOT EXISTS idx_daily_reports_details_gin
    ON public.daily_reports USING gin (details);

-- Foreign key & RLS traversal indexes
CREATE INDEX IF NOT EXISTS idx_branches_brand_id
    ON public.branches (brand_id);

CREATE INDEX IF NOT EXISTS idx_brand_users_brand_id
    ON public.brand_users (brand_id);

CREATE INDEX IF NOT EXISTS idx_brand_users_user_id
    ON public.brand_users (user_id);

-- -----------------------------------------------------------------------------
-- 6. Automatic Timestamp Trigger Function
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_daily_reports_updated_at ON public.daily_reports;
CREATE TRIGGER trg_daily_reports_updated_at
    BEFORE UPDATE ON public.daily_reports
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_updated_at();

-- -----------------------------------------------------------------------------
-- 7. Row Level Security (RLS) Helper Functions & Policies
-- -----------------------------------------------------------------------------

-- Helper function: retrieve list of brand IDs accessible by current auth user
CREATE OR REPLACE FUNCTION public.get_user_brand_ids()
RETURNS SETOF UUID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
    SELECT brand_id
    FROM public.brand_users
    WHERE user_id = auth.uid();
$$;

-- Grant execution to authenticated users and service_role
REVOKE EXECUTE ON FUNCTION public.get_user_brand_ids() FROM public;
GRANT EXECUTE ON FUNCTION public.get_user_brand_ids() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_brand_ids() TO service_role;

-- Enable Row Level Security
ALTER TABLE public.brands ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.brand_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_reports ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- 7.1 Policies for public.brands
-- -----------------------------------------------------------------------------
CREATE POLICY "brands_select_tenant"
    ON public.brands
    FOR SELECT
    TO authenticated
    USING (id IN (SELECT public.get_user_brand_ids()));

CREATE POLICY "brands_service_role_all"
    ON public.brands
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- -----------------------------------------------------------------------------
-- 7.2 Policies for public.branches
-- -----------------------------------------------------------------------------
CREATE POLICY "branches_select_tenant"
    ON public.branches
    FOR SELECT
    TO authenticated
    USING (brand_id IN (SELECT public.get_user_brand_ids()));

CREATE POLICY "branches_insert_update_tenant"
    ON public.branches
    FOR ALL
    TO authenticated
    USING (brand_id IN (SELECT public.get_user_brand_ids()))
    WITH CHECK (brand_id IN (SELECT public.get_user_brand_ids()));

CREATE POLICY "branches_service_role_all"
    ON public.branches
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- -----------------------------------------------------------------------------
-- 7.3 Policies for public.brand_users
-- -----------------------------------------------------------------------------
CREATE POLICY "brand_users_select_tenant"
    ON public.brand_users
    FOR SELECT
    TO authenticated
    USING (brand_id IN (SELECT public.get_user_brand_ids()));

CREATE POLICY "brand_users_service_role_all"
    ON public.brand_users
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- -----------------------------------------------------------------------------
-- 7.4 Policies for public.daily_reports
-- -----------------------------------------------------------------------------
CREATE POLICY "daily_reports_select_tenant"
    ON public.daily_reports
    FOR SELECT
    TO authenticated
    USING (
        EXISTS (
            SELECT 1
            FROM public.branches b
            WHERE b.id = daily_reports.branch_id
              AND b.brand_id IN (SELECT public.get_user_brand_ids())
        )
    );

CREATE POLICY "daily_reports_modify_tenant"
    ON public.daily_reports
    FOR ALL
    TO authenticated
    USING (
        EXISTS (
            SELECT 1
            FROM public.branches b
            WHERE b.id = daily_reports.branch_id
              AND b.brand_id IN (SELECT public.get_user_brand_ids())
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1
            FROM public.branches b
            WHERE b.id = daily_reports.branch_id
              AND b.brand_id IN (SELECT public.get_user_brand_ids())
        )
    );

CREATE POLICY "daily_reports_service_role_all"
    ON public.daily_reports
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
