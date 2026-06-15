-- Saved (favorite) events — server-side so a user's bookmarks sync across
-- devices and survive a WebView cache clear / device change (the Mini App is
-- opened from phone, desktop, sometimes a partner's phone).
--
-- Shape: one row per (telegram_id, event_id). The ⭐ in the catalog toggles a
-- row; the "saved only" view reads the user's ids. Mirrors the lightweight
-- pattern of event_reports / watch rows.
--
-- ON DELETE CASCADE on event_id: if an event is hard-deleted, drop its saves
-- (a save for a non-existent event is meaningless). telegram_id is the bot
-- user id (BIGINT, same as elsewhere) — no FK to a users table is required.
--
-- Idempotent: IF NOT EXISTS throughout.

BEGIN;

CREATE TABLE IF NOT EXISTS public.saved_events (
  telegram_id BIGINT      NOT NULL,
  event_id    BIGINT      NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (telegram_id, event_id)
);

COMMENT ON TABLE public.saved_events IS
  'User bookmarks ("⭐ שמורים") — one row per (telegram_id, event_id). Toggled from the catalog; read by the saved-only view.';

-- Fast "all of this user's saved ids" lookup for the saved-only view.
CREATE INDEX IF NOT EXISTS saved_events_telegram_id_idx
  ON public.saved_events (telegram_id);

NOTIFY pgrst, 'reload schema';

COMMIT;
