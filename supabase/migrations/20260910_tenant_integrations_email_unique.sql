-- =============================================================================
-- Supabase Migration: 20260910_tenant_integrations_email_unique.sql
-- Description: Enforce a one-Gmail-address-per-integration invariant so a
--              Pub/Sub push (identified by emailAddress) can never bind to
--              more than one tenant brand. Closes a cross-tenant isolation
--              gap where two brands could register the same Gmail address.
--
-- The push receiver (app/api/v1/gmail_ingestion.py) resolves a tenant ONLY by
-- its registered email_address -> brand_id. A globally-unique email address
-- makes that resolution deterministic and cross-tenant-safe.
-- =============================================================================

-- 1. Unique constraint on email_address (one Gmail account, one integration).
--    Structured as a partial index so NULLs are permitted but duplicate
--    non-null addresses are rejected. (email_address is NOT NULL in practice,
--    but a partial index is the safe idiom and keeps pre-existing rows valid.)
CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_integrations_email
    ON public.tenant_integrations (LOWER(email_address))
    WHERE email_address IS NOT NULL;

COMMENT ON INDEX public.uq_tenant_integrations_email IS
    'Ensures a Gmail email_address maps to exactly one tenant_integration row, making Pub/Sub push tenant resolution (email -> brand_id) deterministic and cross-tenant-safe.';

-- =============================================================================
-- DOWN MIGRATION (rollback):
--   DROP INDEX IF EXISTS public.uq_tenant_integrations_email;
-- =============================================================================