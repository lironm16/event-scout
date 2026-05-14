-- Track how many tickets the watcher still needs. Starts at whatever the user
-- picked when subscribing (NULL = "any amount, just ping me"), decrements
-- whenever they confirm a purchase via the notification's inline buttons,
-- and the row gets removed once the count reaches 0.

ALTER TABLE public.event_watchers
  ADD COLUMN IF NOT EXISTS tickets_needed INTEGER;

NOTIFY pgrst, 'reload schema';
