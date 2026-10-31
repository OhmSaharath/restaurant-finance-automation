-- =============================================================================
-- Supabase Migration: 20260911_menu_item_sales.sql
-- Description: Itemized menu-sales ingestion (Phase 1) — per-item daily sales
--   rows carrying the sales volume and, once matched to a costed menu_item,
--   a snapshot of unit_cost and COGS. Plus the brand-scoped name->menu_item
--   mapping table that lets re-uploads skip fuzzy matching.
-- Tables: daily_item_sales, menu_item_platform_mappings
-- Fixed design decisions (from docs/menu_sales_cogs_plan.md):
--   * menu_items stays BRAND-scoped; COGS is per serving and NEVER fabricated
--     here (unit_cost stays NULL until a user enters a cost).
--   * LINE MAN is all-branches -> branch_id NULL; Grab rows carry a branch_id.
--   * Idempotent re-upload: a deterministic UNIQUE key over
--     (brand_id, branch_dedup_key, platform, report_date, raw_item_name) via a
--     GENERATED branch_key column that COALESCEs NULL branch_id to the zero-UUID
--     sentinel, so one all-branches row per (brand, platform, date, item) exists.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Table: daily_item_sales
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.daily_item_sales (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    brand_id UUID NOT NULL REFERENCES public.brands(id) ON DELETE CASCADE,
    branch_id UUID NULL REFERENCES public.branches(id) ON DELETE CASCADE,
    -- NULL branch_id for LINE MAN all-branches; Grab rows carry a branch.
    platform TEXT NOT NULL CHECK (platform IN ('Grab', 'LINE MAN', 'Shopee Food', 'Robinhood')),
    report_date DATE NOT NULL,
    menu_item_id UUID NULL REFERENCES public.menu_items(id) ON DELETE SET NULL,
    raw_item_name TEXT NOT NULL,
    quantity NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
    item_gross NUMERIC(12, 2) NULL,          -- sales THB from file
    unit_cost NUMERIC(12, 2) NULL,           -- snapshot of matched menu cost (NULL until matched + costed)
    cogs NUMERIC(12, 2) NULL,                -- = unit_cost * quantity (NULL until cost known)
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Deterministic idempotency key. branch_key stores COALESCE(branch_id,
    -- zero-UUID) so NULL (LINE MAN all-branches) and a real Grab branch never
    -- collide and re-upload upserts instead of duplicating.
    branch_key UUID GENERATED ALWAYS AS (
        COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid)
    ) STORED,
    CONSTRAINT uq_daily_item_sales_dedup UNIQUE (brand_id, branch_key, platform, report_date, raw_item_name)
);

COMMENT ON TABLE public.daily_item_sales IS 'Per-item daily menu sales with optional matched cost snapshot. COGS is computed, never fabricated: unit_cost/cogs stay NULL until matched to a costed menu_item.';
COMMENT ON COLUMN public.daily_item_sales.branch_key IS 'Stored COALESCE(branch_id, zero-UUID) so LINE MAN all-branches (NULL branch_id) participates in the unique idempotency key.';
COMMENT ON COLUMN public.daily_item_sales.unit_cost IS 'Snapshot of the matched menu_items.cost at ingest time. NULL means the source menu_item has no cost yet.';
COMMENT ON COLUMN public.daily_item_sales.cogs IS 'unit_cost * quantity, NUMERIC(12,2). NULL while unit_cost is NULL.';

CREATE INDEX IF NOT EXISTS idx_daily_item_sales_brand_date
    ON public.daily_item_sales (brand_id, report_date DESC);
CREATE INDEX IF NOT EXISTS idx_daily_item_sales_menu_item_id
    ON public.daily_item_sales (menu_item_id);

-- ---------------------------------------------------------------------------
-- 2. Table: menu_item_platform_mappings (brand-scoped name -> menu_item)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.menu_item_platform_mappings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_id UUID NOT NULL REFERENCES public.brands(id) ON DELETE CASCADE,
    menu_item_id UUID NOT NULL REFERENCES public.menu_items(id) ON DELETE CASCADE,
    platform TEXT NOT NULL CHECK (platform IN ('Grab', 'LINE MAN', 'Shopee Food', 'Robinhood')),
    raw_item_name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Brand-scoped: "ข้าวสวย" (plain rice) exists in every brand, so the key
    -- must include brand_id.
    CONSTRAINT uq_menu_item_platform_mapping UNIQUE (brand_id, platform, raw_item_name)
);

COMMENT ON TABLE public.menu_item_platform_mappings IS 'Brand-scoped, persisted raw-name -> menu_item mapping. A confident auto-match is recorded once so future uploads skip fuzzy matching (tier-1 fast path).';
COMMENT ON CONSTRAINT uq_menu_item_platform_mapping ON public.menu_item_platform_mappings IS 'One raw name per (brand, platform): different branch wording is resolved here, not via branch-scoped menu rows.';

CREATE INDEX IF NOT EXISTS idx_menu_item_platform_mappings_brand
    ON public.menu_item_platform_mappings (brand_id);
CREATE INDEX IF NOT EXISTS idx_menu_item_platform_mappings_menu_item_id
    ON public.menu_item_platform_mappings (menu_item_id);

-- ---------------------------------------------------------------------------
-- 3. updated_at trigger for daily_item_sales
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_daily_item_sales_updated_at ON public.daily_item_sales;
CREATE TRIGGER trg_daily_item_sales_updated_at
    BEFORE UPDATE ON public.daily_item_sales
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_updated_at();

-- ---------------------------------------------------------------------------
-- 4. Row Level Security (mirrors db/02_cogs_bom_schema.sql + initial schema)
-- ---------------------------------------------------------------------------
ALTER TABLE public.daily_item_sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.menu_item_platform_mappings ENABLE ROW LEVEL SECURITY;

-- 4.1 daily_item_sales policies (brand_id sits directly on the row)
DROP POLICY IF EXISTS "daily_item_sales_select_tenant" ON public.daily_item_sales;
CREATE POLICY "daily_item_sales_select_tenant"
    ON public.daily_item_sales FOR SELECT TO authenticated
    USING (brand_id IN (SELECT public.get_user_brand_ids()));

DROP POLICY IF EXISTS "daily_item_sales_modify_tenant" ON public.daily_item_sales;
CREATE POLICY "daily_item_sales_modify_tenant"
    ON public.daily_item_sales FOR ALL TO authenticated
    USING (brand_id IN (SELECT public.get_user_brand_ids()))
    WITH CHECK (brand_id IN (SELECT public.get_user_brand_ids()));

DROP POLICY IF EXISTS "daily_item_sales_service_role_all" ON public.daily_item_sales;
CREATE POLICY "daily_item_sales_service_role_all"
    ON public.daily_item_sales FOR ALL TO service_role
    USING (true) WITH CHECK (true);

-- 4.2 menu_item_platform_mappings policies (brand_id sits directly on the row)
DROP POLICY IF EXISTS "menu_item_platform_mappings_select_tenant" ON public.menu_item_platform_mappings;
CREATE POLICY "menu_item_platform_mappings_select_tenant"
    ON public.menu_item_platform_mappings FOR SELECT TO authenticated
    USING (brand_id IN (SELECT public.get_user_brand_ids()));

DROP POLICY IF EXISTS "menu_item_platform_mappings_modify_tenant" ON public.menu_item_platform_mappings;
CREATE POLICY "menu_item_platform_mappings_modify_tenant"
    ON public.menu_item_platform_mappings FOR ALL TO authenticated
    USING (brand_id IN (SELECT public.get_user_brand_ids()))
    WITH CHECK (brand_id IN (SELECT public.get_user_brand_ids()));

DROP POLICY IF EXISTS "menu_item_platform_mappings_service_role_all" ON public.menu_item_platform_mappings;
CREATE POLICY "menu_item_platform_mappings_service_role_all"
    ON public.menu_item_platform_mappings FOR ALL TO service_role
    USING (true) WITH CHECK (true);

-- ===========================================================================
-- DOWN MIGRATION (rollback):
--   DROP TRIGGER IF EXISTS trg_daily_item_sales_updated_at ON public.daily_item_sales;
--   DROP TABLE IF EXISTS public.menu_item_platform_mappings;
--   DROP TABLE IF EXISTS public.daily_item_sales;
-- ===========================================================================
