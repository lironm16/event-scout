-- Convert events.source from TEXT to a native PostgreSQL ENUM.
--
-- Why:
--   Same logic that drove sql/032 (audience / category): `source` is
--   a closed set today (mbe-rg, ramat-gan), it never appears in
--   user-typed input, typos are silent corruption with TEXT, and the
--   set rarely grows. ENUM gives us:
--     - DB-level rejection of typos at INSERT time.
--     - Self-documenting `\d events` output.
--     - Consistency with the rest of the schema (audience_t,
--       category_t already exist).
--
-- Trade-off accepted:
--   Adding a new tenant now requires TWO steps in lockstep:
--     1. Edit lib/sourceUrls.js TENANTS table to add the entry.
--     2. Run a one-line migration:
--          ALTER TYPE public.source_t ADD VALUE 'new-tenant';
--   Forgetting step 2 means INSERT failures with a clear error
--   message — that's the whole point. PostgreSQL also can't drop
--   ENUM values cleanly, so retiring a tenant is messier than for
--   TEXT (annotate as deprecated, leave the value in place).
--
-- Migration order (and the gotchas behind it):
--   1. CREATE TYPE the ENUM. Plain SQL — no DO block. Earlier
--      versions of this file used a DO/IF-NOT-EXISTS wrapper to
--      make re-runs idempotent, but Supabase's SQL editor mis-parses
--      $$-quoted blocks (the statement-splitter splits on the
--      semicolons INSIDE the block, which breaks subsequent
--      statements with a misleading "syntax error at COLUMN").
--      Plain CREATE TYPE will crash if the type already exists,
--      which is fine — migrations are run once.
--   2. DROP the existing DEFAULT. Postgres refuses to auto-cast a
--      TEXT default expression (`'mbe-rg'::text`) to the new ENUM
--      type — the cast logic only runs on row data, not on the
--      DEFAULT clause. So we explicitly remove it before the TYPE
--      change and re-add it cleanly afterwards. Without this you
--      get: ERROR 42804: default for column "source" cannot be
--      cast automatically to type source_t.
--   3. ALTER COLUMN ... TYPE ... USING source::source_t — this
--      re-validates every existing row as part of the cast. Any row
--      with an unknown source aborts the whole transaction. We
--      pre-checked: today every events.source is one of the
--      declared values.
--   4. Re-add the DEFAULT, this time as a source_t literal. The DB
--      DEFAULT ('mbe-rg') is a backstop for code paths that forget
--      to set source explicitly; api/check.js still throws loudly
--      in that case so we don't actually rely on the default in
--      the happy path.
--   5. NOT NULL was already in place from sql/034 and survives the
--      type conversion; no need to re-declare. The index from
--      sql/034 on `source` also survives.

BEGIN;

-- Drop any orphan source_t type from a previously-failed run. Safe
-- because no column references it yet (the column conversion would
-- have to succeed for that to be the case, and if conversion ran
-- successfully you wouldn't be re-running this file). Without this
-- guard you get "ERROR 42710: type source_t already exists" on the
-- second attempt — which is exactly what happens when Supabase's
-- SQL editor auto-commits CREATE TYPE before a later ALTER fails.
DROP TYPE IF EXISTS public.source_t;

CREATE TYPE public.source_t AS ENUM ('mbe-rg', 'ramat-gan');

ALTER TABLE public.events
  ALTER COLUMN source DROP DEFAULT;

ALTER TABLE public.events
  ALTER COLUMN source TYPE public.source_t
  USING source::public.source_t;

ALTER TABLE public.events
  ALTER COLUMN source SET DEFAULT 'mbe-rg'::public.source_t;

COMMIT;

NOTIFY pgrst, 'reload schema';
