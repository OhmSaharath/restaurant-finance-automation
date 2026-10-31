-- =============================================================================
-- Migration: 001_initial_schema_down.sql
-- Description: Rollback script for 001_initial_schema.sql
-- =============================================================================

-- Drop policies
DROP POLICY IF EXISTS "daily_reports_service_role_all" ON public.daily_reports;
DROP POLICY IF EXISTS "daily_reports_modify_tenant" ON public.daily_reports;
DROP POLICY IF EXISTS "daily_reports_select_tenant" ON public.daily_reports;

DROP POLICY IF EXISTS "brand_users_service_role_all" ON public.brand_users;
DROP POLICY IF EXISTS "brand_users_select_tenant" ON public.brand_users;

DROP POLICY IF EXISTS "branches_service_role_all" ON public.branches;
DROP POLICY IF EXISTS "branches_insert_update_tenant" ON public.branches;
DROP POLICY IF EXISTS "branches_select_tenant" ON public.branches;

DROP POLICY IF EXISTS "brands_service_role_all" ON public.brands;
DROP POLICY IF EXISTS "brands_select_tenant" ON public.brands;

-- Drop trigger & helper functions
DROP TRIGGER IF EXISTS trg_daily_reports_updated_at ON public.daily_reports;
DROP FUNCTION IF EXISTS public.handle_updated_at();
DROP FUNCTION IF EXISTS public.get_user_brand_ids();

-- Drop tables in reverse dependency order
DROP TABLE IF EXISTS public.daily_reports;
DROP TABLE IF EXISTS public.brand_users;
DROP TABLE IF EXISTS public.branches;
DROP TABLE IF EXISTS public.brands;
