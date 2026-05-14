-- Saved searches — "topic watcher" (the user follows a query, not a single event).
-- When new events are scraped or existing ones come back in stock, the matching
-- pipeline checks each active saved_search for a fit and notifies the user.
--
-- mode = 'one_time'  → auto-archives once tickets_remaining drops to 0.
-- mode = 'recurring' → stays active until user removes it; tickets_remaining
--                      resets to tickets_needed for the next round.
--
-- expires_at lets us auto-archive bounded date ranges that have passed
-- ("סיור עששיות השבוע" → expires the following Saturday).

CREATE TABLE IF NOT EXISTS public.saved_searches (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id       TEXT NOT NULL REFERENCES public.profiles(telegram_id) ON DELETE CASCADE,
  query             TEXT NOT NULL,
  tokens            TEXT[] DEFAULT '{}',
  filters           JSONB  DEFAULT '{}'::jsonb,
  tickets_needed    INTEGER,
  tickets_remaining INTEGER,
  mode              TEXT NOT NULL CHECK (mode IN ('one_time', 'recurring')),
  expires_at        TIMESTAMPTZ,
  last_notified_at  TIMESTAMPTZ,
  archived          BOOLEAN DEFAULT false,
  created_at        TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_saved_searches_user_active
  ON public.saved_searches (telegram_id)
  WHERE archived = false;

CREATE INDEX IF NOT EXISTS idx_saved_searches_active
  ON public.saved_searches (archived, expires_at);

-- Per-(saved_search, event) dedup: prevents notifying the same user about
-- the same event twice from the same saved search. The pair is the PK.
CREATE TABLE IF NOT EXISTS public.saved_search_notifications (
  saved_search_id UUID    NOT NULL REFERENCES public.saved_searches(id) ON DELETE CASCADE,
  event_id        INTEGER NOT NULL REFERENCES public.events(id)         ON DELETE CASCADE,
  notified_at     TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (saved_search_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_saved_search_notif_event
  ON public.saved_search_notifications (event_id);

GRANT ALL ON public.saved_searches               TO postgres, anon, authenticated, service_role;
GRANT ALL ON public.saved_search_notifications   TO postgres, anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
