-- 084: developmental READINESS targeting on events (replaces sql/082 dev_stages).
--
-- The binary dev_stages text[] ("kid has reached X") couldn't distinguish a
-- "prepare for X" event from a "for kids already doing X" event, and matched
-- newborns to every prep event. dev_targets carries BOTH the stage and the
-- readiness level it addresses:
--   [{ "stage": "solids", "level": "before" }, …]
-- stage ∈ solids|crawl|walk|talk|wean ; level ∈ before|during|established
-- (na is never stored). Matched against each profile kid's per-stage readiness
-- (lib/devStages.js). Empty [] = no developmental targeting (most events).
--
-- Keeps the old dev_stages column for now (read-compat / safe rollback); it is
-- no longer written. Idempotent.

ALTER TABLE events ADD COLUMN IF NOT EXISTS dev_targets jsonb NOT NULL DEFAULT '[]'::jsonb;

-- GIN index for "events targeting stage/level" containment queries.
CREATE INDEX IF NOT EXISTS idx_events_dev_targets ON events USING gin (dev_targets);

NOTIFY pgrst, 'reload schema';
