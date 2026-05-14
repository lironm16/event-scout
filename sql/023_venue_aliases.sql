-- venue_aliases — adaptive memory of "what does this short user phrase mean?".
--
-- Online Bayesian counting: every time the user confirms (or implicitly
-- accepts) a mapping from `alias_norm` → `location_key`, we bump
-- `confidence`. When confidence crosses the per-scope threshold, the
-- agent skips its confirmation prompt entirely.
--
-- Two scopes:
--   - 'user'   : private to one Telegram user. High value, low risk
--                because we only learn from THEIR own confirmations.
--   - 'global' : shared across all users. Populated automatically once
--                ≥2 distinct users converged on the same mapping with
--                user-confidence ≥ 1.0 (see lib/venueMemory.js).
--
-- We keep the raw signal log (one row per confirmation/correction) in
-- `venue_alias_signals` so future calibration / promotion logic can
-- replay history without losing fidelity. The `venue_aliases` row holds
-- the rolled-up score we look up at runtime.

CREATE TABLE IF NOT EXISTS public.venue_aliases (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alias_norm    TEXT NOT NULL,
  location_key  TEXT NOT NULL REFERENCES public.locations(key) ON DELETE CASCADE,
  scope         TEXT NOT NULL CHECK (scope IN ('user', 'global')),
  telegram_id   TEXT,
  confidence    REAL NOT NULL DEFAULT 0,
  hit_count     INTEGER NOT NULL DEFAULT 0,
  last_used_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A per-user mapping is unique by (alias, location, user); a global
  -- mapping has telegram_id NULL and is unique by (alias, location).
  CONSTRAINT venue_aliases_user_unique
    UNIQUE (alias_norm, location_key, scope, telegram_id),
  -- scope='user' MUST have telegram_id; scope='global' MUST be null.
  CONSTRAINT venue_aliases_scope_consistency CHECK (
    (scope = 'user'   AND telegram_id IS NOT NULL) OR
    (scope = 'global' AND telegram_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_venue_aliases_user_lookup
  ON public.venue_aliases (telegram_id, alias_norm)
  WHERE scope = 'user';

CREATE INDEX IF NOT EXISTS idx_venue_aliases_global_lookup
  ON public.venue_aliases (alias_norm)
  WHERE scope = 'global';

CREATE INDEX IF NOT EXISTS idx_venue_aliases_promo_check
  ON public.venue_aliases (alias_norm, location_key)
  WHERE scope = 'user';


-- venue_alias_signals — append-only log of every confirmation /
-- correction we observe. Used for diagnostics, future ML calibration,
-- and replaying counts if we ever change the weighting model.
CREATE TABLE IF NOT EXISTS public.venue_alias_signals (
  id            BIGSERIAL PRIMARY KEY,
  alias_norm    TEXT NOT NULL,
  location_key  TEXT NOT NULL,
  telegram_id   TEXT NOT NULL,
  signal        TEXT NOT NULL CHECK (signal IN (
    'explicit_confirm',  -- user clicked the candidate in the picker
    'auto_accepted',     -- agent auto-resolved + user proceeded
    'corrected_target',  -- user said "actually I meant THIS one"
    'corrected_source'   -- the OLD mapping the user just rejected
  )),
  weight        REAL NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_venue_alias_signals_alias
  ON public.venue_alias_signals (alias_norm, telegram_id, created_at DESC);

NOTIFY pgrst, 'reload schema';
