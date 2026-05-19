-- Google OAuth token store for the per-user Calendar integration.
--
-- One row per (telegram_id) — a user can connect at most one Google
-- account at a time. Re-running /connect_calendar overwrites the row,
-- which is the right behaviour when the user wants to switch
-- accounts.
--
-- Fields:
--   access_token   short-lived (typically 1h) bearer token. We refresh
--                  it lazily in lib/calendarService.js when expires_at
--                  is within 60s of now.
--   refresh_token  long-lived (effectively forever, until the user
--                  revokes consent). The value Google returns ONLY on
--                  the first consent screen if we request
--                  `access_type=offline&prompt=consent`. We persist it
--                  so we can mint new access tokens without bothering
--                  the user again.
--   expires_at     absolute UTC timestamp for the current access_token's
--                  expiry. Set on token grant + on every refresh.
--   scope          space-separated scopes returned by Google. We store
--                  it for diagnostics ("did they consent to the right
--                  scope?") rather than for behaviour.
--
-- Security note: tokens are sensitive. The Supabase service-role key
-- already gates access. We do NOT expose the table via anon/PostgREST.

CREATE TABLE IF NOT EXISTS public.google_oauth_tokens (
  telegram_id    TEXT PRIMARY KEY REFERENCES public.profiles(telegram_id) ON DELETE CASCADE,
  access_token   TEXT NOT NULL,
  refresh_token  TEXT,
  expires_at     TIMESTAMPTZ NOT NULL,
  scope          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.google_oauth_tokens TO postgres, service_role;
-- Intentionally NOT granted to anon / authenticated — the bot uses
-- service_role exclusively. PostgREST will still expose the table on
-- the service_role connection; anon callers can't read it.

NOTIFY pgrst, 'reload schema';
