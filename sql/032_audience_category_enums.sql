-- Convert events.audience / events.category from FK-into-labels to
-- native Postgres ENUMs, and strip the labels table down to tags only.
--
-- Why:
--   audience (5 values) and category (9 values) are closed enumerations
--   that don't change. Storing them as INT FK pointers into a generic
--   `labels` dictionary made every read need a JOIN, polluted the
--   dictionary with non-tag rows, and forced a `WHERE kind = ...`
--   filter on every query. Native ENUMs give us readable rows
--   (`category = 'סדנה'` instead of `category_id = 6`), DB-level value
--   constraint, and one fewer table to coordinate.
--
--   Tags (133 rows, growing) stay in `labels` because they're
--   open-ended — every new event can introduce a new tag, and ENUM
--   add-value would mean a migration per tag. After this script
--   `labels` is implicitly tags-only, so the `kind` column is dropped
--   too.
--
-- Order matters:
--   1. Create the ENUM types BEFORE adding columns that use them.
--   2. Backfill from labels BEFORE dropping the FK columns.
--   3. Delete audience+category label rows BEFORE dropping `kind`
--      (DELETE references the column).
--
-- Cast safety:
--   `name::audience_t` aborts the migration if any labels.name doesn't
--   exist in the ENUM declaration. This is intentional — we'd rather
--   fail loud than silently drop a row. Verified pre-migration that
--   all 14 audience+category label names match the declared ENUM
--   values exactly.

BEGIN;

-- 1. Create the ENUM types. Declaration order is preserved as the
--    type's natural sort order — useful when an ORDER BY ever needs
--    to put "תינוקות" before "ילדים".
CREATE TYPE audience_t AS ENUM (
  'תינוקות', 'ילדים', 'נוער', 'מבוגרים', 'לכל המשפחה'
);

CREATE TYPE category_t AS ENUM (
  'סדנה', 'הצגה', 'הופעה', 'הפעלה', 'הרצאה',
  'משחקייה', 'סיור', 'ספורט', 'אחר'
);

-- 2. Add the ENUM columns to events. Nullable: 65 of 399 events
--    currently have NULL audience_id / category_id, and we preserve
--    that "no signal" state.
ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS audience audience_t,
  ADD COLUMN IF NOT EXISTS category category_t;

-- 3. Backfill from the labels dictionary. The cast is checked at
--    UPDATE time — anything outside the ENUM aborts the whole TX.
UPDATE public.events e
SET audience = (
      SELECT name::audience_t
      FROM public.labels
      WHERE id = e.audience_id
    ),
    category = (
      SELECT name::category_t
      FROM public.labels
      WHERE id = e.category_id
    );

-- 4. Drop the FK + indices on the old id columns, then the columns.
--    `IF EXISTS` keeps this idempotent if a partial run already
--    cleaned some of these up.
ALTER TABLE public.events
  DROP CONSTRAINT IF EXISTS fk_events_category_id;
DROP INDEX IF EXISTS public.idx_events_audience_id;
DROP INDEX IF EXISTS public.idx_events_category_id;

ALTER TABLE public.events
  DROP COLUMN IF EXISTS audience_id,
  DROP COLUMN IF EXISTS category_id;

-- 5. B-tree indices on the new ENUM columns. Cardinality is tiny (5
--    and 9 distinct values), so these are mostly for the planner's
--    benefit on equality + the saved-search notifier's "filter by
--    category" path. GIN would be wrong shape.
CREATE INDEX IF NOT EXISTS idx_events_audience ON public.events (audience);
CREATE INDEX IF NOT EXISTS idx_events_category ON public.events (category);

-- 6. Strip labels down to tags. Order: delete the non-tag rows BEFORE
--    dropping the kind column (DELETE references it). The CHECK
--    constraint name comes from sql/026; the index name from the
--    same. Both have IF EXISTS for safety.
DELETE FROM public.labels WHERE kind IN ('audience', 'category');

ALTER TABLE public.labels DROP CONSTRAINT IF EXISTS labels_kind_check;
DROP INDEX IF EXISTS public.idx_labels_kind;
ALTER TABLE public.labels DROP COLUMN IF EXISTS kind;

COMMIT;

NOTIFY pgrst, 'reload schema';
