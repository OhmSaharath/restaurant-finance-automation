-- =============================================================================
-- Supabase Migration: 20260910_menu_item_cost.sql
-- Description: Add the DIRECT cost column to menu_items — the simple
-- "Recommended for Delivery" cost model where each menu item is priced per
-- serving directly (no ingredient BOM required).
-- Table: menu_items (adds ONLY the `cost` column; no RLS / schema / other
--        column changes). NULL or 0 means "fall back to the recipe BOM cost"
--        computed from ingredients at runtime.
-- =============================================================================

-- 1. Direct per-serving cost column (idempotent)
ALTER TABLE public.menu_items ADD COLUMN IF NOT EXISTS cost NUMERIC(12, 2);

COMMENT ON COLUMN public.menu_items.cost IS
    'Direct cost per serving (THB). This is the simple "Recommended for Delivery" cost model; NULL or 0 means "fall back to the recipe BOM cost".';

-- =============================================================================
-- DOWN MIGRATION (rollback):
--   ALTER TABLE public.menu_items DROP COLUMN IF EXISTS cost;
-- =============================================================================