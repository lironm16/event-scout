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
const { getProfile, saveProfile, updatePreferences } = require("../bot/profileService");

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

// ─────────────────────────────────────────────────────────────────────────
// Positive learning signal (⭐ מעניין אותי)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Called when the user taps "⭐ מעניין אותי" on an event card.
 *
 * Mirrors the negative signal (recordNotInterestedSignal) but in reverse:
 *   - Boosts the event's category weight by +20% (compound, capped at 2.0)
 *   - Boosts each of the event's tag weights by +10% (compound, capped at 2.0)
 *
 * This is the Netflix / Facebook "like" signal: it teaches the algorithm
 * what the user enjoys so future search results surface more of the same.
 * It does NOT imply the user is attending the event.
 *
 * Silently no-ops if the event or profile can't be fetched.
 */
async function recordPositiveSignal(telegramId, eventId) {
  try {
    const { data: ev } = await supabase
      .from("events")
      .select("category, tag_ids")
      .eq("id", parseInt(eventId, 10))
      .maybeSingle();
    if (!ev) return;

    const profile = await getProfile(telegramId);
    const prefs = profile?.user_context?.preferences || {};
    const adjustments = [];

    // Boost category (+20% compounding, cap at 2.0)
    if (ev.category) {
      const cur = prefs.category_weights?.[ev.category] ?? 1.0;
      const next = Math.min(cur * 1.2, 2.0);
      adjustments.push({ kind: "category", key: ev.category, weight: next });
    }

    // Boost individual tags (+10% compounding, cap at 2.0)
    if (Array.isArray(ev.tag_ids) && ev.tag_ids.length) {
      const tagWeights = prefs.tag_weights || {};
      for (const tagId of ev.tag_ids) {
        const cur = tagWeights[tagId] ?? 1.0;
        const next = Math.min(cur * 1.1, 2.0);
        adjustments.push({ kind: "tag", key: String(tagId), weight: next });
      }
    }

    if (adjustments.length) {
      await updatePreferences(telegramId, adjustments);
    }
  } catch (err) {
    console.warn(`[Interests] recordPositiveSignal failed for ${telegramId}: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Negative learning signals
// ─────────────────────────────────────────────────────────────────────────

/**
 * Called when the user picks "לא מעניין אותי" in the feedback reason picker.
 * Applies a compound 30% reduction to the event's category weight each time.
 * The weight is clamped to [0.2, 1.0] — we only reduce, never boost from here,
 * and we never go below `suppress` level (0.2) so one angry tap doesn't fully
 * black-hole a category.
 *
 * We deliberately do NOT suppress individual tags here: tags are narrow
 * (e.g. "שבועות") and a single dislike of one seasonal event shouldn't
 * penalise the whole tag. Category-level suppression is the right granularity.
 *
 * Silently no-ops if the event or profile can't be fetched.
 */
async function recordNotInterestedSignal(telegramId, eventId) {
  try {
    const { data: ev } = await supabase
      .from("events")
      .select("category")
      .eq("id", parseInt(eventId, 10))
      .maybeSingle();
    if (!ev?.category) return; // no category to suppress

    const profile = await getProfile(telegramId);
    const prefs = profile?.user_context?.preferences || {};
    const current = prefs.category_weights?.[ev.category] ?? 1.0;
    // Compound 30% reduction each click; floor at 0.2 (suppress preset)
    const next = Math.max(current * 0.7, 0.2);

    await updatePreferences(telegramId, [
      { kind: "category", key: ev.category, weight: next },
    ]);
  } catch (err) {
    console.warn(`[Interests] recordNotInterestedSignal failed for ${telegramId}: ${err.message}`);
  }
}

/**
 * Called when the user picks "רחוק מדי" in the feedback reason picker.
 * Adds the event's location_key to user_context.preferences.suppressed_locations
 * so future searches silently skip events at that venue.
 *
 * Silently no-ops if the event has no location_key.
 */
async function recordTooFarSignal(telegramId, eventId) {
  try {
    const { data: ev } = await supabase
      .from("events")
      .select("location_key")
      .eq("id", parseInt(eventId, 10))
      .maybeSingle();
    if (!ev?.location_key) return;

    const profile = await getProfile(telegramId);
    const ctx = profile?.user_context || {};
    const prefs = ctx.preferences || {};
    const current = prefs.suppressed_locations || [];

    if (current.includes(ev.location_key)) return; // already suppressed

    const { error } = await supabase
      .from("profiles")
      .update({
        user_context: {
          ...ctx,
          preferences: {
            ...prefs,
            suppressed_locations: [...current, ev.location_key],
          },
        },
      })
      .eq("telegram_id", String(telegramId));
    if (error) throw new Error(error.message);
  } catch (err) {
    console.warn(`[Interests] recordTooFarSignal failed for ${telegramId}: ${err.message}`);
  }
}

module.exports = {
  addInterest,
  removeInterest,
  isInterested,
  getPendingReminders,
  markReminderSent,
  recordInterestSignal,
  recordPositiveSignal,
  recordNotInterestedSignal,
  recordTooFarSignal,
};
