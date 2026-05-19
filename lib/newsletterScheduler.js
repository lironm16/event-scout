// Newsletter scheduler — buffer-flush model (May-2026 v2 spec).
//
// Replaces the v1 weekly digest cadence (every Thursday 18:00 IL)
// with an immediate-with-5-min-buffer flow:
//
//   1. After each scrape cycle (api/check.js), the service calls
//      `enqueueAfterScrape()` to fan out newly-arrived events into
//      per-user buffers (lib/newsletterBuffer.js).
//   2. The scheduler ticks every 30s, checks which buffers have
//      elapsed their 5-min window, and flushes them via the
//      injected `renderUserDigest` renderer (in bot/telegramBot.js).
//   3. After a successful flush we bump `user_newsletter_state.
//      last_sent_at` so the next enqueue cycle's
//      `first_seen_at > last_sent_at` predicate filters the same
//      event back out.
//
// Low-stock alerts (lib/lowStockNotifier.js) bypass this scheduler
// entirely — they fire IMMEDIATELY from api/check.js with their own
// per-(event, user) dedup. The spec's "low-stock = priority, no
// buffer wait" requirement is satisfied that way.

const supabase = require("./supabase");
const buffer = require("./newsletterBuffer");
const {
  filterAtFlush,
  enqueueRecentEvents,
  generateUserNewsletter,
  markNewsletterDelivered,
} = require("./newsletterService");
const { annotateSemanticMatches } = require("./semanticAnnotator");

// Flush check every 30s. Tighter than the 5-min buffer window so
// we don't over-shoot the elapsed boundary by more than ~15s on
// average. Cheap loop — single Map iteration per tick when no
// buffers are due.
const FLUSH_TICK_MS = 30 * 1000;

let _intervalHandle = null;
let _bot = null;
let _renderer = null;

function start({ bot, renderUserDigest } = {}) {
  if (_intervalHandle) {
    console.warn("[NewsletterScheduler] already running — start() ignored");
    return;
  }
  if (!bot?.telegram || typeof renderUserDigest !== "function") {
    throw new Error("[NewsletterScheduler] start({ bot, renderUserDigest }) required");
  }
  _bot = bot;
  _renderer = renderUserDigest;
  _intervalHandle = setInterval(() => flushTickSafe(), FLUSH_TICK_MS);
  if (_intervalHandle.unref) _intervalHandle.unref();
  console.log(
    `[NewsletterScheduler] started — buffer-flush every ${FLUSH_TICK_MS / 1000}s, window=${buffer.BUFFER_MS / 1000}s`,
  );
}

function stop() {
  if (_intervalHandle) clearInterval(_intervalHandle);
  _intervalHandle = null;
  _bot = null;
  _renderer = null;
}

async function flushTickSafe() {
  try {
    await flushTick();
  } catch (err) {
    console.error(`[NewsletterScheduler] flush tick error: ${err.message}`);
  }
}

async function flushTick() {
  if (!_renderer || !_bot) return;
  const due = buffer.getDueBuffers();
  if (!due.length) return;
  console.log(
    `[NewsletterScheduler] flushing ${due.length} buffer(s) (${buffer.stats().events} events queued)`,
  );

  for (const { telegramId, buf } of due) {
    // Consume FIRST so any concurrent enqueue during the async
    // render lands in a fresh buffer (next tick). Without this the
    // late-arriving event would be silently dropped when we clear
    // at the end.
    const consumed = buffer.consume(telegramId);
    if (!consumed || !consumed.events.size) continue;

    try {
      // Re-check the paused flag at flush time so a user who
      // toggles /newsletter_off DURING the buffer window still
      // sees the deferred delivery suppressed.
      const { data: state } = await supabase
        .from("user_newsletter_state")
        .select("paused")
        .eq("telegram_id", telegramId)
        .maybeSingle();
      if (state?.paused) {
        // Drop the buffer; user opted out mid-window. We still
        // bump last_sent_at so the same events don't re-enqueue
        // next cycle — pausing means "I don't want these now",
        // not "save them for whenever I unpause".
        await markNewsletterDelivered(telegramId);
        continue;
      }

      // Load the profile once for the flush-time proximity filter.
      const { data: profile } = await supabase
        .from("profiles")
        .select("telegram_id, user_context")
        .eq("telegram_id", telegramId)
        .maybeSingle();
      if (!profile) continue;

      const candidateEvents = [...consumed.events.values()];
      const finalEvents = await filterAtFlush(candidateEvents, profile);
      if (!finalEvents.length) {
        // Everything got filtered at flush (typically proximity).
        // Still mark delivered so we don't loop on the same set.
        await markNewsletterDelivered(telegramId);
        continue;
      }
      // Annotate any events that pass a semantic profile match for
      // this user (best-effort — failures leave events unchanged and
      // they get delivered as plain cards). The annotator mutates
      // each matched event in place by setting `event._semanticMatch
      // = { label_id, label_name }`; the renderer reads this to add
      // the "🆕 חדש בקטלוג" subtitle + ➕/📭 buttons.
      await annotateSemanticMatches(finalEvents, profile);
      await _renderer(_bot, telegramId, finalEvents);
      await markNewsletterDelivered(telegramId);
    } catch (err) {
      console.error(
        `[NewsletterScheduler] flush ${telegramId} failed: ${err.message}`,
      );
    }
  }
}

/**
 * Called from api/check.js after each scrape (Smarticket + city)
 * completes. Pulls events with `first_seen_at` in the recent past
 * (lookback handled inside enqueueRecentEvents) and enqueues each
 * for every qualifying user.
 *
 * No-op if the scheduler hasn't been started (i.e. running a
 * one-shot `npm run check` outside the bot process).
 */
async function enqueueAfterScrape() {
  if (!_renderer) return;
  try {
    const stats = await enqueueRecentEvents();
    if (stats.enqueued) {
      console.log(
        `[NewsletterScheduler] enqueued ${stats.enqueued} (event×user) across ${stats.users} user(s) from ${stats.events} recent event(s)`,
      );
    }
  } catch (err) {
    console.error(`[NewsletterScheduler] enqueue error: ${err.message}`);
  }
}

/**
 * Admin /newsletter_now path — bypass the buffer, do a one-shot
 * generation across the user's whole "new since last delivery"
 * window. Kept for testing copy + content quality without waiting
 * for the next scrape cycle to fire.
 */
async function deliverOne(bot, telegramId) {
  if (!_renderer) {
    // Allow operator triggers even when the scheduler isn't running
    // (e.g. one-shot script): fall back to direct render.
    _renderer = bot.__newsletterRenderer || null;
  }
  if (!_renderer) return;
  const result = await generateUserNewsletter(telegramId);
  if (result.reason === "no_profile") return;
  if (result.reason === "empty") {
    await markNewsletterDelivered(telegramId);
    return;
  }
  await _renderer(bot, telegramId, result.events);
  await markNewsletterDelivered(telegramId);
}

/**
 * User-facing /newsletter_preview path — same content generation
 * as deliverOne, but DOES NOT call markNewsletterDelivered. Two
 * consequences flow from that:
 *
 *   1. The user's next REAL Thursday digest is unaffected — they
 *      still get the full week's events, including the ones they
 *      just previewed. Otherwise the preview would silently
 *      "consume" the pending events and the real digest would
 *      arrive empty.
 *
 *   2. The function is idempotent for self-service curiosity:
 *      tapping the preview button 5 times in a row delivers the
 *      same 5 sets of cards instead of an empty stream after the
 *      first one.
 *
 * Return shape is meant for the caller's follow-up UX (empty
 * message vs "delivered N events" toast).
 */
async function deliverPreview(bot, telegramId) {
  if (!_renderer) {
    _renderer = bot.__newsletterRenderer || null;
  }
  if (!_renderer) {
    return { reason: "renderer_unavailable", delivered: 0 };
  }
  const result = await generateUserNewsletter(telegramId);
  if (result.reason === "no_profile") {
    return { reason: "no_profile", delivered: 0 };
  }
  if (result.reason === "empty") {
    return { reason: "empty", delivered: 0 };
  }
  await _renderer(bot, telegramId, result.events);
  return { reason: "ok", delivered: result.events.length };
}

module.exports = {
  start,
  stop,
  flushTick,
  enqueueAfterScrape,
  deliverOne,
  deliverPreview,
  FLUSH_TICK_MS,
};
