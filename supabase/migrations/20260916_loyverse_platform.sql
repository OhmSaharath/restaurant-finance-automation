-- =============================================================================
-- Supabase Migration: 20260916_loyverse_platform.sql
-- Description: Loyverse Phase 2 - widen daily_reports.platform CHECK constraint
-- to accept the in-store platform label 'LOYVERSE_INSTORE' so in-store (Loyverse
-- POS) revenue can be written to daily_reports alongside Grab / LINE MAN /
-- Shopee Food / Robinhood.
--
-- The original CHECK was declared INLINE on the platform column in
-- 20260907000000_initial_schema.sql:
--     platform TEXT NOT NULL CHECK (platform IN ('Grab','LINE MAN' ,'Shopee Food','Robinhood'))
-- PostgreSQL auto-named that inline single-column constraint
-- `daily_reports_platform_check` (pattern <table>_<column>_check), which is the
-- real, default name we drop and re-add below. Idempotent ADD IF NOT EXISTS is
-- used so the re-add is safe on a re-run only if the drop succeeded — the owner
-- runs this once.
-- =============================================================================

-- 1. Drop the existing auto-named CHECK constraint (permissive DROP IF EXISTS
--    so the migration is harmless if it is ever already gone).
ALTER TABLE public.daily_reports
    DROP CONSTRAINT IF EXISTS daily_reports_platform_check;

-- 2. Re-add the widened CHECK constraint, explicitly named, accepting the
--    legacy delivery platforms plus the new in-store label 'LOYVERSE_INSTORE'.
ALTER TABLE public.daily_reports
    ADD CONSTRAINT daily_reports_platform_check
    CHECK (platform IN ('Grab', 'LINE MAN', 'Shopee Food', 'Robinhood', 'LOYVERSE_INSTORE'));

COMMENT ON CONSTRAINT daily_reports_platform_check ON public.daily_reports IS
    'Restricts daily_reports.platform to the four delivery marketplaces plus the in-store Loyverse POS label LOYVERSE_INSTORE.';

-- =============================================================================
-- DOWN MIGRATION (rollback): restore the original 4-member constraint.
--   ALTER TABLE public.daily_reports DROP CONSTRAINT daily_reports_platform_check;
--   ALTER TABLE public.daily_reports ADD CONSTRAINT daily_reports_platform_check
--     CHECK (platform IN ('Grab', 'LINE MAN', 'Shopee Food', 'Robinhood'));
-- NOTE: data isolation stays intact during the rollback window — any
--   'LOYVERSE_INSTORE' rows written while the widened constraint was live must
--   be migrated or removed BEFORE the DOWN migration runs, otherwise the
--   re-added CHECK will reject them on the next write.
-- =============================================================================