-- =============================================================================
-- Migration: db/02_cogs_bom_schema.sql
-- Description: Master ingredients, menu items, and Recipe Bill of Materials (BOM) schema
-- Tables: master_ingredients, menu_items, recipe_boms
-- Features:
--   - NUMERIC(12,4) precision for ingredient unit costs and recipe BOM quantities
--   - NUMERIC(12,2) precision for menu item selling prices
--   - Multi-tenant brand isolation with foreign key cascades
--   - Row-Level Security (RLS) policies for complete tenant isolation
--   - Performance indexes on foreign keys and tenant lookups
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Table: master_ingredients (Master Raw Material Catalog per Brand)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.master_ingredients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_id UUID NOT NULL REFERENCES public.brands(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    uom TEXT NOT NULL,
    cost_per_unit NUMERIC(12, 4) NOT NULL DEFAULT 0.0000 CHECK (cost_per_unit >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_brand_ingredient UNIQUE (brand_id, name)
);

COMMENT ON TABLE public.master_ingredients IS 'Master ingredient inventory catalog with unit costs per brand.';
COMMENT ON COLUMN public.master_ingredients.id IS 'Primary key UUID generated automatically.';
COMMENT ON COLUMN public.master_ingredients.brand_id IS 'Foreign key reference to tenant brand.';
COMMENT ON COLUMN public.master_ingredients.name IS 'Ingredient display name (e.g., ไก่สด, น้ำปลา, น้ำมันพืช).';
COMMENT ON COLUMN public.master_ingredients.uom IS 'Unit of Measure (e.g., g, kg, ml, l, piece, pack).';
COMMENT ON COLUMN public.master_ingredients.cost_per_unit IS 'Unit cost in THB with NUMERIC(12,4) precision.';
COMMENT ON CONSTRAINT uq_brand_ingredient ON public.master_ingredients IS 'Prevents duplicate ingredient names within the same brand.';

-- -----------------------------------------------------------------------------
-- 2. Table: menu_items (Finished Menu Catalog per Brand)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.menu_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_id UUID NOT NULL REFERENCES public.brands(id) ON DELETE CASCADE,
    menu_code TEXT NOT NULL,
    name TEXT NOT NULL,
    selling_price NUMERIC(12, 2) NOT NULL DEFAULT 0.00 CHECK (selling_price >= 0),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_brand_menu_code UNIQUE (brand_id, menu_code)
);

COMMENT ON TABLE public.menu_items IS 'Brand menu item master catalog with base selling prices.';
COMMENT ON COLUMN public.menu_items.id IS 'Primary key UUID generated automatically.';
COMMENT ON COLUMN public.menu_items.brand_id IS 'Foreign key reference to tenant brand.';
COMMENT ON COLUMN public.menu_items.menu_code IS 'Unique internal menu code (e.g. MAEW-001, TOFU-001).';
COMMENT ON COLUMN public.menu_items.name IS 'Menu item name.';
COMMENT ON COLUMN public.menu_items.selling_price IS 'Standard selling price in THB (NUMERIC 12,2).';
COMMENT ON COLUMN public.menu_items.is_active IS 'Active availability status flag.';
COMMENT ON CONSTRAINT uq_brand_menu_code ON public.menu_items IS 'Ensures unique menu code per brand.';

-- -----------------------------------------------------------------------------
-- 3. Table: recipe_boms (Bill of Materials / Recipe Formula)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.recipe_boms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    menu_item_id UUID NOT NULL REFERENCES public.menu_items(id) ON DELETE CASCADE,
    ingredient_id UUID NOT NULL REFERENCES public.master_ingredients(id) ON DELETE RESTRICT,
    quantity NUMERIC(12, 4) NOT NULL CHECK (quantity > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_menu_ingredient UNIQUE (menu_item_id, ingredient_id)
);

COMMENT ON TABLE public.recipe_boms IS 'Recipe Bill of Materials mapping ingredients and required quantities to menu items.';
COMMENT ON COLUMN public.recipe_boms.id IS 'Primary key UUID generated automatically.';
COMMENT ON COLUMN public.recipe_boms.menu_item_id IS 'Foreign key reference to parent menu item.';
COMMENT ON COLUMN public.recipe_boms.ingredient_id IS 'Foreign key reference to required master ingredient.';
COMMENT ON COLUMN public.recipe_boms.quantity IS 'Required ingredient quantity in UOM (NUMERIC 12,4).';
COMMENT ON CONSTRAINT uq_menu_ingredient ON public.recipe_boms IS 'Prevents duplicate ingredient mapping for a single menu item.';

-- -----------------------------------------------------------------------------
-- 4. Indexes for Query Performance & Cost Aggregations
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_master_ingredients_brand_id
    ON public.master_ingredients (brand_id);

CREATE INDEX IF NOT EXISTS idx_menu_items_brand_id
    ON public.menu_items (brand_id);

CREATE INDEX IF NOT EXISTS idx_recipe_boms_menu_item_id
    ON public.recipe_boms (menu_item_id);

CREATE INDEX IF NOT EXISTS idx_recipe_boms_ingredient_id
    ON public.recipe_boms (ingredient_id);

-- -----------------------------------------------------------------------------
-- 5. Row Level Security (RLS) Policies
-- -----------------------------------------------------------------------------
ALTER TABLE public.master_ingredients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.menu_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recipe_boms ENABLE ROW LEVEL SECURITY;

-- 5.1 Policies for public.master_ingredients
CREATE POLICY "master_ingredients_select_tenant"
    ON public.master_ingredients FOR SELECT TO authenticated
    USING (brand_id IN (SELECT public.get_user_brand_ids()));

CREATE POLICY "master_ingredients_modify_tenant"
    ON public.master_ingredients FOR ALL TO authenticated
    USING (brand_id IN (SELECT public.get_user_brand_ids()))
    WITH CHECK (brand_id IN (SELECT public.get_user_brand_ids()));

CREATE POLICY "master_ingredients_service_role_all"
    ON public.master_ingredients FOR ALL TO service_role
    USING (true) WITH CHECK (true);

-- 5.2 Policies for public.menu_items
CREATE POLICY "menu_items_select_tenant"
    ON public.menu_items FOR SELECT TO authenticated
    USING (brand_id IN (SELECT public.get_user_brand_ids()));

CREATE POLICY "menu_items_modify_tenant"
    ON public.menu_items FOR ALL TO authenticated
    USING (brand_id IN (SELECT public.get_user_brand_ids()))
    WITH CHECK (brand_id IN (SELECT public.get_user_brand_ids()));

CREATE POLICY "menu_items_service_role_all"
    ON public.menu_items FOR ALL TO service_role
    USING (true) WITH CHECK (true);

-- 5.3 Policies for public.recipe_boms
CREATE POLICY "recipe_boms_select_tenant"
    ON public.recipe_boms FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1
            FROM public.menu_items mi
            WHERE mi.id = recipe_boms.menu_item_id
              AND mi.brand_id IN (SELECT public.get_user_brand_ids())
        )
    );

CREATE POLICY "recipe_boms_modify_tenant"
    ON public.recipe_boms FOR ALL TO authenticated
    USING (
        EXISTS (
            SELECT 1
            FROM public.menu_items mi
            WHERE mi.id = recipe_boms.menu_item_id
              AND mi.brand_id IN (SELECT public.get_user_brand_ids())
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1
            FROM public.menu_items mi
            WHERE mi.id = recipe_boms.menu_item_id
              AND mi.brand_id IN (SELECT public.get_user_brand_ids())
        )
    );

CREATE POLICY "recipe_boms_service_role_all"
    ON public.recipe_boms FOR ALL TO service_role
    USING (true) WITH CHECK (true);
