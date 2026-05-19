-- Normalize the event-umbrella relationship into a dedicated table.
--
-- Background:
--   Until now, "umbrella" was a virtual concept: every child event
--   carried `umbrella_slug` (the parent's stable key, indexed since
--   sql/054) and `umbrella_title` (the display string, denormalized
--   onto every child). No row in `events` ever represented the
--   umbrella itself — it was just metadata stamped on N children.
--
--   That made every umbrella-level field (image, access scope,
--   audience, category default) live as N duplicated copies — once
--   per child — and forced cross-cutting fixes (May-2026 image
--   inheritance, access propagation, the category-text-scan in
--   `inferCategoryFromUmbrellaTitle`) to recompute the parent's
--   metadata at scrape time instead of inheriting it cleanly.
--
-- What this adds:
--   1. `umbrellas` table — one row per (source, slug) pair, storing
--      the umbrella's own metadata and "default" hints children can
--      fall back to when their own column is null.
--   2. `events.umbrella_id` — proper FK to `umbrellas(id)`. NULL for
--      singletons (which is the majority of events). Indexed.
--   3. Backfill — populate `umbrellas` from the distinct slugs
--      already present on `events`, and link each child via FK.
--
-- Why "default_*" columns (default_audience / default_category /
-- default_access) instead of authoritative ones:
--   The child-first inheritance rule the bot+enricher already
--   follow ("the child knows itself best; the parent is the last
--   fallback") survives the migration. A child whose own
--   `category` is non-null keeps it; the umbrella's
--   `default_category` is consulted only when the child's column is
--   null. So existing data on `events.category` is NOT overwritten
--   by this migration — we only seed the umbrella's defaults from
--   the most-common child value as a STARTING point for future
--   reads. Phase 2 (read-path swap) will switch the inference chain
--   from text-scanning `umbrella_title` to looking up
--   `umbrellas.default_category` directly.
--
-- Why this migration is non-breaking:
--   No code reads `umbrellas` or `events.umbrella_id` yet. All
--   existing reads still hit `umbrella_slug` / `umbrella_title` on
--   `events`, which we KEEP populated. Phase 2 will add the JOIN-
--   based reads alongside the legacy ones; only after both paths
--   are stable does Phase 3 drop the denormalised columns.
--
-- Idempotency:
--   CREATE TABLE / ADD COLUMN / CREATE INDEX all use IF NOT
--   EXISTS. The backfill uses ON CONFLICT DO NOTHING so re-running
--   the script on an already-populated DB is a no-op for new
--   inserts and only re-runs the UPDATE step (which is idempotent
--   by construction — same source+slug always picks the same
--   umbrella row).

BEGIN;

-- ──────────────────────────────────────────────────────────────────
-- 1. The `umbrellas` table
-- ──────────────────────────────────────────────────────────────────
-- Identity:
--   `source` + `slug` together uniquely identify an umbrella. We
--   carry `source` even though every umbrella today is rg-muni,
--   because the schema needs to be ready for second-city sources
--   (sql/035 already gave `events.source` the same shape).
--
-- Display fields (`title`, `image_url`, `description`,
-- `external_url`):
--   What we'd show on a hypothetical umbrella page or in
--   "📋 all events in <umbrella>" listings. Populated from the
--   parent payload at scrape time (Phase 2); for now the backfill
--   below seeds them from the child rows that already carry the
--   same data.
--
-- Default fields (`default_audience` / `default_category` /
-- `default_access`):
--   Inheritance HINTS, not authoritative values. The child-first
--   rule means children's own non-null values always win; these
--   are only consulted when the child column is null. Populated
--   below from MODE() over existing children — the most-common
--   value is the umbrella's likely default.
-- `source` matches `events.source` exactly — `source_t` enum (sql/035)
-- rather than TEXT. Without this the join in step 4 fails with
-- "operator does not exist: source_t = text" because Postgres
-- doesn't auto-cast between enum and text on equality.
CREATE TABLE IF NOT EXISTS public.umbrellas (
  id               BIGSERIAL PRIMARY KEY,
  source           public.source_t NOT NULL,
  slug             TEXT NOT NULL,
  title            TEXT NOT NULL,
  external_url     TEXT,
  image_url        TEXT,
  description      TEXT,
  default_audience public.audience_t,
  default_category public.category_t,
  default_access   public.access_t,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, slug)
);

COMMENT ON TABLE public.umbrellas IS
  'One row per (source, slug) umbrella. Children link via events.umbrella_id. default_* columns are inheritance hints — child values always override.';

-- ──────────────────────────────────────────────────────────────────
-- 2. The events.umbrella_id FK column
-- ──────────────────────────────────────────────────────────────────
-- Nullable on purpose: singletons (most events) have no umbrella.
-- ON DELETE SET NULL so orphaning an umbrella doesn't cascade-
-- delete its children (we'd rather keep the events and lose the
-- grouping than the inverse).
ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS umbrella_id BIGINT
    REFERENCES public.umbrellas(id) ON DELETE SET NULL;

-- Index matches the predicate the bot uses for "all siblings"
-- queries (the umb:<slug> callback equivalent in Phase 2).
-- Partial index because the vast majority of rows have
-- umbrella_id IS NULL (singletons) — no point indexing those.
CREATE INDEX IF NOT EXISTS events_umbrella_id_idx
  ON public.events (umbrella_id)
  WHERE umbrella_id IS NOT NULL;

-- ──────────────────────────────────────────────────────────────────
-- 3. Backfill `umbrellas` from existing children
-- ──────────────────────────────────────────────────────────────────
-- Aggregate every (source, umbrella_slug) group on `events` into
-- one umbrella row. The aggregation choices:
--   - `title` = MAX — within a slug, all children carry the
--     identical title (sql/054 guarantee), so MAX/MIN/any-single
--     pick is equivalent. MAX is deterministic.
--   - `image_url` = MAX(image) — same logic, all children inherit
--     the parent's image today (set by buildCityChildEventRow).
--   - `default_audience` / `default_category` / `default_access` =
--     MODE() over non-null child values. MODE picks the most-
--     common — i.e. "what most of this umbrella's children say".
--     A handful of off-cohort children (e.g. one party inside a
--     lectures umbrella) don't drag the default; the lectures
--     value still wins.
--     `FILTER (WHERE … IS NOT NULL)` keeps the mode insensitive to
--     children whose own column was null.
INSERT INTO public.umbrellas (
  source, slug, title, image_url,
  default_audience, default_category, default_access
)
SELECT
  source,
  umbrella_slug,
  MAX(umbrella_title),
  MAX(image),
  MODE() WITHIN GROUP (ORDER BY audience) FILTER (WHERE audience IS NOT NULL),
  MODE() WITHIN GROUP (ORDER BY category) FILTER (WHERE category IS NOT NULL),
  MODE() WITHIN GROUP (ORDER BY access)   FILTER (WHERE access IS NOT NULL AND access <> 'open')
FROM public.events
WHERE umbrella_slug IS NOT NULL
  AND umbrella_title IS NOT NULL
GROUP BY source, umbrella_slug
ON CONFLICT (source, slug) DO NOTHING;

-- ──────────────────────────────────────────────────────────────────
-- 4. Link each child to its umbrella
-- ──────────────────────────────────────────────────────────────────
-- Idempotent: matching by (source, slug) means re-running picks the
-- same umbrella row each time. We only update rows whose
-- umbrella_id is currently NULL, so a partial earlier run can
-- safely resume.
UPDATE public.events e
SET umbrella_id = u.id
FROM public.umbrellas u
WHERE e.source = u.source
  AND e.umbrella_slug = u.slug
  AND e.umbrella_id IS NULL;

-- ──────────────────────────────────────────────────────────────────
-- 5. Refresh PostgREST schema cache so the API knows about the new
--    table / column.
-- ──────────────────────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';

COMMIT;
