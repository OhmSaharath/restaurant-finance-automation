-- =============================================================================
-- Menu identity cleanup and guardrails
--
-- Delivery-platform exports and Loyverse append a source UUID to a menu name.
-- That UUID is an import identifier, not a second dish.  This migration:
--   1) creates a brand-scoped canonical identity (trailing UUID removed);
--   2) repoints sales, aliases, and BOM rows before removing duplicate masters;
--   3) adds a unique key so concurrent imports cannot recreate the duplicates.
--
-- Raw platform names remain in daily_item_sales / mappings for auditability;
-- promotions and portion variants are not collapsed by this migration.
-- =============================================================================

BEGIN;

ALTER TABLE public.menu_items
    ADD COLUMN IF NOT EXISTS normalized_name TEXT;

CREATE OR REPLACE FUNCTION public.menu_items_normalize_name_fn()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.normalized_name := lower(
        regexp_replace(
            regexp_replace(
                regexp_replace(trim(COALESCE(NEW.name, '')), E'\\s+[—-]\\s+[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\s*$', '', 'i'),
                E'\\s+', ' ', 'g'
            ),
            E'^\\s+|\\s+$', '', 'g'
        )
    );
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS menu_items_normalize_name_trg ON public.menu_items;
CREATE TRIGGER menu_items_normalize_name_trg
    BEFORE INSERT OR UPDATE OF name ON public.menu_items
    FOR EACH ROW
    EXECUTE FUNCTION public.menu_items_normalize_name_fn();

UPDATE public.menu_items
SET normalized_name = lower(
    regexp_replace(
        regexp_replace(
            regexp_replace(trim(COALESCE(name, '')), E'\\s+[—-]\\s+[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\s*$', '', 'i'),
            E'\\s+', ' ', 'g'
        ),
        E'^\\s+|\\s+$', '', 'g'
    )
)
WHERE normalized_name IS DISTINCT FROM lower(
    regexp_replace(
        regexp_replace(
            regexp_replace(trim(COALESCE(name, '')), E'\\s+[—-]\\s+[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\s*$', '', 'i'),
            E'\\s+', ' ', 'g'
        ),
        E'^\\s+|\\s+$', '', 'g'
    )
);

-- Repoint every dependent row before deleting the duplicate master.  The
-- oldest non-UUID item with a positive cost is preferred as the canonical row;
-- an existing canonical cost is never overwritten by an import duplicate.
DO $$
DECLARE
    grp RECORD;
    primary_row RECORD;
    dup RECORD;
    effective_cost NUMERIC(12,2);
BEGIN
    FOR grp IN
        SELECT brand_id, normalized_name
        FROM public.menu_items
        WHERE normalized_name IS NOT NULL AND normalized_name <> ''
        GROUP BY brand_id, normalized_name
        HAVING count(*) > 1
    LOOP
        SELECT id, cost
        INTO primary_row
        FROM public.menu_items
        WHERE brand_id = grp.brand_id AND normalized_name = grp.normalized_name
        ORDER BY
            (name !~ E'\\s+[—-]\\s+[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\s*$') DESC,
            (cost IS NOT NULL AND cost > 0) DESC,
            created_at ASC,
            id ASC
        LIMIT 1;

        effective_cost := NULLIF(primary_row.cost, 0);
        IF effective_cost IS NULL THEN
            SELECT cost INTO effective_cost
            FROM public.menu_items
            WHERE brand_id = grp.brand_id AND normalized_name = grp.normalized_name
              AND id <> primary_row.id AND cost IS NOT NULL AND cost > 0
            ORDER BY created_at ASC, id ASC
            LIMIT 1;
            IF effective_cost IS NOT NULL THEN
                UPDATE public.menu_items SET cost = effective_cost WHERE id = primary_row.id;
            END IF;
        END IF;

        FOR dup IN
            SELECT id
            FROM public.menu_items
            WHERE brand_id = grp.brand_id
              AND normalized_name = grp.normalized_name
              AND id <> primary_row.id
            ORDER BY created_at ASC, id ASC
        LOOP
            -- Preserve historical unit_cost/cogs snapshots; only the master
            -- foreign key changes.
            UPDATE public.daily_item_sales
            SET menu_item_id = primary_row.id
            WHERE brand_id = grp.brand_id AND menu_item_id = dup.id;

            -- A raw alias may already point at the primary.  Remove only the
            -- redundant alias, otherwise retain it as a learned mapping.
            DELETE FROM public.menu_item_platform_mappings d
            USING public.menu_item_platform_mappings p
            WHERE d.id <> p.id
              AND d.menu_item_id = dup.id
              AND p.menu_item_id = primary_row.id
              AND d.brand_id = p.brand_id
              AND d.platform = p.platform
              AND d.raw_item_name = p.raw_item_name;
            UPDATE public.menu_item_platform_mappings
            SET menu_item_id = primary_row.id
            WHERE brand_id = grp.brand_id AND menu_item_id = dup.id;

            -- Preserve BOM ingredients.  If the primary already has the same
            -- ingredient, the duplicate line is redundant; otherwise move it.
            DELETE FROM public.recipe_boms d
            USING public.recipe_boms p
            WHERE d.id <> p.id
              AND d.menu_item_id = dup.id
              AND p.menu_item_id = primary_row.id
              AND d.ingredient_id = p.ingredient_id;
            UPDATE public.recipe_boms
            SET menu_item_id = primary_row.id
            WHERE menu_item_id = dup.id;

            DELETE FROM public.menu_items WHERE id = dup.id AND brand_id = grp.brand_id;
        END LOOP;
    END LOOP;
END;
$$;

-- Clean the visible master name for UUID-only legacy rows that had no
-- canonical counterpart.  Their original source spelling remains available
-- in the platform mapping / sales raw-name columns.
UPDATE public.menu_items
SET name = regexp_replace(
    name,
    E'\\s+[—-]\\s+[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\s*$',
    '',
    'i'
)
WHERE name ~ E'\\s+[—-]\\s+[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\s*$';

CREATE UNIQUE INDEX IF NOT EXISTS uq_menu_items_brand_normalized_name
    ON public.menu_items (brand_id, normalized_name)
    WHERE normalized_name IS NOT NULL AND normalized_name <> '';

COMMENT ON COLUMN public.menu_items.normalized_name IS
    'Brand-scoped canonical menu identity; trailing source UUIDs are removed.';

COMMIT;
