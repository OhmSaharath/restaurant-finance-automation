-- =============================================================================
-- Supabase Migration: 20260910_menu_item_selling_price_nullable.sql
-- Description: Make menu_items.selling_price nullable. A menu item's selling
-- price is platform-specific (Grab and LINE MAN can price the same dish
-- differently), so a single mandatory price on the menu row is misleading.
-- Focus shifts to the per-dish COST (platform-independent); the revenue /
-- selling price is handled later at the daily-delivery level.
-- =============================================================================

-- 1. Relax the NOT NULL constraint (idempotent: no-op if already nullable)
ALTER TABLE public.menu_items ALTER COLUMN selling_price DROP NOT NULL;

-- =============================================================================
-- DOWN MIGRATION (rollback):
--   ALTER TABLE public.menu_items ALTER COLUMN selling_price SET NOT NULL;
-- =============================================================================
