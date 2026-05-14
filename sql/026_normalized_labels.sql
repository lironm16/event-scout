-- Normalized labels schema.
--
-- Single dictionary table (`labels`) holds every textual tag, keyed by
-- (kind, name). Three kinds:
--
--   - audience  → תינוקות, ילדים, נוער, מבוגרים, לכל המשפחה
--   - category  → סדנה, הצגה, הופעה, הפעלה, הרצאה, משחקייה, סיור,
--                 ספורט, אחר   (one per event in practice)
--   - tag       → free-form ("מוזיקה", "ל״ג בעומר", "חינם") with
--                 normalisation at write time so we don't end up with
--                 both "ל״ג בעומר" and "לג בעומר" in the dictionary.
--
-- Each event row references the dictionary directly via three columns:
--
--   - audience_ids  INT[]   one or more (kind='audience')
--   - category_id   INT     exactly one (kind='category')
--   - tag_ids       INT[]   zero or more (kind='tag')
--
-- We rely on the application layer (lib/labelStore.js) to enforce
-- "label exists with the matching kind" for the array columns —
-- Postgres can FK-enforce category_id (scalar) but not the arrays.
--
-- Why columns over a junction table:
--   - One row per event already carries every label id; reads need at
--     most a single follow-up SELECT against the dictionary to expand
--     names, instead of a 3-way join with grouping.
--   - GIN indices make `WHERE label_id = ANY(...)` queries fast.
--   - Smaller surface area: three columns on events instead of an
--     extra table to keep in sync.
--
-- Numeric age range columns (`min_months`, `max_months`) live alongside
-- the label arrays. Convention:
--   null, null  → no age signal
--   0,    1200  → all ages / family
--   144,  null  → 12+ years (open upper bound)
--   0,    36   → 0-3 years

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS min_months    INT,
  ADD COLUMN IF NOT EXISTS max_months    INT,
  ADD COLUMN IF NOT EXISTS audience_ids  INT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS category_id   INT,
  ADD COLUMN IF NOT EXISTS tag_ids       INT[] DEFAULT '{}';

CREATE TABLE IF NOT EXISTS public.labels (
  id   SERIAL PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('audience', 'category', 'tag')),
  name TEXT NOT NULL,
  UNIQUE (kind, name)
);

CREATE INDEX IF NOT EXISTS idx_labels_kind ON public.labels (kind);

-- Scalar FK is enforceable; the array columns are validated at the
-- application layer. We use NOT VALID + VALIDATE in two steps so an
-- already-populated events table doesn't block the migration on
-- pre-existing nulls — but for a fresh table this is functionally one
-- atomic ALTER.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_events_category_id'
  ) THEN
    ALTER TABLE public.events
      ADD CONSTRAINT fk_events_category_id
      FOREIGN KEY (category_id) REFERENCES public.labels(id);
  END IF;
END
$$;

-- GIN indices: cheap "events tagged with label X" queries via
-- `WHERE X = ANY(audience_ids)` or `WHERE tag_ids && ARRAY[X]`.
CREATE INDEX IF NOT EXISTS idx_events_audience_ids ON public.events USING GIN (audience_ids);
CREATE INDEX IF NOT EXISTS idx_events_tag_ids      ON public.events USING GIN (tag_ids);
CREATE INDEX IF NOT EXISTS idx_events_category_id  ON public.events (category_id);
CREATE INDEX IF NOT EXISTS idx_events_age_range
  ON public.events (min_months, max_months)
  WHERE archived = false;

-- Seed the closed enums (audience, category). We pre-create the rows
-- so the enricher resolves them with a single dictionary probe — no
-- INSERT round-trip on every save. Tag rows are created on first use
-- by the application layer.
INSERT INTO public.labels (kind, name) VALUES
  ('audience', 'תינוקות'),
  ('audience', 'ילדים'),
  ('audience', 'נוער'),
  ('audience', 'מבוגרים'),
  ('audience', 'לכל המשפחה'),
  ('category', 'סדנה'),
  ('category', 'הצגה'),
  ('category', 'הופעה'),
  ('category', 'הפעלה'),
  ('category', 'הרצאה'),
  ('category', 'משחקייה'),
  ('category', 'סיור'),
  ('category', 'ספורט'),
  ('category', 'אחר')
ON CONFLICT (kind, name) DO NOTHING;

NOTIFY pgrst, 'reload schema';
