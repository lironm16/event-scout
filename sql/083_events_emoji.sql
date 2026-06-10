-- 083: persist the LLM-chosen content emoji on the event.
--
-- The enricher already asks Gemini for a single representative `emoji` (see
-- RESPONSE_SCHEMA), but until now it was computed and DISCARDED. Storing it lets
-- the card icon come from the structured field instead of the TOPIC_RULES regex
-- text-scan (getEventIcon). Falls back to the regex only for rows without an
-- emoji yet, so no regression. Idempotent.

ALTER TABLE events ADD COLUMN IF NOT EXISTS emoji text;

NOTIFY pgrst, 'reload schema';
