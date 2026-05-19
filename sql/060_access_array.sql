-- Migrate events.access from a single access_t scalar to access_t[]
-- (an array), enabling one event to belong to multiple communities.
--
-- Motivation:
--   The scalar model assumed every event has exactly one access scope.
--   That held until the Russian-community addition (sql/059) exposed
--   real events like "ЛГБТ русскоязычный" that genuinely serve two
--   communities — the LGBTQ group AND the Russian-speaking community.
--   A scalar `community-lgbtq` hides it from Russian speakers; a
--   scalar `community-russian` hides it from Hebrew-reading LGBTQ
--   members. Neither is right.
--
-- New semantics (union / "ANY" matching):
--   An event is visible to a user if ANY element of events.access
--   appears in the user's allowed-scopes set. A user with scopes
--   ['open'] sees all events whose access contains 'open'. A user
--   with scopes ['open', 'community-lgbtq'] additionally sees
--   events tagged ['community-lgbtq', 'community-russian'].
--
-- Index strategy:
--   The old btree index idx_events_access on a scalar is replaced by
--   a GIN index which is the standard Postgres choice for array
--   overlap / containment queries (the `&&` operator used by the
--   PostgREST `overlaps` filter maps directly to GIN).
--
-- Migration:
--   USING ARRAY[access]::access_t[] wraps every existing scalar into
--   a single-element array, preserving all existing classifications.
--   The DEFAULT changes to '{open}' (array literal syntax).
--   NOT NULL is retained.
--
-- Note on ALTER TYPE … USING:
--   Postgres rewrites every row in the table for a type change. On a
--   table of ~800 events this is instant. The table is NOT large
--   enough to require online-migration tooling.

BEGIN;

-- Step 1: drop the old scalar index (it can't cover arrays).
DROP INDEX IF EXISTS idx_events_access;

-- Step 2: drop the scalar default FIRST — Postgres cannot cast the
-- existing default expression 'open'::access_t to access_t[]
-- automatically, so we clear it, change the type, then set the new
-- array form. (Learned from prod run; the USING clause handles
-- existing row data fine, only the DEFAULT expr needs the manual
-- drop-and-reset dance.)
ALTER TABLE public.events ALTER COLUMN access DROP DEFAULT;

-- Step 3: change column type. USING clause wraps each existing scalar
-- in a single-element array. The NOT NULL constraint carries over.
ALTER TABLE public.events
  ALTER COLUMN access
    TYPE public.access_t[]
    USING ARRAY[access]::public.access_t[];

-- Step 4: restore the default in array form.
ALTER TABLE public.events
  ALTER COLUMN access SET DEFAULT '{open}';

-- Step 5: add a GIN index for O(log n) overlap queries.
-- The `&&` (overlaps) operator used by PostgREST `.overlaps()` maps
-- directly to GIN — as efficient as the old btree eq/in.
CREATE INDEX IF NOT EXISTS idx_events_access_gin
  ON public.events USING GIN (access);

NOTIFY pgrst, 'reload schema';
COMMIT;
