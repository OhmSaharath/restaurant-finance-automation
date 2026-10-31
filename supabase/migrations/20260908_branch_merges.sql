-- =============================================================================
-- Supabase Migration: 20260908_branch_merges.sql
-- Description: Audit-ready, relation-based branch merge mapping.
--
-- Purpose: Instead of merging duplicate/glitched branch records by deleting rows,
-- a merge is recorded as a (source_branch_id -> target_branch_id) relation row,
-- brand-scoped, with full audit fields (merged_by, notes, created_at) and the
-- ability to soft-disable a merge (is_active). Consumers can redirect reads from
-- a source branch to its canonical target while preserving provenance.
--
-- FK notes: both branch FKs are ON DELETE CASCADE scoped to branches; the brand
-- FK is scoped to the tenant brand. A CHECK constraint guarantees a branch can
-- never be merged onto itself.
-- =============================================================================

-- 1. Table: branch_merges (relation-based merge mapping)
CREATE TABLE IF NOT EXISTS public.branch_merges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_id UUID NOT NULL REFERENCES public.brands(id) ON DELETE CASCADE,
    source_branch_id UUID NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
    target_branch_id UUID NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
    merged_by TEXT NOT NULL DEFAULT 'SYSTEM_USER',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    CONSTRAINT check_different_branches CHECK (source_branch_id <> target_branch_id)
);

-- 2. Indexes for the common query patterns:
--    brand-scoped lookup, and active-source resolution.
CREATE INDEX IF NOT EXISTS idx_branch_merges_brand ON public.branch_merges(brand_id);
CREATE INDEX IF NOT EXISTS idx_branch_merges_source ON public.branch_merges(source_branch_id) WHERE is_active = TRUE;