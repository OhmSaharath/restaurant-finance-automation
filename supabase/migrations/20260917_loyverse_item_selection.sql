-- =============================================================================
-- Supabase Migration: 20260917_loyverse_item_selection.sql
-- Description: Loyverse Phase 3 - (1) widen daily_item_sales.platform CHECK to
-- accept 'LOYVERSE_INSTORE' so itemized in-store COGS rows can be written, and
-- (2) add loyverse_config.item_selection JSONB for the owner's per-item
-- include/exclude toggle (the owner chooses which Loyverse menu items flow into
-- revenue/COGS).
--
-- daily_item_sales.platform was declared INLINE in 20260911_menu_item_sales.sql:
--     platform TEXT NOT NULL CHECK (platform IN ('Grab', 'LINE MAN', 'Shopee Food', 'Robinhood'))
-- PostgreSQL auto-names that inline single-column constraint
-- `daily_item_sales_platform_check` (<table>_<column>_check), which we drop and
-- re-add widened below.
-- =============================================================================

-- 1. Widen daily_item_sales.platform to include LOYVERSE_INSTORE.
ALTER TABLE public.daily_item_sales
    DROP CONSTRAINT IF EXISTS daily_item_sales_platform_check;

ALTER TABLE public.daily_item_sales
    ADD CONSTRAINT daily_item_sales_platform_check
    CHECK (platform IN ('Grab', 'LINE MAN', 'Shopee Food', 'Robinhood', 'LOYVERSE_INSTORE'));

COMMENT ON CONSTRAINT daily_item_sales_platform_check ON public.daily_item_sales IS
    'Restricts daily_item_sales.platform to the four delivery marketplaces plus the in-store Loyverse POS label LOYVERSE_INSTORE.';

-- 2. Per-item selection toggle on loyverse_config (one row per brand).
--    Shape: JSONB array of objects { "item_id": "<loyverse item id>", "include": true|false }.
--    Semantics (chosen so a fresh config works without forcing the owner to
--    select up front): an item_id NOT present in this list is INCLUDED by
--    default ("pull all items"); the owner toggles OFF specific items. An empty
--    array means "no explicit overrides -> include everything".
ALTER TABLE public.loyverse_config
    ADD COLUMN IF NOT EXISTS item_selection JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.loyverse_config.item_selection IS
    'Owner per-item include/exclude list: array of {item_id, include}. An item_id absent from the list is INCLUDED by default (pull all; toggle off to exclude). Itemized COGS from Loyverse variant.cost is written only for included items.';

-- =============================================================================
-- DOWN MIGRATION (rollback):
--   ALTER TABLE public.daily_item_sales DROP CONSTRAINT daily_item_sales_platform_check;
--   ALTER TABLE public.daily_item_sales ADD CONSTRAINT daily_item_sales_platform_check
--     CHECK (platform IN ('Grab', 'LINE MAN', 'Shopee Food', 'Robinhood'));
--   ALTER TABLE public.loyverse_config DROP COLUMN IF EXISTS item_selection;
-- NOTE: any 'LOYVERSE_INSTORE' daily_item_sales rows must be removed before the
--   DOWN migration re-adds the narrower CHECK, or subsequent writes will fail.
-- =============================================================================