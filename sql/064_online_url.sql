-- Add online_url column to events for storing Zoom/Meet/Teams join links.
--
-- Background:
--   City events whose `content.registerLink` points to an online meeting
--   (Zoom, Google Meet, Teams) were previously stored verbatim as
--   `external_url`. This caused the "🔗 פרטים" card button to open Zoom
--   directly instead of the event's city page — confusing and unhelpful
--   for events where the Zoom link is sent later via email anyway.
--
-- What this adds:
--   `online_url` — stores the meeting join link separately.
--   The scraper now puts real booking/registration URLs in `external_url`
--   and Zoom/Meet/Teams URLs in `online_url`. The bot renders a separate
--   "📹 הצטרף למפגש" button when `online_url` is present, while
--   "🔗 פרטים" always points to the city page.
--
-- Backfill:
--   Migrate existing rows where `external_url` already holds a meeting URL.

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS online_url TEXT;

-- Backfill: move existing Zoom/Meet/Teams links from external_url → online_url.
UPDATE public.events
SET
  online_url   = external_url,
  external_url = NULL
WHERE external_url ~ 'zoom\.us/j/|meet\.google\.com/|teams\.microsoft\.com/l/meetup';

NOTIFY pgrst, 'reload schema';
