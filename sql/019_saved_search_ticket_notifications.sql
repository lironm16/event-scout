-- Track which 2nd-hand WhatsApp tickets have already been notified for
-- each saved search so we don't spam the user when the same listing keeps
-- showing up across scrape cycles.
--
-- Kept separate from `saved_search_notifications` (which has FK to
-- `events.id` integer) because `tickets.id` is a UUID — different types
-- can't share a single column without contortions.

CREATE TABLE IF NOT EXISTS public.saved_search_ticket_notifications (
  saved_search_id UUID NOT NULL REFERENCES public.saved_searches(id) ON DELETE CASCADE,
  ticket_id       UUID NOT NULL REFERENCES public.tickets(id)        ON DELETE CASCADE,
  notified_at     TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (saved_search_id, ticket_id)
);

CREATE INDEX IF NOT EXISTS idx_saved_search_ticket_notif_ticket
  ON public.saved_search_ticket_notifications (ticket_id);

GRANT ALL ON public.saved_search_ticket_notifications
  TO postgres, anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
