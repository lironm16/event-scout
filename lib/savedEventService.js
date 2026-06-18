// ⭐ Saved events — the same `saved_events` table the Mini App writes to
// (sql/087), exposed for the bot so a "⭐ שמור" button on a card persists a
// bookmark that shows up in the Mini App's saved list (and vice versa).
const supabase = require("./supabase");

async function isSavedEvent(telegramId, eventId) {
  const { data, error } = await supabase
    .from("saved_events")
    .select("event_id")
    .eq("telegram_id", String(telegramId))
    .eq("event_id", parseInt(eventId, 10))
    .maybeSingle();
  if (error) return false;
  return !!data;
}

async function addSavedEvent(telegramId, eventId) {
  const { error } = await supabase
    .from("saved_events")
    .upsert(
      { telegram_id: String(telegramId), event_id: parseInt(eventId, 10) },
      { onConflict: "telegram_id,event_id" },
    );
  if (error) throw new Error(`addSavedEvent failed: ${error.message}`);
}

async function removeSavedEvent(telegramId, eventId) {
  const { error } = await supabase
    .from("saved_events")
    .delete()
    .eq("telegram_id", String(telegramId))
    .eq("event_id", parseInt(eventId, 10));
  if (error) throw new Error(`removeSavedEvent failed: ${error.message}`);
}

/** Toggle and return the new state (true = now saved). */
async function toggleSavedEvent(telegramId, eventId) {
  const saved = await isSavedEvent(telegramId, eventId);
  if (saved) { await removeSavedEvent(telegramId, eventId); return false; }
  await addSavedEvent(telegramId, eventId);
  return true;
}

module.exports = { isSavedEvent, addSavedEvent, removeSavedEvent, toggleSavedEvent };
