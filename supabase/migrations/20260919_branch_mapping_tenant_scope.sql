-- Make platform-store mappings tenant-scoped and safe under concurrent syncs.
-- The table was created outside the original baseline migration, so every
-- operation is intentionally idempotent for existing environments.

CREATE TABLE IF NOT EXISTS public.branch_platform_mappings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_id uuid NOT NULL REFERENCES public.brands(id) ON DELETE CASCADE,
    branch_id uuid NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
    platform text NOT NULL CHECK (platform IN ('Grab', 'LINE MAN', 'Shopee Food', 'Robinhood')),
    raw_shop_name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.branch_platform_mappings
    ADD COLUMN IF NOT EXISTS brand_id uuid;

UPDATE public.branch_platform_mappings AS m
SET brand_id = b.brand_id
FROM public.branches AS b
WHERE b.id = m.branch_id
  AND m.brand_id IS NULL;

ALTER TABLE public.branch_platform_mappings
    ALTER COLUMN brand_id SET NOT NULL;

ALTER TABLE public.branch_platform_mappings
    DROP CONSTRAINT IF EXISTS branch_platform_mappings_brand_id_fkey;

ALTER TABLE public.branch_platform_mappings
    ADD CONSTRAINT branch_platform_mappings_brand_id_fkey
    FOREIGN KEY (brand_id) REFERENCES public.brands(id) ON DELETE CASCADE;

ALTER TABLE public.branch_platform_mappings
    DROP CONSTRAINT IF EXISTS uq_platform_raw_name;
DROP INDEX IF EXISTS public.uq_platform_raw_name;
CREATE UNIQUE INDEX IF NOT EXISTS uq_branch_platform_brand_raw_name
    ON public.branch_platform_mappings (brand_id, platform, raw_shop_name);

CREATE INDEX IF NOT EXISTS idx_branch_platform_mappings_brand_platform
    ON public.branch_platform_mappings (brand_id, platform);

ALTER TABLE public.branch_platform_mappings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mappings_select_tenant ON public.branch_platform_mappings;
CREATE POLICY mappings_select_tenant
    ON public.branch_platform_mappings FOR SELECT TO authenticated
    USING (EXISTS (
        SELECT 1 FROM public.branches b
        WHERE b.id = branch_platform_mappings.branch_id
          AND b.brand_id IN (SELECT public.get_user_brand_ids())
    ));

DROP POLICY IF EXISTS mappings_modify_tenant ON public.branch_platform_mappings;
CREATE POLICY mappings_modify_tenant
    ON public.branch_platform_mappings FOR ALL TO authenticated
    USING (EXISTS (
        SELECT 1 FROM public.branches b
        WHERE b.id = branch_platform_mappings.branch_id
          AND b.brand_id IN (SELECT public.get_user_brand_ids())
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM public.branches b
        WHERE b.id = branch_platform_mappings.branch_id
          AND b.brand_id IN (SELECT public.get_user_brand_ids())
    ));

DROP POLICY IF EXISTS mappings_service_role_all ON public.branch_platform_mappings;
CREATE POLICY mappings_service_role_all
    ON public.branch_platform_mappings FOR ALL TO service_role
    USING (true) WITH CHECK (true);

COMMENT ON COLUMN public.branch_platform_mappings.brand_id IS
    'Tenant brand owning the mapped branch; required for cross-tenant labels and idempotent concurrent ingestion.';
