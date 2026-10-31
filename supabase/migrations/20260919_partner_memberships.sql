-- Partner / workspace member access
-- Partners are read-only members who can view the brands they are invited to.

ALTER TABLE public.brand_users
  DROP CONSTRAINT IF EXISTS brand_users_role_check;

ALTER TABLE public.brand_users
  ADD CONSTRAINT brand_users_role_check
  CHECK (role IN ('owner', 'admin', 'manager', 'accountant', 'partner'));

CREATE TABLE IF NOT EXISTS public.brand_invitations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_id UUID NOT NULL REFERENCES public.brands(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    email_normalized TEXT GENERATED ALWAYS AS (lower(trim(email))) STORED,
    role TEXT NOT NULL DEFAULT 'partner'
      CHECK (role IN ('partner', 'manager', 'accountant', 'admin')),
    invited_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
    auth_user_id UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'accepted', 'revoked')),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 days'),
    accepted_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_brand_invitations_pending_email
  ON public.brand_invitations (brand_id, email_normalized)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_brand_invitations_brand
  ON public.brand_invitations (brand_id, created_at DESC);

ALTER TABLE public.brand_invitations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "brand_invitations_select_member" ON public.brand_invitations;
CREATE POLICY "brand_invitations_select_member"
  ON public.brand_invitations FOR SELECT TO authenticated
  USING (brand_id IN (SELECT public.get_user_brand_ids()));

DROP POLICY IF EXISTS "brand_invitations_service_role_all" ON public.brand_invitations;
CREATE POLICY "brand_invitations_service_role_all"
  ON public.brand_invitations FOR ALL TO service_role
  USING (true) WITH CHECK (true);

REVOKE ALL ON public.brand_invitations FROM anon;
GRANT SELECT ON public.brand_invitations TO authenticated;

COMMENT ON TABLE public.brand_invitations IS
  'Owner-managed invitations and audit trail for tenant members. Service role writes; authenticated members can only read their tenant rows.';
