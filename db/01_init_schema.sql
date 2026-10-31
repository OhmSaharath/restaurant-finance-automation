-- =============================================================================
-- Migration: db/01_init_schema.sql
-- Description: Comprehensive Supabase database schema for multi-tenant delivery finance system
-- Tables: brands, branches, brand_users, branch_platform_mappings, daily_reports
-- Features:
--   - Multi-tenant hierarchy (Brands -> Branches)
--   - Branch Platform Store Mapping (branch_platform_mappings)
--   - Non-colliding branch resolution (MAEW-ST, MAEW-ROLL-ST, MAEW-LP48, TOFU-54)
--   - Pre-constraint historical data backfill for existing daily reports
--   - NUMERIC(12,2) financial precision with non-negative constraints
--   - Idempotency composite unique constraint UNIQUE(branch_id, platform, report_date)
--   - Row-Level Security (RLS) policies for complete tenant isolation
--   - Performance indexes & automated audit timestamp triggers
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Extensions
-- -----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- -----------------------------------------------------------------------------
-- 2. Table: brands (HQ Level / Top-level Tenant Entity)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.brands (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    tax_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.brands IS 'Top-level brand / corporate entity for multi-tenant data isolation.';
COMMENT ON COLUMN public.brands.id IS 'Primary key UUID generated automatically.';
COMMENT ON COLUMN public.brands.name IS 'Brand display name.';
COMMENT ON COLUMN public.brands.tax_id IS 'Official business tax identification number.';
COMMENT ON COLUMN public.brands.created_at IS 'Record creation timestamp.';

-- -----------------------------------------------------------------------------
-- 3. Table: branches (Store Level Entity)
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
COMMENT ON COLUMN public.branches.id IS 'Primary key UUID generated automatically.';
COMMENT ON COLUMN public.branches.brand_id IS 'Foreign key reference to parent brand.';
COMMENT ON COLUMN public.branches.branch_code IS 'Unique store/branch code per brand.';
COMMENT ON COLUMN public.branches.branch_name IS 'Human-readable branch name.';
COMMENT ON COLUMN public.branches.address IS 'Physical store address.';
COMMENT ON COLUMN public.branches.is_active IS 'Active status flag.';
COMMENT ON CONSTRAINT uq_branches_brand_id_branch_code ON public.branches IS 'Ensures branch code uniqueness within a single brand.';

-- -----------------------------------------------------------------------------
-- 4. Table: brand_users (Role-Based Access Control)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.brand_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    brand_id UUID NOT NULL REFERENCES public.brands(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'manager', 'accountant')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_brand_users_user_id_brand_id UNIQUE (user_id, brand_id)
);

COMMENT ON TABLE public.brand_users IS 'Tenant membership and RBAC mapping between Supabase Auth users and brands.';
COMMENT ON COLUMN public.brand_users.id IS 'Primary key UUID generated automatically.';
COMMENT ON COLUMN public.brand_users.user_id IS 'Supabase auth user UUID.';
COMMENT ON COLUMN public.brand_users.brand_id IS 'Brand UUID for tenant membership.';
COMMENT ON COLUMN public.brand_users.role IS 'User role within the brand (owner, admin, manager, accountant).';
COMMENT ON CONSTRAINT uq_brand_users_user_id_brand_id ON public.brand_users IS 'Enforces unique user assignment per brand.';

-- -----------------------------------------------------------------------------
-- 5. Table: branch_platform_mappings (Platform Store Mapping)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.branch_platform_mappings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    branch_id UUID NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
    platform TEXT NOT NULL CHECK (platform IN ('Grab', 'LINE MAN', 'Shopee Food', 'Robinhood')),
    raw_shop_name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_platform_raw_name UNIQUE (platform, raw_shop_name)
);

COMMENT ON TABLE public.branch_platform_mappings IS 'Mapping table associating raw platform store names with internal branches.';
COMMENT ON COLUMN public.branch_platform_mappings.id IS 'Primary key UUID generated automatically.';
COMMENT ON COLUMN public.branch_platform_mappings.branch_id IS 'Foreign key reference to branch location.';
COMMENT ON COLUMN public.branch_platform_mappings.platform IS 'Food delivery platform (Grab, LINE MAN, Shopee Food, Robinhood).';
COMMENT ON COLUMN public.branch_platform_mappings.raw_shop_name IS 'Exact store name as formatted in raw platform settlement files.';
COMMENT ON CONSTRAINT uq_platform_raw_name ON public.branch_platform_mappings IS 'Ensures uniqueness for a given raw shop name on a platform.';

-- -----------------------------------------------------------------------------
-- 6. Safe Evolution for Table: daily_reports (Structural Alterations)
-- -----------------------------------------------------------------------------
-- Ensure base table exists without dropping existing data
CREATE TABLE IF NOT EXISTS public.daily_reports (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    platform TEXT NOT NULL CHECK (platform IN ('Grab', 'LINE MAN', 'Shopee Food', 'Robinhood')),
    report_date DATE NOT NULL,
    order_count INTEGER NOT NULL DEFAULT 0,
    gross_sales NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    deductions NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    net_sale NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Safely add branch_id column if not present
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'daily_reports'
          AND column_name = 'branch_id'
    ) THEN
        ALTER TABLE public.daily_reports
        ADD COLUMN branch_id UUID REFERENCES public.branches(id) ON DELETE RESTRICT;
    END IF;
END $$;

-- Safely rename column shop_name to shop_name_raw if shop_name exists and shop_name_raw does not
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'daily_reports'
          AND column_name = 'shop_name'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'daily_reports'
          AND column_name = 'shop_name_raw'
    ) THEN
        ALTER TABLE public.daily_reports RENAME COLUMN shop_name TO shop_name_raw;
    ELSIF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'daily_reports'
          AND column_name = 'shop_name_raw'
    ) THEN
        ALTER TABLE public.daily_reports ADD COLUMN shop_name_raw TEXT;
    END IF;
END $$;

-- Safely add updated_at column if not present
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'daily_reports'
          AND column_name = 'updated_at'
    ) THEN
        ALTER TABLE public.daily_reports
        ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
    END IF;
END $$;

-- Ensure financial columns use NUMERIC(12, 2)
ALTER TABLE public.daily_reports ALTER COLUMN gross_sales TYPE NUMERIC(12, 2);
ALTER TABLE public.daily_reports ALTER COLUMN deductions TYPE NUMERIC(12, 2);
ALTER TABLE public.daily_reports ALTER COLUMN net_sale TYPE NUMERIC(12, 2);

-- Add check constraints: gross_sales >= 0, order_count >= 0
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_daily_reports_gross_sales_non_negative'
    ) THEN
        ALTER TABLE public.daily_reports
        ADD CONSTRAINT chk_daily_reports_gross_sales_non_negative CHECK (gross_sales >= 0);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_daily_reports_order_count_non_negative'
    ) THEN
        ALTER TABLE public.daily_reports
        ADD CONSTRAINT chk_daily_reports_order_count_non_negative CHECK (order_count >= 0);
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 7. Seed Brands, Branches, and Platform Mappings
-- -----------------------------------------------------------------------------
DO $$
DECLARE
    v_brand_maew_id UUID;
    v_brand_tofu_id UUID;
    v_branch_maew_st_id UUID;
    v_branch_maew_roll_st_id UUID;
    v_branch_maew_lp_id UUID;
    v_branch_tofu_54_id UUID;
BEGIN
    -- Brand 1: 'แมวอ้วนต้มน้ำปลา'
    SELECT id INTO v_brand_maew_id FROM public.brands WHERE name = 'แมวอ้วนต้มน้ำปลา' LIMIT 1;
    IF v_brand_maew_id IS NULL THEN
        INSERT INTO public.brands (name)
        VALUES ('แมวอ้วนต้มน้ำปลา')
        RETURNING id INTO v_brand_maew_id;
    END IF;

    -- Brand 2: 'น้ำเต้าหู้สี่แยกภาษีเจริญ'
    SELECT id INTO v_brand_tofu_id FROM public.brands WHERE name = 'น้ำเต้าหู้สี่แยกภาษีเจริญ' LIMIT 1;
    IF v_brand_tofu_id IS NULL THEN
        INSERT INTO public.brands (name)
        VALUES ('น้ำเต้าหู้สี่แยกภาษีเจริญ')
        RETURNING id INTO v_brand_tofu_id;
    END IF;

    -- Branch 1.1: 'MAEW-ST' -> 'แมวอ้วนต้มน้ำปลา สาขาสุทธิสาร'
    SELECT id INTO v_branch_maew_st_id FROM public.branches
    WHERE brand_id = v_brand_maew_id AND branch_code = 'MAEW-ST' LIMIT 1;
    IF v_branch_maew_st_id IS NULL THEN
        INSERT INTO public.branches (brand_id, branch_code, branch_name)
        VALUES (v_brand_maew_id, 'MAEW-ST', 'แมวอ้วนต้มน้ำปลา สาขาสุทธิสาร')
        RETURNING id INTO v_branch_maew_st_id;
    END IF;

    -- Branch 1.2: 'MAEW-ROLL-ST' -> 'แมวอ้วน & Roll สาขาสุทธิสาร' (Separate sub-brand branch to avoid collision)
    SELECT id INTO v_branch_maew_roll_st_id FROM public.branches
    WHERE brand_id = v_brand_maew_id AND branch_code = 'MAEW-ROLL-ST' LIMIT 1;
    IF v_branch_maew_roll_st_id IS NULL THEN
        INSERT INTO public.branches (brand_id, branch_code, branch_name)
        VALUES (v_brand_maew_id, 'MAEW-ROLL-ST', 'แมวอ้วน & Roll สาขาสุทธิสาร')
        RETURNING id INTO v_branch_maew_roll_st_id;
    END IF;

    -- Branch 1.3: 'MAEW-LP48' -> 'แมวอ้วนต้มน้ำปลา สาขาลาดพร้าว 48'
    SELECT id INTO v_branch_maew_lp_id FROM public.branches
    WHERE brand_id = v_brand_maew_id AND branch_code = 'MAEW-LP48' LIMIT 1;
    IF v_branch_maew_lp_id IS NULL THEN
        INSERT INTO public.branches (brand_id, branch_code, branch_name)
        VALUES (v_brand_maew_id, 'MAEW-LP48', 'แมวอ้วนต้มน้ำปลา สาขาลาดพร้าว 48')
        RETURNING id INTO v_branch_maew_lp_id;
    END IF;

    -- Branch 2.1: 'TOFU-54' -> 'น้ำเต้าหู้สี่แยกภาษีเจริญ ซอย 54'
    SELECT id INTO v_branch_tofu_54_id FROM public.branches
    WHERE brand_id = v_brand_tofu_id AND branch_code = 'TOFU-54' LIMIT 1;
    IF v_branch_tofu_54_id IS NULL THEN
        INSERT INTO public.branches (brand_id, branch_code, branch_name)
        VALUES (v_brand_tofu_id, 'TOFU-54', 'น้ำเต้าหู้สี่แยกภาษีเจริญ ซอย 54')
        RETURNING id INTO v_branch_tofu_54_id;
    END IF;

    -- Mappings:
    -- 1. ('LINE MAN', 'แมวอ้วนต้มน้ำปลา สุทธิสาร') -> Map to 'MAEW-ST'
    INSERT INTO public.branch_platform_mappings (branch_id, platform, raw_shop_name)
    VALUES (v_branch_maew_st_id, 'LINE MAN', 'แมวอ้วนต้มน้ำปลา สุทธิสาร')
    ON CONFLICT (platform, raw_shop_name) DO UPDATE SET branch_id = EXCLUDED.branch_id;

    -- 2. ('LINE MAN', 'แมวอ้วน & Roll สุทธิสาร') -> Map to 'MAEW-ROLL-ST'
    INSERT INTO public.branch_platform_mappings (branch_id, platform, raw_shop_name)
    VALUES (v_branch_maew_roll_st_id, 'LINE MAN', 'แมวอ้วน & Roll สุทธิสาร')
    ON CONFLICT (platform, raw_shop_name) DO UPDATE SET branch_id = EXCLUDED.branch_id;

    -- 3. ('Grab', 'แมวอ้วนต้มน้ำปลา') -> Map to 'MAEW-LP48'
    INSERT INTO public.branch_platform_mappings (branch_id, platform, raw_shop_name)
    VALUES (v_branch_maew_lp_id, 'Grab', 'แมวอ้วนต้มน้ำปลา')
    ON CONFLICT (platform, raw_shop_name) DO UPDATE SET branch_id = EXCLUDED.branch_id;

    -- 4. ('LINE MAN', 'น้ำเต้าหู้สี่แยกภาษีเจริญ ซอย 54') -> Map to 'TOFU-54'
    INSERT INTO public.branch_platform_mappings (branch_id, platform, raw_shop_name)
    VALUES (v_branch_tofu_54_id, 'LINE MAN', 'น้ำเต้าหู้สี่แยกภาษีเจริญ ซอย 54')
    ON CONFLICT (platform, raw_shop_name) DO UPDATE SET branch_id = EXCLUDED.branch_id;

END $$;

-- -----------------------------------------------------------------------------
-- 8. Historical Data Backfill (BEFORE creating composite unique constraint)
-- -----------------------------------------------------------------------------
-- Safely backfill branch_id for all existing rows by joining platform and raw shop name
UPDATE public.daily_reports dr
SET branch_id = bpm.branch_id
FROM public.branch_platform_mappings bpm
WHERE dr.branch_id IS NULL
  AND dr.platform = bpm.platform
  AND dr.shop_name_raw = bpm.raw_shop_name;

-- -----------------------------------------------------------------------------
-- 9. Composite Unique Constraint on daily_reports (Guaranteed Zero Collision)
-- -----------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'uq_daily_reports_branch_platform_date'
    ) THEN
        ALTER TABLE public.daily_reports
        ADD CONSTRAINT uq_daily_reports_branch_platform_date UNIQUE (branch_id, platform, report_date);
    END IF;
END $$;

COMMENT ON TABLE public.daily_reports IS 'Daily delivery platform financial reports with strict precision and idempotent uniqueness.';
COMMENT ON COLUMN public.daily_reports.id IS 'Auto-incrementing surrogate primary key.';
COMMENT ON COLUMN public.daily_reports.branch_id IS 'Foreign key reference to branch location.';
COMMENT ON COLUMN public.daily_reports.platform IS 'Food delivery platform (Grab, LINE MAN, Shopee Food, Robinhood).';
COMMENT ON COLUMN public.daily_reports.report_date IS 'Settlement / accounting report date.';
COMMENT ON COLUMN public.daily_reports.shop_name_raw IS 'Raw shop name extracted from platform settlement.';
COMMENT ON COLUMN public.daily_reports.order_count IS 'Total completed orders on this day.';
COMMENT ON COLUMN public.daily_reports.gross_sales IS 'Total gross sales in THB (NUMERIC 12,2).';
COMMENT ON COLUMN public.daily_reports.deductions IS 'Total commission and deductions in THB (NUMERIC 12,2).';
COMMENT ON COLUMN public.daily_reports.net_sale IS 'Net payout amount in THB (NUMERIC 12,2).';
COMMENT ON COLUMN public.daily_reports.details IS 'Structured platform-specific metadata.';

-- -----------------------------------------------------------------------------
-- 10. Performance Indexes
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_daily_reports_branch_date
    ON public.daily_reports (branch_id, report_date DESC);

CREATE INDEX IF NOT EXISTS idx_daily_reports_details_gin
    ON public.daily_reports USING gin (details);

CREATE INDEX IF NOT EXISTS idx_branches_brand_id
    ON public.branches (brand_id);

CREATE INDEX IF NOT EXISTS idx_branch_platform_mappings_branch_id
    ON public.branch_platform_mappings (branch_id);

CREATE INDEX IF NOT EXISTS idx_brand_users_brand_id
    ON public.brand_users (brand_id);

CREATE INDEX IF NOT EXISTS idx_brand_users_user_id
    ON public.brand_users (user_id);

-- -----------------------------------------------------------------------------
-- 11. Automatic Timestamp Trigger & Functions
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
-- 12. Row Level Security (RLS) Helper Functions & Policies
-- -----------------------------------------------------------------------------
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

REVOKE EXECUTE ON FUNCTION public.get_user_brand_ids() FROM public;
GRANT EXECUTE ON FUNCTION public.get_user_brand_ids() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_brand_ids() TO service_role;

-- Enable Row Level Security on all tables
ALTER TABLE public.brands ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.brand_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.branch_platform_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_reports ENABLE ROW LEVEL SECURITY;

-- 12.1 Brands Policies
CREATE POLICY "brands_select_tenant"
    ON public.brands FOR SELECT TO authenticated
    USING (id IN (SELECT public.get_user_brand_ids()));

CREATE POLICY "brands_service_role_all"
    ON public.brands FOR ALL TO service_role
    USING (true) WITH CHECK (true);

-- 12.2 Branches Policies
CREATE POLICY "branches_select_tenant"
    ON public.branches FOR SELECT TO authenticated
    USING (brand_id IN (SELECT public.get_user_brand_ids()));

CREATE POLICY "branches_insert_update_tenant"
    ON public.branches FOR ALL TO authenticated
    USING (brand_id IN (SELECT public.get_user_brand_ids()))
    WITH CHECK (brand_id IN (SELECT public.get_user_brand_ids()));

CREATE POLICY "branches_service_role_all"
    ON public.branches FOR ALL TO service_role
    USING (true) WITH CHECK (true);

-- 12.3 Brand Users Policies
CREATE POLICY "brand_users_select_tenant"
    ON public.brand_users FOR SELECT TO authenticated
    USING (brand_id IN (SELECT public.get_user_brand_ids()));

CREATE POLICY "brand_users_service_role_all"
    ON public.brand_users FOR ALL TO service_role
    USING (true) WITH CHECK (true);

-- 12.4 Branch Platform Mappings Policies
CREATE POLICY "mappings_select_tenant"
    ON public.branch_platform_mappings FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1
            FROM public.branches b
            WHERE b.id = branch_platform_mappings.branch_id
              AND b.brand_id IN (SELECT public.get_user_brand_ids())
        )
    );

CREATE POLICY "mappings_modify_tenant"
    ON public.branch_platform_mappings FOR ALL TO authenticated
    USING (
        EXISTS (
            SELECT 1
            FROM public.branches b
            WHERE b.id = branch_platform_mappings.branch_id
              AND b.brand_id IN (SELECT public.get_user_brand_ids())
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1
            FROM public.branches b
            WHERE b.id = branch_platform_mappings.branch_id
              AND b.brand_id IN (SELECT public.get_user_brand_ids())
        )
    );

CREATE POLICY "mappings_service_role_all"
    ON public.branch_platform_mappings FOR ALL TO service_role
    USING (true) WITH CHECK (true);

-- 12.5 Daily Reports Policies
CREATE POLICY "daily_reports_select_tenant"
    ON public.daily_reports FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1
            FROM public.branches b
            WHERE b.id = daily_reports.branch_id
              AND b.brand_id IN (SELECT public.get_user_brand_ids())
        )
    );

CREATE POLICY "daily_reports_modify_tenant"
    ON public.daily_reports FOR ALL TO authenticated
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
    ON public.daily_reports FOR ALL TO service_role
    USING (true) WITH CHECK (true);
