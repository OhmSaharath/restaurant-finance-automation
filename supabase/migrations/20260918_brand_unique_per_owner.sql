-- =============================================================================
-- Migration: prevent duplicate brands PER TENANT (not globally).
--
-- WHY: a bare UNIQUE(brands.name) is WRONG for multi-tenant — two different
-- restaurant owners may legitimately name their store "แมวอ้วนต้มน้ำปลา".
-- Uniqueness must be scoped to the OWNER (tenant), so tenant A and tenant B can
-- each own a brand named the same, but ONE tenant cannot create two brands
-- with the same name.
--
-- The tenant boundary lives in brand_users (user_id -> brand_id, role='owner').
-- brands has no owner column, so we denormalize a single canonical owner onto
-- the brand row (owner_user_id) and enforce uniqueness on
-- (owner_user_id, normalized_name).
-- =============================================================================

-- 1. Add the canonical owner column (nullable during backfill).
ALTER TABLE brands
    ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;

-- 2. Add a normalized name column (lowercased, trimmed, punctuation-stripped)
--    so "แมวอ้วนต้มน้ำปลา" == "แมวอ้วน ต้มน้ำปลา" == "แมวอ้วนต้มน้ำปลา " for
--    the uniqueness check. Kept in sync by a trigger (below).
ALTER TABLE brands
    ADD COLUMN IF NOT EXISTS normalized_name TEXT;

-- 3. Backfill owner_user_id from brand_users (prefer role='owner', else first).
UPDATE brands b
SET owner_user_id = bu.user_id
FROM (
    SELECT DISTINCT ON (brand_id) brand_id, user_id
    FROM brand_users
    ORDER BY brand_id, (role = 'owner') DESC, created_at ASC
) bu
WHERE bu.brand_id = b.id
  AND b.owner_user_id IS NULL;

-- 4. Backfill normalized_name for existing rows.
UPDATE brands
SET normalized_name = lower(regexp_replace(regexp_replace(trim(name), '[\s\-()]+', ' ', 'g'), '\s+', ' ', 'g'))
WHERE normalized_name IS NULL;

-- 5. UNIQUE index scoped per owner. Two owners can share a name; one owner
--    cannot. Rows with NULL owner (unlinked) are not constrained (partial).
CREATE UNIQUE INDEX IF NOT EXISTS brands_owner_name_uniq
    ON brands (owner_user_id, normalized_name)
    WHERE owner_user_id IS NOT NULL AND normalized_name IS NOT NULL
      AND normalized_name <> '';

-- 6. Trigger to keep normalized_name in sync on insert/update.
CREATE OR REPLACE FUNCTION brands_normalize_name_fn()
RETURNS trigger AS $$
BEGIN
    NEW.normalized_name := lower(
        regexp_replace(
            regexp_replace(trim(COALESCE(NEW.name, '')), '[\s\-()]+', ' ', 'g'),
            '\s+', ' ', 'g'
        )
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS brands_normalize_name_trg ON brands;
CREATE TRIGGER brands_normalize_name_trg
    BEFORE INSERT OR UPDATE OF name ON brands
    FOR EACH ROW
    EXECUTE FUNCTION brands_normalize_name_fn();

-- 7. Trigger to backfill owner_user_id when a brand_users row is inserted and
--    the brand has no owner yet (the app links owner right after creating).
CREATE OR REPLACE FUNCTION brands_set_owner_fn()
RETURNS trigger AS $$
BEGIN
    UPDATE brands
    SET owner_user_id = NEW.user_id
    WHERE id = NEW.brand_id AND owner_user_id IS NULL;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS brand_users_set_owner_trg ON brand_users;
CREATE TRIGGER brand_users_set_owner_trg
    AFTER INSERT ON brand_users
    FOR EACH ROW
    EXECUTE FUNCTION brands_set_owner_fn();