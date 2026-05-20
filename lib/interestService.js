// Interest service — "⭐ מעניין אותי"
//
// Users can mark any event as interesting. This serves two purposes:
//   1. Reminder: the evening before the event we send a push notification.
//   2. Learning: we store a signal in profiles.user_context.interest_signals
//      so the agent can infer taste across sessions.
//
// Deliberately separate from event_watchers (ticket availability alerts).
// Interests apply to ALL events including free / city events with no tickets.

const supabase = require("./supabase");
const { getProfile, saveProfile } = require("../bot/profileService");

const MAX_INTEREST_SIGNALS = 30; // FIFO cap in user_context

// ─────────────────────────────────────────────────────────────────────────
// Core CRUD
// ─────────────────────────────────────────────────────────────────────────

async function addInterest(telegramId, eventId) {
  const { error } = await supabase
    .from("event_interests")
    .upsert(
      { telegram_id: String(telegramId), event_id: parseInt(eventId, 10) },
      { onConflict: "telegram_id,event_id" },
    );
  if (error) throw new Error(`addInterest failed: ${error.message}`);
}

async function removeInterest(telegramId, eventId) {
  const { error } = await supabase
    .from("event_interests")
    .delete()
    .eq("telegram_id", String(telegramId))
    .eq("event_id", parseInt(eventId, 10));
  if (error) throw new Error(`removeInterest failed: ${error.message}`);
}

async function isInterested(telegramId, eventId) {
  const { data } = await supabase
    .from("event_interests")
    .select("event_id")
    .eq("telegram_id", String(telegramId))
    .eq("event_id", parseInt(eventId, 10))
    .maybeSingle();
  return !!data;
}

// ─────────────────────────────────────────────────────────────────────────
// Reminder queries
// ─────────────────────────────────────────────────────────────────────────

/**
 * Returns all (telegram_id, event) pairs where:
 *   - event.date === targetDate  (ISO "YYYY-MM-DD")
 *   - reminder_sent_at IS NULL
 *   - event is not archived
 */
async function getPendingReminders(targetDate) {
  const { data, error } = await supabase
    .from("event_interests")
    .select(
      "telegram_id, event_id, events!inner(id, name, date, start_time, source, external_url, external_slug, image)",
    )
    .eq("events.date", targetDate)
    .eq("events.archived", false)
    .is("reminder_sent_at", null);

  if (error) throw new Error(`getPendingReminders failed: ${error.message}`);
  return (data || []).map((row) => ({
    telegramId: row.telegram_id,
    event: row.events,
  }));
}

async function markReminderSent(telegramId, eventId) {
  await supabase
    .from("event_interests")
    .update({ reminder_sent_at: new Date().toISOString() })
    .eq("telegram_id", String(telegramId))
    .eq("event_id", parseInt(eventId, 10));
}

// ─────────────────────────────────────────────────────────────────────────
// Learning signal
// ─────────────────────────────────────────────────────────────────────────

/**
 * Append an interest signal to user_context.interest_signals.
 * Signals are capped at MAX_INTEREST_SIGNALS (FIFO — oldest dropped first).
 * Silently no-ops if the event row can't be fetched.
 */
async function recordInterestSignal(telegramId, eventId) {
  const { data: ev } = await supabase
    .from("events")
    .select("name, category, audience, tag_ids")
    .eq("id", parseInt(eventId, 10))
    .maybeSingle();
  if (!ev) return;

  const signal = {
    event_id: parseInt(eventId, 10),
    name: ev.name,
    category: ev.category || null,
    audience: ev.audience || null,
    tag_ids: ev.tag_ids || [],
    at: new Date().toISOString().slice(0, 10),
  };

  try {
    const profile = await getProfile(telegramId);
    const ctx = profile?.user_context || {};
    const existing = Array.isArray(ctx.interest_signals)
      ? ctx.interest_signals
      : [];
    // Prepend new signal, cap list
    const updated = [signal, ...existing].slice(0, MAX_INTEREST_SIGNALS);
    await saveProfile(telegramId, {
      user_context: { ...ctx, interest_signals: updated },
    });
  } catch (err) {
    // Non-critical — don't let signal storage break the main flow
    console.warn(`[Interests] recordInterestSignal failed for ${telegramId}: ${err.message}`);
  }
}

module.exports = {
  addInterest,
  removeInterest,
  isInterested,
  getPendingReminders,
  markReminderSent,
  recordInterestSignal,
};
