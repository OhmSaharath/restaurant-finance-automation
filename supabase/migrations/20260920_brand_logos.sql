-- Brand logo storage
--
-- Logo files are deliberately stored by brand (not by auth user) so every
-- member of a workspace sees the same logo. The bucket is public because a
-- restaurant logo is non-sensitive presentation data; writes remain locked
-- to owner/admin membership through storage.objects RLS.

ALTER TABLE public.brands
  ADD COLUMN IF NOT EXISTS logo_url TEXT;

COMMENT ON COLUMN public.brands.logo_url IS
  'Public Supabase Storage URL for the workspace logo. Uploaded through the authenticated server route.';

-- 2 MiB maximum and an intentionally small allow-list. PNG/WebP are preferred
-- for transparent logos; JPEG is retained for compatibility with phone uploads.
INSERT INTO storage.buckets
  (id, name, public, file_size_limit, allowed_mime_types)
VALUES
  (
    'brand-logos',
    'brand-logos',
    TRUE,
    2097152,
    ARRAY['image/png', 'image/jpeg', 'image/webp']::TEXT[]
  )
ON CONFLICT (id) DO UPDATE
SET
  name = EXCLUDED.name,
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Keep policy names stable so this migration is safe to re-run in environments
-- where the bucket was created manually before the migration was introduced.
DROP POLICY IF EXISTS "brand_logo_member_select" ON storage.objects;
DROP POLICY IF EXISTS "brand_logo_owner_admin_insert" ON storage.objects;
DROP POLICY IF EXISTS "brand_logo_owner_admin_update" ON storage.objects;
DROP POLICY IF EXISTS "brand_logo_owner_admin_delete" ON storage.objects;

-- Members can list/read object metadata for their own brands. Public bucket
-- downloads do not depend on this policy, but the policy prevents cross-tenant
-- object listing through an authenticated Storage client.
CREATE POLICY "brand_logo_member_select"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'brand-logos'
    AND EXISTS (
      SELECT 1
      FROM public.brand_users bu
      WHERE bu.brand_id::TEXT = (storage.foldername(name))[1]
        AND bu.user_id = (SELECT auth.uid())
    )
  );

-- The first folder is the brand UUID and the object filename is fixed to one
-- of the supported logo extensions. This prevents users from uploading an
-- arbitrary file into another brand's folder or using the bucket as a general
-- purpose file store.
CREATE POLICY "brand_logo_owner_admin_insert"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'brand-logos'
    AND lower(storage.filename(name)) ~ '^logo\\.(png|jpe?g|webp)$'
    AND EXISTS (
      SELECT 1
      FROM public.brand_users bu
      WHERE bu.brand_id::TEXT = (storage.foldername(name))[1]
        AND bu.user_id = (SELECT auth.uid())
        AND bu.role IN ('owner', 'admin')
    )
  );

-- Upsert requires SELECT + UPDATE in addition to INSERT (Supabase Storage
-- checks these separately when replacing an existing object).
CREATE POLICY "brand_logo_owner_admin_update"
  ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'brand-logos'
    AND lower(storage.filename(name)) ~ '^logo\\.(png|jpe?g|webp)$'
    AND EXISTS (
      SELECT 1
      FROM public.brand_users bu
      WHERE bu.brand_id::TEXT = (storage.foldername(name))[1]
        AND bu.user_id = (SELECT auth.uid())
        AND bu.role IN ('owner', 'admin')
    )
  )
  WITH CHECK (
    bucket_id = 'brand-logos'
    AND lower(storage.filename(name)) ~ '^logo\\.(png|jpe?g|webp)$'
    AND EXISTS (
      SELECT 1
      FROM public.brand_users bu
      WHERE bu.brand_id::TEXT = (storage.foldername(name))[1]
        AND bu.user_id = (SELECT auth.uid())
        AND bu.role IN ('owner', 'admin')
    )
  );

CREATE POLICY "brand_logo_owner_admin_delete"
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'brand-logos'
    AND EXISTS (
      SELECT 1
      FROM public.brand_users bu
      WHERE bu.brand_id::TEXT = (storage.foldername(name))[1]
        AND bu.user_id = (SELECT auth.uid())
        AND bu.role IN ('owner', 'admin')
    )
  );
