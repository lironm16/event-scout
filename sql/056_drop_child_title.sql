-- Drop the `child_title` column added in sql/055 and fold its value
-- back into `name`.
--
-- Background:
--   sql/055 introduced `child_title` as the "bare" per-child title
--   alongside a chained `name` ("<parent> - <child>"). The plan was
--   to use `child_title` for the secondary line of a two-tier title
--   block and keep `name` searchable.
--
--   In practice the chained `name` was awkward (duplicate parent
--   string in every label, search hits surfacing the umbrella name
--   on every child) and `child_title` was always one of two things:
--     - the bare child title (case 2 — shavuot-style)
--     - NULL          (case 3 — active-garden-style, child has no
--                      distinguishing label, name == parent title)
--
--   Cleaner model (May-2026 user request):
--     name           = the bare child title only (or the parent
--                      title verbatim when the child has none).
--     umbrella_title = parent title, or NULL for non-umbrella
--                      events.
--     child_title    = removed (was always either redundant with
--                      `name` or NULL).
--
-- Migration:
--   1. For every row where `child_title IS NOT NULL`, copy it into
--      `name` — this strips the "<parent> - " prefix that sql/055-
--      era code was writing.
--   2. Drop the column.
--
-- No backfill needed for rows where `child_title IS NULL`:
--   - singles / smarticket rows: name already carries the event
--     title and umbrella_title is NULL.
--   - active-garden-style umbrella children: name already carries
--     the parent title verbatim, which is what we want under the
--     new model.

UPDATE public.events
SET name = child_title
WHERE child_title IS NOT NULL
  AND child_title <> name;

ALTER TABLE public.events
  DROP COLUMN IF EXISTS child_title;
