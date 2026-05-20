const supabase = require("./supabase");
const sentry = require("./sentry");

// User feedback on individual events — captured via the "❌ לא מתאים"
// button → reason picker on each event card. The raw log is stored in
// `event_feedback`; this module is the single API for reading/writing it
// and (later) for aggregating it into label-quality signals.
//
// Today this is a write-mostly module: we collect feedback so we have
// labeled data, but we do NOT yet feed it back into the labels pipeline
// (events.audience / events.category — sql/032 ENUM columns).
// Aggregation policy lives here
// (top of file constants) so the data scientists can iterate without
// touching call sites.

const VALID_REASONS = new Set([
  "wrong_audience",
  "too_far",
  "wrong_time",
  "not_interested",
  "already_seen",
  // `already_known` is the SERIES-level "I know this exists; stop
  // bringing it up every newsletter". Different from `already_seen`
  // (which is just "I already saw THIS card"): a user who knows
  // משחקיית רגעים runs every Saturday wants ALL future occurrences
  // suppressed, not just the one in front of them. The handler in
  // telegramBot.js writes the event's (name + location_key) into
  // profile.user_context.known_series, and lib/newsletterService.js
  // filters against that list on every digest.
  "already_known",
  "other",
]);

// Hebrew labels rendered on the reason-picker UI.
const REASON_LABELS = {
  wrong_audience: "👶 לא לקהל הזה",
  too_far: "📍 רחוק מדי",
  wrong_time: "🕒 לא בעיתוי",
  not_interested: "🤷‍♀️ לא מעניין אותי",
  already_seen: "👁️ כבר ראיתי",
  already_known: "🔁 מכירה — אירוע חוזר",
  other: "✏️ אחר",
};

// Short toast text shown after each reason is recorded — confirms what
// the bot heard so the user knows the click did something.
const ACK_LABELS = {
  wrong_audience: "✅ תודה — הפידבק נרשם",
  too_far: "✅ תודה — לא אציג שוב אירועים מהמקום הזה",
  wrong_time: "✅ תודה",
  not_interested: "✅ תודה — אציג פחות מזה",
  already_seen: "✅ תודה",
  already_known: "✅ הבנתי — לא אציג שוב את הסדרה הזו",
  other: "✅ תודה",
};

// Track whether sql/022_event_feedback.sql has been applied. If not, we
// log the feedback to console and return a sentinel — the user gets a
// "thank you" toast either way, and we don't lose the event because of a
// missing migration.
let _tableMissing = null;

async function recordFeedback({ eventId, telegramId, reason, note = null }) {
  if (!eventId || !telegramId || !VALID_REASONS.has(reason)) {
    throw new Error(`Invalid feedback: event=${eventId} reason=${reason}`);
  }
  const row = {
    event_id: parseInt(eventId, 10),
    telegram_id: String(telegramId),
    reason,
    note: note || null,
  };
  const { data, error } = await supabase
    .from("event_feedback")
    .insert(row)
    .select()
    .single();
  if (error) {
    // "Table missing" can surface in several shapes depending on which layer
    // bubbled the error up:
    //   • Raw Postgres → SQLSTATE 42P01 + "relation … does not exist"
    //   • PostgREST/supabase-js → "PGRST205" + "Could not find the table …
    //     in the schema cache" (this is what supabase actually returns to
    //     us today — the SDK never sees the raw 42P01, since PostgREST
    //     resolves table names against its cached schema BEFORE issuing
    //     SQL).
    // We accept either shape so a missing migration degrades to "ack the
    // user, drop the data, alert ops" instead of throwing in the bot
    // handler and showing the user "⚠️ לא הצלחתי לשמור".
    const msg = error.message || "";
    const tableMissing =
      error.code === "42P01" ||
      error.code === "PGRST205" ||
      /relation .* does not exist/i.test(msg) ||
      /Could not find the table .* in the schema cache/i.test(msg);
    if (tableMissing) {
      if (!_tableMissing) {
        _tableMissing = true;
        console.warn(
          "[Feedback] event_feedback table missing — apply sql/022_event_feedback.sql to start collecting labels. Dropping current event.",
        );
        // One-shot Sentry alert per process so the operator sees the
        // dropped-data risk without each click spamming the inbox.
        sentry.captureAlert({
          severity: "warning",
          code: "feedback_table_missing",
          message: "event_feedback table is missing — feedback is being silently dropped",
          context: {
            firstDroppedEvent: eventId,
            hint: "apply sql/022_event_feedback.sql in Supabase",
          },
        });
      }
      return { skipped: true, reason: "migration_pending" };
    }
    throw new Error(`Record feedback failed: ${error.message}`);
  }
  console.log(
    `[Feedback] user=${telegramId} event=${eventId} reason=${reason}` +
    (note ? ` note="${note.slice(0, 60)}"` : ""),
  );
  return data;
}

async function userHasRejectedEvent(telegramId, eventId) {
  const { data, error } = await supabase
    .from("event_feedback")
    .select("id")
    .eq("telegram_id", String(telegramId))
    .eq("event_id", parseInt(eventId, 10))
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error(`[Feedback] userHasRejectedEvent failed: ${error.message}`);
    return false;
  }
  return !!data;
}

module.exports = {
  recordFeedback,
  userHasRejectedEvent,
  VALID_REASONS,
  REASON_LABELS,
  ACK_LABELS,
};
