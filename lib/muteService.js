// 🔕 Notification mute — stop bot pushes/newsletter mentions about an event or
// its series, WITHOUT removing it from the Mini App catalog (distinct from the
// profile suppressions behind "🚫 אל תראה לי יותר").
//
// Keyed by a stable identity so muting one occurrence of a recurring series
// (e.g. the weekly playspace) silences the whole series:
//   • umbrella_slug present → "umb:<slug>"
//   • otherwise             → "evt:<id>"
const supabase = require("./supabase");

function muteKeyForEvent(event) {
  if (!event) return null;
  if (event.umbrella_slug) return `umb:${event.umbrella_slug}`;
  return `evt:${event.id}`;
}

// Resolve the mute key for an event id (fetches umbrella_slug).
async function muteKeyForEventId(eventId) {
  const { data } = await supabase
    .from("events")
    .select("id, umbrella_slug")
    .eq("id", parseInt(eventId, 10))
    .maybeSingle();
  return muteKeyForEvent(data || { id: parseInt(eventId, 10) });
}

async function muteEventNotifications(telegramId, eventId) {
  const key = await muteKeyForEventId(eventId);
  const { error } = await supabase
    .from("muted_notifications")
    .upsert(
      { telegram_id: String(telegramId), mute_key: key },
      { onConflict: "telegram_id,mute_key" },
    );
  if (error) throw new Error(`muteEventNotifications failed: ${error.message}`);
  return key;
}

async function unmute(telegramId, muteKey) {
  await supabase
    .from("muted_notifications")
    .delete()
    .eq("telegram_id", String(telegramId))
    .eq("mute_key", muteKey);
}

// The user's muted keys as a Set. Returns empty on any error (incl. the table
// not existing yet) so notifications are never accidentally blocked.
async function getMutedKeys(telegramId) {
  const { data, error } = await supabase
    .from("muted_notifications")
    .select("mute_key")
    .eq("telegram_id", String(telegramId));
  if (error) return new Set();
  return new Set((data || []).map((r) => r.mute_key));
}

/** True if this event is muted for the user, given their pre-fetched key set. */
function isEventMuted(event, mutedKeys) {
  if (!mutedKeys || !mutedKeys.size) return false;
  return mutedKeys.has(muteKeyForEvent(event));
}

module.exports = {
  muteKeyForEvent,
  muteEventNotifications,
  unmute,
  getMutedKeys,
  isEventMuted,
};
