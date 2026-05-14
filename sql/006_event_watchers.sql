-- 1) Extend events table with sold-out tracking metadata.
ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS is_sold_out  BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS last_checked TIMESTAMPTZ;

UPDATE public.events
   SET is_sold_out = (COALESCE(tickets_left, 0) = 0)
 WHERE is_sold_out IS NULL;

-- 2) Per-event subscription table: when this event becomes available again,
-- notify all telegram_ids in this table.

CREATE TABLE IF NOT EXISTS event_watchers (
  event_id      INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  telegram_id   TEXT NOT NULL REFERENCES profiles(telegram_id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ DEFAULT now(),
  notified_at   TIMESTAMPTZ,
  PRIMARY KEY (event_id, telegram_id)
);

CREATE INDEX IF NOT EXISTS idx_event_watchers_event ON event_watchers (event_id);
CREATE INDEX IF NOT EXISTS idx_event_watchers_user ON event_watchers (telegram_id);

GRANT ALL ON event_watchers TO postgres, anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
