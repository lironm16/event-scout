require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });

// Sentry must initialize BEFORE we require modules that could throw
// during their own require time — its `OnUncaughtException` and
// `OnUnhandledRejection` integrations install global hooks at init.
// Keeping this on line 2 ensures Sentry sees errors from the rest of
// the import graph.
const sentry = require("../lib/sentry");
sentry.init();

const { Telegraf, Markup } = require("telegraf");
const { DateTime } = require("luxon");

const { getProfile, saveProfile, profileToBrainShape } = require("./profileService");
const { runMatchingForAllUsers } = require("./matchingService");
const {
  addWatcher,
  setTicketsNeeded,
  decrementTicketsNeeded,
  removeWatcher,
  isWatching,
  getWatchedEvents,
} = require("../lib/watchService");
const {
  listSavedSearches,
  archiveSavedSearch,
  promoteToRecurring: promoteSavedSearchToRecurring,
  decrementTicketsRemaining: decrementSavedSearchRemaining,
  getSavedSearch,
  updateSavedSearch,
} = require("../lib/savedSearchService");
const {
  getTicket, logClick, isStillActive, updateQuantity, markSoldById,
} = require("../lib/ticketService");
const { _saveOffer: saveTicketOfferToDb } = require("../lib/agent/tools/ticketOffer");
const referralService = require("../lib/referralService");
const { flushDueNotifications } = require("../lib/scheduleService");
const { formatHebrewDate, formatTimeRange, formatTagLine, getEventIcon, rtlLine } = require("../lib/eventFormat");
const { normalizeImageUrl } = require("../lib/imageUrl");
const { getBookingUrl } = require("../lib/sourceUrls");
const { runCleanup } = require("../lib/archiveService");
const { getStaticReply } = require("../lib/staticReplies");
const { runAgent } = require("../lib/agent/orchestrator");
const sessionStore = require("../lib/agent/sessionStore");
const { audienceLabel, AUDIENCE_LABELS } = require("../lib/categories");
const {
  INTEREST_CATEGORIES,
  getInterestById,
  getInterestByLabel,
} = require("../lib/interestCategories");
const { enrichPendingEvents } = require("../lib/eventEnricher");
const {
  recordFeedback,
  REASON_LABELS,
  ACK_LABELS,
} = require("../lib/feedbackService");
const venueMemory = require("../lib/venueMemory");
const tracing = require("../lib/tracing");

// ──────────────────────────────────────────────────────────────────────────
// Operator alerts
// ──────────────────────────────────────────────────────────────────────────
//
// We use the existing TELEGRAM_CHAT_ID (the operator's chat — same one
// that gets match notifications) as a poor-man's pager. Two failure
// shapes flow here:
//
//   1. THROWN errors caught at the top of an async handler. These have
//      been alerting since day one via `notifyAdminOfError`.
//   2. SILENT DEGRADATIONS — paths where the code doesn't throw but
//      the user sees a dead-end ("המופעים פגו", "פג תוקף", etc.). The
//      bug that motivated this — a `seq:` button tapped after the
//      30-min in-memory cache expired — produced no log, no exception,
//      no trace error. Just an unhappy user. Without instrumentation
//      we only learn about these when someone tells us. That's the
//      gap `alertAdmin` closes.
//
// Dedupe: an in-process LRU keyed by (code, telegramId, entity_id)
// suppresses repeats of the same logical issue within
// ALERT_DEDUPE_MS. A user who tap-spams a broken button stays one
// ping. A long-running process can't leak unbounded keys — capped at
// ALERT_DEDUPE_MAX entries with FIFO eviction.
//
// `notifyAdminOfError` is preserved as a thin wrapper so existing call
// sites don't churn — it now routes through alertAdmin with a fixed
// `unhandled_error` code.
const ADMIN_CHAT_ID = process.env.TELEGRAM_CHAT_ID || null;
const ALERT_DEDUPE_MS = 10 * 60 * 1000;
const ALERT_DEDUPE_MAX = 500;
const alertDedupe = new Map();

function escapeMarkdown(s) {
  // Telegram's "Markdown" (v1) treats _ * ` [ as control chars. We
  // only emit user-controlled values inside backtick spans, but a
  // value containing a backtick would still break the span. Strip them.
  return String(s).replace(/`/g, "'");
}

async function alertAdmin({
  severity = "error",
  code,
  message = null,
  error = null,
  context = {},
  traceId = null,
}) {
  if (!code) return;

  // Dedupe key: same (code + user + entity) within the window collapses.
  // entity_id falls back through common context keys so callers don't
  // have to remember the canonical name.
  //
  // Dedupe applies to BOTH channels (Telegram + Sentry). Sentry already
  // groups by issue fingerprint server-side, but our dedupe also avoids
  // burning quota on tap-spam scenarios.
  const entityId = context.entityId ?? context.event_id ?? context.seriesId ?? "_";
  const telegramId = context.telegramId ?? "_";
  const dedupeKey = `${code}|${telegramId}|${entityId}`;
  const now = Date.now();
  const last = alertDedupe.get(dedupeKey);
  if (last && now - last < ALERT_DEDUPE_MS) return;
  alertDedupe.set(dedupeKey, now);
  if (alertDedupe.size > ALERT_DEDUPE_MAX) {
    // Maps iterate in insertion order — drop the oldest entry. Cheap
    // FIFO, sufficient since we don't need strict LRU semantics here.
    const oldest = alertDedupe.keys().next().value;
    if (oldest !== undefined) alertDedupe.delete(oldest);
  }

  // Fan out to Sentry first — it's the durable record. The Telegram
  // ping below is the "wake the operator" half; if it flakes (network,
  // rate limit) Sentry still has the issue. captureAlert is a no-op
  // when SENTRY_DSN is unset, so this stays cheap in local dev.
  sentry.captureAlert({ severity, code, message, error, context, traceId });

  // Telegram fan-out. Silently skipped if TELEGRAM_CHAT_ID is unset
  // so the rest of the function (notably the Sentry call above) still
  // runs. Keep this block last so a Telegram send failure can't shadow
  // Sentry delivery.
  if (!ADMIN_CHAT_ID) return;
  const icon = severity === "error" ? "🚨" : "⚠️";
  const lines = [`${icon} *Bot ${severity}* — \`${escapeMarkdown(code)}\``];
  if (message) lines.push(String(message).slice(0, 300));
  if (traceId) lines.push(`trace: \`${escapeMarkdown(traceId)}\``);
  for (const [k, v] of Object.entries(context)) {
    if (v == null) continue;
    const s = typeof v === "string" ? v : JSON.stringify(v);
    lines.push(`${k}: \`${escapeMarkdown(s.slice(0, 200))}\``);
  }
  if (traceId) lines.push(`\n→ /debug ${traceId}`);

  try {
    await bot.telegram.sendMessage(ADMIN_CHAT_ID, lines.join("\n"), {
      parse_mode: "Markdown",
    });
  } catch (notifyErr) {
    console.warn("[Bot] alertAdmin failed:", notifyErr.message);
  }
}

async function notifyAdminOfError({ traceId, telegramId, inputText, err }) {
  return alertAdmin({
    severity: "error",
    code: "unhandled_error",
    message: err?.message || String(err || ""),
    // Pass the actual Error through — Sentry needs the object (not
    // just its message) to build a proper stack-trace fingerprint and
    // group recurring issues.
    error: err instanceof Error ? err : null,
    context: { telegramId, input: inputText },
    traceId,
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Telegraf setup
// ──────────────────────────────────────────────────────────────────────────
//
// handlerTimeout = 90s (Telegraf's own default). The agent enforces a
// stricter AGENT_TOTAL_BUDGET_MS = 75s ceiling on its own loop, so the
// graceful "התקשיתי להבין..." reply ALWAYS fires before this brutal
// last-resort timeout can. If you ever see `telegraf_unhandled` with
// "Promise timed out after 90000ms" in Sentry, it means the agent
// budget guard didn't fire — investigate that first, don't just raise
// this number.
const bot = new Telegraf(process.env.TELEGRAM_TOKEN, { handlerTimeout: 90_000 });

// ──────────────────────────────────────────────────────────────────────────
// Central RTL anchor for ALL outgoing text
// ──────────────────────────────────────────────────────────────────────────
//
// Telegram's bidi algorithm picks paragraph direction from the FIRST
// strong-direction character on each line. Hebrew text whose line starts
// with an English letter, a digit, an emoji-followed-by-Latin, or even
// just punctuation gets resolved as LTR → left-aligned, regardless of
// how much Hebrew sits later in the line.
//
// The fix is a leading U+200F (RLM) on every line. Historically we did
// this manually with `rtlLine()` at each call site, which is fragile:
// every new `ctx.reply(...)` someone adds without remembering the
// wrapper silently regresses alignment — and we now have 47+ direct
// reply call sites plus a handful of `bot.telegram.sendMessage(...)`
// admin broadcasts that bypass the Telegraf context entirely.
//
// Patching `bot.telegram` once at boot turns RTL anchoring into a
// global property of the bot, not a per-handler convention. Every
// outgoing text path — `ctx.reply`, `ctx.replyWithPhoto` caption,
// `ctx.editMessageText`, `bot.telegram.sendMessage` direct calls —
// flows through these five methods. `rtlLine` is idempotent (no-ops
// when the line already starts with U+200F), so the existing
// `rtlLine`-wrapping call sites stay correct and don't double-prefix.
(() => {
  const wrapText = (s) => {
    if (typeof s !== "string" || !s) return s;
    return s.split("\n").map(rtlLine).join("\n");
  };
  const wrapCaption = (extra) => {
    if (extra && typeof extra === "object" && typeof extra.caption === "string") {
      return { ...extra, caption: wrapText(extra.caption) };
    }
    return extra;
  };

  const tg = bot.telegram;

  const origSendMessage = tg.sendMessage.bind(tg);
  tg.sendMessage = (chatId, text, extra) =>
    origSendMessage(chatId, wrapText(text), extra);

  const origSendPhoto = tg.sendPhoto.bind(tg);
  tg.sendPhoto = (chatId, photo, extra) =>
    origSendPhoto(chatId, photo, wrapCaption(extra));

  const origSendDocument = tg.sendDocument.bind(tg);
  tg.sendDocument = (chatId, doc, extra) =>
    origSendDocument(chatId, doc, wrapCaption(extra));

  // Telegraf's edit signatures keep the chat/message/inline IDs up front
  // and put text/extra after them. ctx.editMessageText collapses to the
  // 2-arg form for callbacks, but under the hood Telegraf calls the
  // 5-arg method here.
  const origEditText = tg.editMessageText.bind(tg);
  tg.editMessageText = (chatId, messageId, inlineMessageId, text, extra) =>
    origEditText(chatId, messageId, inlineMessageId, wrapText(text), extra);

  const origEditCaption = tg.editMessageCaption.bind(tg);
  tg.editMessageCaption = (chatId, messageId, inlineMessageId, caption, extra) =>
    origEditCaption(chatId, messageId, inlineMessageId, wrapText(caption), extra);
})();

// Telegram callback queries have a ~15s TTL. If the bot is busy (slow
// agent turn, DB query, cache rebuild) and reaches `answerCbQuery`
// after that, Telegram returns:
//   400: Bad Request: query is too old and response timeout expired
//        or query ID is invalid
// This is a benign, transient signal — the user already moved on,
// there's no actionable bug. Treat it as warn-only and skip the
// Sentry/alertAdmin pipe AND the user-facing apology (we'd be
// shouting into the void: the original card the button belongs to
// is still there and the bot's eventual reply, if any, will land
// underneath).
function isStaleCallbackQuery(err) {
  const msg = err?.message || String(err || "");
  return (
    msg.includes("query is too old") ||
    msg.includes("response timeout expired") ||
    msg.includes("query ID is invalid")
  );
}

// Drop-in replacement for `ctx.answerCbQuery(...)` that survives the
// stale-query failure mode. Use this in any callback handler that
// has follow-up work AFTER the ack (e.g. sending a new keyboard, a
// list, or editing the source message): the ack is a UX nicety but
// the follow-up is the actual feature. If we let a stale ack throw,
// the handler aborts and the user sees nothing happen at all.
//
// Returns true if ack landed, false if it was dropped as stale. Any
// OTHER ack failure (network, malformed response, etc.) still
// propagates — those are bugs we want to know about.
async function safeAck(ctx, text, opts) {
  try {
    await ctx.answerCbQuery(text, opts);
    return true;
  } catch (err) {
    if (isStaleCallbackQuery(err)) return false;
    throw err;
  }
}

bot.catch((err, ctx) => {
  if (isStaleCallbackQuery(err)) {
    // One-line warn so we still see frequency if it explodes (would
    // indicate the bot got systematically slower). No Sentry, no
    // user reply.
    console.warn(
      `[Bot] stale callback query (user ${ctx?.from?.id || "?"}): ${err?.message || err}`,
    );
    return;
  }
  console.error("[Bot] Unhandled handler error:", err?.message || err);
  // Telegraf's bot.catch is the last-resort net — if a handler
  // forgot a try/catch and threw, this fires. Route it through the
  // alertAdmin pipe so Sentry + the OPERATOR's admin chat both
  // record it (the operator IS a Telegram user too — admin alerts
  // go to admin-only TG chat ids, not the affected user's chat).
  //
  // Deliberately NO ctx.reply here. Users should never see error
  // language, "תקלה", apology messages, or "try again later"
  // banners — even softly worded ones. If a handler crashed
  // silently, the user will just notice the bot didn't respond
  // and try again; that's preferable to a confidence-shaking error
  // text in their chat. The operator gets the full picture via
  // Sentry; anything the user actually NEEDS to know belongs in a
  // specific handler's try/catch, not in this last-resort net.
  alertAdmin({
    severity: "error",
    code: "telegraf_unhandled",
    message: err?.message || String(err || ""),
    error: err instanceof Error ? err : null,
    context: { telegramId: ctx?.from?.id },
  }).catch(() => {});
});

// ──────────────────────────────────────────────────────────────────────────
// Concurrency: detach updates from the polling loop
// ──────────────────────────────────────────────────────────────────────────
//
// Telegraf in long-polling mode (node_modules/telegraf/lib/core/network/
// polling.js):
//
//   for await (const updates of this)
//     await Promise.all(updates.map(handleUpdate));
//
// It fetches a BATCH of updates, processes them in parallel, then AWAITS
// the entire batch before fetching the next one. That's a correctness
// choice on Telegraf's side — guarantees no update is lost during a
// crash. But for us it's a UX disaster:
//
//   • A text turn through the agent can take 20-40s (Gemini + DB).
//   • While the bot is mid-turn, the user taps an inline button on an
//     OLD card.
//   • Telegram queues the tap as a new update. But Telegraf won't even
//     call getUpdates again until the current text turn finishes.
//   • By the time the callback handler runs, ~30s have passed. Telegram's
//     15s callback-query TTL is long blown — `answerCbQuery` fails, the
//     spinner stayed live the whole time, the user gave up.
//
// The fix: monkey-patch handleUpdate to fire-and-forget. We track each
// in-flight invocation in a Set for graceful shutdown drain. The polling
// loop's `Promise.all` resolves immediately so the next batch is fetched
// in real time. Net effect: callbacks tapped during a slow agent turn
// are processed within ~1s of the tap, well within the 15s TTL.
//
// Trade-off: we lose Telegraf's "no update lost during crash" guarantee.
// For our scale (low single-digit concurrent users, no money flow) this
// is the right call. If we ever need stronger persistence we can move
// to webhook mode + a real queue (Redis, SQS).
//
// Errors: the original handleUpdate already routes runtime errors
// through bot.catch (registered above), so we don't lose error
// reporting. The patch returns Promise.resolve() to the polling loop,
// not the real promise — so unhandled rejections from handleUpdate
// itself (which would be a Telegraf-internal bug, not a handler error)
// get swallowed. We log them via .catch() to keep visibility.
const _inFlightUpdates = new Set();
const _origHandleUpdate = bot.handleUpdate.bind(bot);
bot.handleUpdate = function patchedHandleUpdate(update, webhookResponse) {
  const promise = _origHandleUpdate(update, webhookResponse).catch((err) => {
    // bot.catch should have eaten handler errors already; anything that
    // bubbles to here is a Telegraf-level surprise we want to see.
    console.error("[Bot] handleUpdate internal error:", err?.message || err);
  });
  _inFlightUpdates.add(promise);
  promise.finally(() => _inFlightUpdates.delete(promise));
  return Promise.resolve();
};

// Graceful shutdown: stop polling first (so no new updates start), then
// wait for in-flight handlers to drain. The drain cap (15s) is below
// most container orchestrators' SIGKILL grace window (30s+). If we hit
// it, in-flight agent turns are abandoned — the user sees nothing land,
// but no data is corrupted (all writes are inside individual atomic
// operations).
async function gracefulShutdown(signal) {
  console.log(
    `[Bot] ${signal} received — stopping polling, draining ${_inFlightUpdates.size} in-flight handlers (max 15s)`,
  );
  try {
    bot.stop(signal);
  } catch (err) {
    console.warn("[Bot] bot.stop threw:", err?.message || err);
  }
  const drainTimeout = new Promise((resolve) => setTimeout(resolve, 15_000));
  await Promise.race([Promise.allSettled([..._inFlightUpdates]), drainTimeout]);
  console.log(`[Bot] Drain done. Exiting.`);
  process.exit(0);
}

// ──────────────────────────────────────────────────────────────────────────
// Liveness — keep the user from staring at silence
// ──────────────────────────────────────────────────────────────────────────
//
// We deliberately do NOT use Telegram's "typing…" chat-action: it implies
// the bot is composing right now, which is a lie when we're actually
// waiting on Supabase / Gemini. Instead we send ONE honest interim text
// reply if BOTH conditions hold after the threshold:
//
//   1. The handler is still running.
//   2. The user hasn't seen ANY response yet (no cards, no text reply).
//
// The second guard fixes a comedy of timing where the agent finishes its
// visible work fast (cards at T=6s, summary at T=10s) but the handler's
// outer wrapper keeps running (tracing/cleanup) until T=18s — at T=15s
// the timer fires and ships "I'm still digging…" AFTER the user has
// already read the answer. The user mocked this in May 2026 ("מצחיק כי
// זה מגיע אחרי התשובה"). Now we only chime in when the user is genuinely
// staring at silence.
//
// `fn` receives `markResponded()` — every code path that sends a
// user-visible message MUST call it. Threaded through `buildAgentCtx`
// so renderers do this automatically.
const INTERIM_REPLY_MS = 20_000;

async function withLiveness(ctx, fn, { interimText } = {}) {
  let done = false;
  let userSawSomething = false;
  const markResponded = () => {
    userSawSomething = true;
  };
  const timer = setTimeout(() => {
    if (done || userSawSomething) return;
    ctx.reply(interimText || "👀 עוד שנייה, אני חופרת בנתונים…").catch(() => {});
  }, INTERIM_REPLY_MS);
  try {
    return await fn({ markResponded });
  } finally {
    done = true;
    clearTimeout(timer);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Periodic Smarticket scrape
// ──────────────────────────────────────────────────────────────────────────
const SCRAPE_MIN_S = parseInt(process.env.SCRAPE_MIN_INTERVAL_S || "60", 10);
const SCRAPE_MAX_S = parseInt(process.env.SCRAPE_MAX_INTERVAL_S || "300", 10);
const ACTIVE_START_HOUR = parseInt(process.env.SCRAPE_ACTIVE_START_HOUR || "8", 10);
const ACTIVE_END_HOUR = parseInt(process.env.SCRAPE_ACTIVE_END_HOUR || "22", 10);
const STARTUP_DELAY_MS = 15_000;

function isInActiveWindow() {
  const hour = DateTime.now().setZone("Asia/Jerusalem").hour;
  return hour >= ACTIVE_START_HOUR && hour < ACTIVE_END_HOUR;
}

function msUntilActiveWindow() {
  const now = DateTime.now().setZone("Asia/Jerusalem");
  if (isInActiveWindow()) return 0;
  let target = now.set({ hour: ACTIVE_START_HOUR, minute: 0, second: 0, millisecond: 0 });
  if (now.hour >= ACTIVE_END_HOUR) target = target.plus({ days: 1 });
  return Math.max(0, target.diff(now).milliseconds);
}

function pickJitteredDelayMs() {
  const wait = msUntilActiveWindow();
  if (wait > 0) return wait + Math.floor(Math.random() * 30 * 60 * 1000);
  const range = Math.max(1, SCRAPE_MAX_S - SCRAPE_MIN_S);
  return (SCRAPE_MIN_S + Math.floor(Math.random() * range)) * 1000;
}

function humanizeMs(ms) {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 90) return `${m}m${s % 60 ? ` ${s % 60}s` : ""}`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
}

async function runScrape() {
  try {
    const check = require("../api/check");
    const result = await check();
    console.log(
      `[Scrape] synced=${result.synced}  archived=${result.cleanup?.archived || 0}  ` +
      `deleted=${result.cleanup?.deleted || 0}  back-in-stock=${result.backInStock?.length || 0}`,
    );
  } catch (err) {
    console.error("[Scrape] failed:", err.message);
  }
  try {
    const enrich = require("../api/enrich");
    const result = await enrich();
    if (result?.updated) {
      console.log(`[Enrich] processed=${result.processed}  updated=${result.updated}  archived=${result.archived}`);
      try {
        const { resolvePending } = require("../lib/locationResolver");
        const stats = await resolvePending();
        if (stats.pending) {
          console.log(`[Enrich] geocoded new venues: ${stats.resolved}/${stats.pending} resolved`);
        }
      } catch (err) {
        console.error("[Enrich] resolvePending failed:", err.message);
      }
    }
  } catch (err) {
    console.error("[Enrich] failed:", err.message);
  }

  // Event enrichment — pulls description from each detail page and
  // asks Gemini to extract structured labels (audience, age_group,
  // activity_type, location_name, family-friendly). Bounded per cycle
  // (default 20) so a flood of new listings can't burn through Gemini
  // quota; the queue drains across the next few scrape cycles. Cache
  // hits (events sharing an MD5 of their description with a previously-
  // enriched event) skip the Gemini call entirely.
  try {
    const stats = await enrichPendingEvents();
    if (stats?.processed) {
      console.log(
        `[Enricher] processed=${stats.processed} classified=${stats.classified} ` +
        `cache_hits=${stats.cacheHits || 0} errors=${stats.errors}`,
      );
    }
  } catch (err) {
    console.error("[Enricher] enrichPendingEvents failed:", err.message);
  }
}

function scheduleNextScrape() {
  const ms = pickJitteredDelayMs();
  const at = DateTime.now().setZone("Asia/Jerusalem").plus({ milliseconds: ms }).toFormat("HH:mm:ss");
  console.log(`[Scrape] Next run in ~${humanizeMs(ms)} (at ${at} Jerusalem)`);
  setTimeout(async () => {
    await runScrape();
    scheduleNextScrape();
  }, ms);
}

setTimeout(async () => {
  if (isInActiveWindow()) await runScrape();
  scheduleNextScrape();
}, STARTUP_DELAY_MS);

setInterval(() => {
  flushDueNotifications(bot.telegram).catch((err) =>
    console.error("[Bot] Flush error:", err.message),
  );
}, 5 * 60 * 1000);

// ──────────────────────────────────────────────────────────────────────────
// Nightly WhatsApp ticket recap — 20:00 Jerusalem time
// ──────────────────────────────────────────────────────────────────────────
//
// Operator-only digest of every currently-active ticket. Sent to
// ADMIN_CHAT_ID so the operator can scan what's still on the market
// before bedtime and follow up on anything they remember closing.
//
// Implementation: poll every 60s and fire when the local clock
// (Asia/Jerusalem) is in the 20:00-20:00:59 minute. Cheaper than
// pulling in a cron lib, and resilient to clock drift (DST, server
// timezone changes) because Luxon handles the zone arithmetic.
//
// Dedupe via a `lastRecapDate` ISO marker (YYYY-MM-DD): once we've
// sent today's recap, skip until tomorrow. Reset on process restart
// — worst case a bot restart at 20:00:30 fires the recap a second
// time the same day, which is an annoyance, not a bug.

const RECAP_HOUR_JERUSALEM = 20;
let _lastRecapDate = null;

function _isRecapTime() {
  const now = DateTime.now().setZone("Asia/Jerusalem");
  return now.hour === RECAP_HOUR_JERUSALEM && now.minute === 0;
}

function _todayJerusalemISO() {
  return DateTime.now().setZone("Asia/Jerusalem").toISODate();
}

setInterval(async () => {
  if (!ADMIN_CHAT_ID) return;
  if (!_isRecapTime()) return;

  const today = _todayJerusalemISO();
  if (_lastRecapDate === today) return; // already sent today
  _lastRecapDate = today;

  try {
    // silentEmpty:true — the nightly recap is push, not pull, so we
    // don't want a "אין כרטיסים פעילים" ping every night when the
    // list is empty. The on-demand /recap flips this to false so
    // the operator gets a clear "nothing to see" response.
    await sendRecap(ADMIN_CHAT_ID, { silentEmpty: true });
    console.log(`[Bot] Nightly recap sent for ${today}`);
  } catch (err) {
    console.error("[Bot] Nightly recap failed:", err.message);
  }
}, 60 * 1000);

// ──────────────────────────────────────────────────────────────────────────
// Card renderers
// ──────────────────────────────────────────────────────────────────────────

// "🔗 פרטים" is rendered as a URL button. We previously tried embedding
// it as an in-text <a href> (parse_mode:"HTML") to skip Telegram's
// "Open this URL?" confirmation dialog, but the dialog fired on the
// hyperlink too in the user's Telegram client, so the trade-off lost
// its only benefit while costing us HTML-escape complexity. Reverted
// May 2026.
function buildDetailsButton(event) {
  const url = getBookingUrl(event);
  if (!url) return null;
  return Markup.button.url("🔗 פרטים", url);
}

function buildNavigateButton(item) {
  if (item._proximity?.reason === "virtual") return null;
  const coords = item._coords || item._proximity?.venue_coords || null;
  const venueText = item._proximity?.navigate_address || item.location || item.venue;
  let url;
  if (coords?.lat != null && coords?.lng != null) {
    const label = venueText ? ` (${venueText})` : "";
    const q = `${coords.lat},${coords.lng}${label}`;
    url = `https://www.google.com/maps?q=${encodeURIComponent(q)}`;
  } else if (venueText) {
    url = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(venueText)}`;
  } else {
    return null;
  }
  return Markup.button.url("🗺️ ניווט", url);
}

// Lazily load + cache the user's profile on `ctx.state` so multiple cards
// rendered in the same Telegraf update don't each round-trip to Supabase.
// Telegraf resets `ctx.state` per update, so this never leaks across users.
async function getCachedUserProfile(ctx) {
  if (!ctx.state) ctx.state = {};
  if (Object.prototype.hasOwnProperty.call(ctx.state, "_profile")) {
    return ctx.state._profile;
  }
  try {
    ctx.state._profile = await getProfile(ctx.from.id);
  } catch {
    ctx.state._profile = null;
  }
  return ctx.state._profile;
}

async function sendEventCard(ctx, event, opts = {}) {
  // `seriesOccurrenceCount` (>=2) signals this card represents a series
  // with multiple occurrences. We show the SOONEST occurrence on the
  // card head and surface "+ עוד N מופעים" + a "כל המופעים" button so
  // the user can pull up the full list without scrolling through 8
  // near-identical cards. We deliberately use "מופע" (showing/instance)
  // rather than "מועד" (date) — siblings can fall on the SAME calendar
  // day at different hours or venues (e.g. lectures-for-age-60-and-over
  // has 2 sessions on 2026-05-10 at the same venue, different topics),
  // and "מועדים נוספים" would be wrong there.
  const seriesCount = Number.isFinite(opts.seriesOccurrenceCount)
    ? opts.seriesOccurrenceCount
    : 1;
  const additionalOccurrences = Math.max(0, seriesCount - 1);
  // `seriesMultiVenue` flags a series whose occurrences span more
  // than one venue (e.g. ביכורי תינוקות runs the same workshop at 6
  // community centres). When true we suppress the representative's
  // venue line — it would mislead the user into thinking ALL dates
  // are at that one place. The per-occurrence venue is shown in the
  // "כל המופעים" list instead, where it's actionable.
  const multiVenue = Boolean(opts.seriesMultiVenue);

  const soldOut = event.tickets_left === 0 || event._is_sold_out;
  const lines = [`${getEventIcon(event)} ${event.name}`];
  if (event.date) lines.push(`📅 ${formatHebrewDate(event.date)}`);
  const timeStr = formatTimeRange(event.start_time, event.end_time);
  if (timeStr) lines.push(rtlLine(`🕐 ${timeStr}`));
  if (multiVenue) {
    lines.push(`📍 מתקיים במספר מיקומים`);
  } else if (event.location) {
    lines.push(`📍 ${event.location}`);
  }
  // Tickets line:
  //   - sold out             → loud red marker
  //   - has a count (smarticket) → "🎫 N כרטיסים"
  //   - tickets_left is NULL (free/unmetered city events, sql/039)
  //     → omit the line entirely. Printing "🎫 null כרטיסים" is the
  //     bug this branch fixes. The user already gets the event title,
  //     date, venue, and a click-through; a "tickets" field that
  //     doesn't apply to free events is just noise.
  if (soldOut) {
    lines.push(`🚫 אזלו הכרטיסים`);
  } else if (event.tickets_left != null) {
    lines.push(`🎫 ${event.tickets_left} כרטיסים`);
  }
  if (additionalOccurrences > 0) {
    // Pluralization: 1 = יחיד, 2+ = רבים. Hebrew has no separate dual
    // form for "מופע" so the same suffix works for 2 and N≥2.
    // We use "מופע" (showing/instance) rather than "מועד" (date) because
    // siblings can fall on the SAME calendar day at different hours or
    // venues — "מועדים נוספים" reads as "additional dates" and is
    // wrong in those cases.
    const moadStr = additionalOccurrences === 1 ? "מופע נוסף" : `${additionalOccurrences} מופעים נוספים`;
    lines.push(`🔁 ${moadStr} בטווח`);
  }
  if (event._proximity?.label) lines.push(event._proximity.label);
  if (event._reason) lines.push(`💡 ${event._reason}`);

  // Tag line — surfaces the topic at-a-glance ("מוזיקה • התפתחות") so
  // the user gets the gist before tapping "פרטים". The renderer uses
  // ORDER (search hits → personal interests → plain) to surface the
  // most relevant tags first inside the (capped) line. No per-tag
  // emojis — the leading 🏷️ is the only glyph on the line.
  if (Array.isArray(event.tags) && event.tags.length) {
    const profile = await getCachedUserProfile(ctx);
    const interests = profile?.user_context?.interests || [];
    const searched = Array.isArray(event._searchedTagNames) ? event._searchedTagNames : [];
    const tagLine = formatTagLine(event.tags, {
      highlight: interests,
      searchHits: searched,
    });
    if (tagLine) lines.push(tagLine);
  }
  // Surface low-confidence audience matches honestly. We surface, never
  // hide — silent classifications still get through to the user, but with
  // a small warning so they can dismiss if irrelevant. The classifier
  // marks 'silent' (no signal at all) and 'inferred_match' but only the
  // first warrants a UI tag.
  const v = event._audience_verdict;
  if (v && v.decision === "include" && v.confidence != null && v.confidence < 0.6 && v.reason) {
    lines.push(v.reason);
  }

  // "🗺️ ניווט" + "🔗 פרטים" share a row when both exist (compact and
  // visually paired — directions next to the event page link). If
  // only one is available it stands alone.
  //
  // Order matters: Telegram lays inline buttons out left-to-right in
  // the order they appear in the array, regardless of the surrounding
  // text's RTL direction. With Hebrew labels we want the primary
  // action ("פרטים") on the RIGHT — closer to where the eye lands
  // first in an RTL message — so it goes SECOND in the array.
  const rows = [];
  const detailsBtn = buildDetailsButton(event);
  const navBtn = buildNavigateButton(event);
  const topRow = [navBtn, detailsBtn].filter(Boolean);
  if (topRow.length) rows.push(topRow);

  // "All occurrences" button — only when this card represents a
  // series (count ≥ 2). The callback ID encodes the representative
  // event id; the handler resolves it via session.lastShownSeries.
  if (additionalOccurrences > 0) {
    rows.push([
      Markup.button.callback(`📋 כל המופעים (${seriesCount})`, `seq:${event.id}`),
    ]);
  }

  if (soldOut) {
    const watching = await isWatching(ctx.from.id, event.id).catch(() => false);
    const watchCb = event._ticketsNeeded
      ? `wt:${event.id}:${event._ticketsNeeded}`
      : `wt:${event.id}`;
    rows.push([
      watching
        ? Markup.button.callback("🔕 בטל מעקב", `unw:${event.id}`)
        : Markup.button.callback("🔔 עדכן אותי אם מתפנה", watchCb),
    ]);
  }

  // Always offer the "not relevant" feedback path. Clicks open a reason
  // picker (`fb:reasons:<event_id>`); we use this both to suppress
  // duplicate notifications for THIS user and to collect labeled data
  // for future audience-classifier calibration.
  rows.push([Markup.button.callback("❌ לא מתאים", `fb:reasons:${event.id}`)]);

  // RTL anchoring: every card line gets an RLM prefix so Telegram lays
  // it out right-to-left regardless of which script the line happens
  // to start with. Without this, a title like "SHAVUOT PARTY +מסיבה
  // בלבן" — strong-LTR at the start — pulls the whole paragraph LTR
  // and the Hebrew tail ends up left-aligned. See
  // `lib/eventFormat.js#rtlLine` for the full rationale.
  const text = lines.map(rtlLine).join("\n");
  const keyboard = Markup.inlineKeyboard(rows);
  const photoUrl = normalizeImageUrl(event.image, event);
  // Telegram caption max is 1024 chars. Most event cards sit ~300-500
  // so we rarely hit it, but if a card grows (lots of tags + reasons)
  // we fall back to text-only rather than truncating mid-line.
  if (photoUrl && text.length <= 1024) {
    try {
      await ctx.replyWithPhoto(photoUrl, {
        caption: text,
        ...keyboard,
      });
      return;
    } catch (err) {
      // Telegram occasionally rejects photo URLs (404, host blocks
      // its UA, image is a tiny placeholder GIF, etc.). Fall through
      // to text — losing the image is better than losing the card.
      console.warn(`[Bot] sendEventCard photo fallback for event ${event.id}: ${err.message}`);
    }
  }
  await ctx.reply(text, keyboard);
}

async function sendTicketCard(ctx, ticket) {
  const icon = getEventIcon({ name: ticket.event_title });
  const lines = [`${icon} ${ticket.event_title}`];
  if (ticket.event_date) lines.push(`📅 ${formatHebrewDate(ticket.event_date)}`);
  const timeStr = formatTimeRange(ticket.event_time, ticket.event_end_time);
  if (timeStr) lines.push(`🕐 ${timeStr}`);
  if (ticket.price) lines.push(`💰 ${ticket.price}`);
  lines.push(`🎟️ ${ticket.quantity}`);
  if (ticket._proximity?.label) lines.push(ticket._proximity.label);

  const row = [];
  if (ticket.seller_phone) row.push(Markup.button.callback("📞 צרי קשר", `ct:${ticket.id}`));
  const navBtn = buildNavigateButton(ticket);
  if (navBtn) row.push(navBtn);

  // RTL anchoring on every line — see sendEventCard for the rationale.
  await ctx.reply(lines.map(rtlLine).join("\n"), row.length ? Markup.inlineKeyboard(row) : undefined);
}

async function sendWatchListCards(ctx, watched) {
  for (const event of watched) {
    if (!event?.id) continue;
    const lines = [`${getEventIcon(event)} ${event.name}`];
    if (event.date) lines.push(`📅 ${formatHebrewDate(event.date)}`);
    const timeStr = formatTimeRange(event.start_time, event.end_time);
    if (timeStr) lines.push(`🕐 ${timeStr}`);
    if (event.location) lines.push(`📍 ${event.location}`);
    // Same NULL-aware rule as the search card above: free/unmetered
    // events (city source, sql/039 → tickets_left = NULL) omit the
    // line entirely instead of printing "אזלו" or a literal "null".
    if (event.tickets_left > 0) {
      lines.push(`✅ ${event.tickets_left} כרטיסים זמינים!`);
    } else if (event.tickets_left === 0) {
      lines.push(`🚫 אזלו הכרטיסים`);
    }
    if (event.tickets_needed != null) lines.push(`📋 מחפשת ${event.tickets_needed} כרטיסים`);

    // RTL anchoring on every line — see sendEventCard for the rationale.
    const text = lines.map(rtlLine).join("\n");
    const rows = [];
    const detailsBtn = buildDetailsButton(event);
    if (detailsBtn) rows.push([detailsBtn]);
    rows.push([Markup.button.callback("🔕 בטל מעקב", `unw:${event.id}`)]);
    const keyboard = Markup.inlineKeyboard(rows);
    const photoUrl = normalizeImageUrl(event.image, event);
    if (photoUrl && text.length <= 1024) {
      try {
        await ctx.replyWithPhoto(photoUrl, {
          caption: text,
          ...keyboard,
        });
        continue;
      } catch (err) {
        console.warn(`[Bot] sendWatchListCards photo fallback for event ${event.id}: ${err.message}`);
      }
    }
    await ctx.reply(text, keyboard);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Saved-search summary helpers (shared between /saved and the agent's
// confirmation tool — registered on the agent ctx as `describeSnapshot`).
// ──────────────────────────────────────────────────────────────────────────
const HEB_MONTHS = [
  "ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני",
  "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר",
];

function shortHebDate(iso) {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const [, , mm, dd] = m;
  const day = parseInt(dd, 10);
  const monthIdx = parseInt(mm, 10) - 1;
  if (monthIdx < 0 || monthIdx > 11) return iso;
  return `${day} ב${HEB_MONTHS[monthIdx]}`;
}

function describeSnapshot(snapshot) {
  if (!snapshot) return "";
  const parts = [];
  const f = snapshot.filters || {};
  if (f.proximity === "walk") parts.push("🚶 רק הליכה");
  if (f.proximity === "drive") parts.push("🚗 רק נסיעה");
  if (f.format === "physical") parts.push("📍 פיזי");
  if (f.format === "virtual") parts.push("🌐 מקוון");
  if (f.audience) parts.push(`👥 ${audienceLabel(f.audience)}`);
  // Ages — appears as "🧒 לגיל 5" or "🧒 לגילאי 4, 9". Surfaced in the
  // compact summary so /saved is faithful to what the matcher actually
  // does after the May-2026 redesign (ages used to live in the label as
  // free text and silently failed to filter).
  if (Array.isArray(f.ages) && f.ages.length) {
    const ageLabel = f.ages.length === 1 ? `לגיל ${f.ages[0]}` : `לגילאי ${f.ages.join(", ")}`;
    parts.push(`🧒 ${ageLabel}`);
  }
  // Topic watcher tags. Previously omitted from the summary which meant
  // /saved showed nothing for tag-only watchers — the user thought they
  // had no filters at all. Cap at 3 visible tags + "+N" overflow so a
  // multi-topic watcher doesn't blow up the compact line.
  if (Array.isArray(f.watch_tag_names) && f.watch_tag_names.length) {
    const names = f.watch_tag_names;
    const shown = names.slice(0, 3).join(", ");
    const more = names.length > 3 ? ` (+${names.length - 3})` : "";
    parts.push(`🏷️ ${shown}${more}`);
  }
  // Tokens (explicit substring-AND on title). Same parity rule as tags
  // — show in the compact summary so /saved reflects every field that
  // can affect matching.
  if (Array.isArray(snapshot.tokens) && snapshot.tokens.length) {
    const shown = snapshot.tokens.slice(0, 3).join(", ");
    const more = snapshot.tokens.length > 3 ? ` (+${snapshot.tokens.length - 3})` : "";
    parts.push(`🔠 בשם: ${shown}${more}`);
  }
  if (f.date_from && f.date_to && f.date_from !== f.date_to) {
    parts.push(`📅 ${shortHebDate(f.date_from)} – ${shortHebDate(f.date_to)}`);
  } else if (f.date_from) {
    parts.push(`📅 ${shortHebDate(f.date_from)}`);
  }
  if (f.time_after) parts.push(`🕐 אחרי ${f.time_after}`);
  if (f.time_before) parts.push(`🕐 לפני ${f.time_before}`);
  if (f.location_label) parts.push(`📍 ${f.location_label}`);
  else if (f.venue) parts.push(`📍 ${f.venue}`);
  if (snapshot.tickets_needed) parts.push(`🎫 ${snapshot.tickets_needed} כרטיסים`);
  return parts.join(" • ");
}

function describeSnapshotDetailed(snapshot) {
  if (!snapshot) return "";
  const f = snapshot.filters || {};
  const lines = [];
  lines.push(rtlLine(`🔍 מה: ${snapshot.query || "(חיפוש כללי)"}`));

  // Audience line: always present so the user can sanity-check the
  // scope. When `filters.audience` is unset (the common case for
  // "track events for my family" intents), we surface that the
  // notifier will fall back to profile-derived defaults — otherwise
  // the user thinks audience is unfiltered and gets confused when
  // adult-only events DON'T fire (rightly, but invisibly).
  if (f.audience === "all") {
    lines.push(`👥 קהל: הכל (ללא סינון)`);
  } else if (f.audience) {
    lines.push(`👥 קהל: ${audienceLabel(f.audience)}`);
  } else {
    lines.push(`👥 קהל: בהתאם לפרופיל שלך`);
  }

  // Ages — emitted only when set. `null` / empty array means "no age
  // filter applied", same default as interactive search.
  if (Array.isArray(f.ages) && f.ages.length) {
    const label = f.ages.length === 1
      ? `לגיל ${f.ages[0]}`
      : `לגילאי ${f.ages.join(", ")}`;
    lines.push(rtlLine(`🧒 גילאים: ${label}`));
  }

  // Topic watcher — first-class summary line. Without this, /saved
  // looked empty for tag-only watchers ("עקבי אחרי אירועי מוזיקה").
  if (Array.isArray(f.watch_tag_names) && f.watch_tag_names.length) {
    lines.push(rtlLine(`🏷️ תגיות: ${f.watch_tag_names.join(", ")}`));
  }

  // Explicit title-substring tokens — shown verbatim so the user knows
  // their watcher is constrained to specific words in event names.
  // Empty / unset is the recommended default; the matcher behaves the
  // same way as if the field were absent.
  if (Array.isArray(snapshot.tokens) && snapshot.tokens.length) {
    lines.push(rtlLine(`🔠 חייב להכיל בשם: ${snapshot.tokens.join(", ")}`));
  }

  if (f.date_from && f.date_to && f.date_from !== f.date_to) {
    lines.push(rtlLine(`📅 מתי: ${shortHebDate(f.date_from)} – ${shortHebDate(f.date_to)}`));
  } else if (f.date_from) {
    lines.push(rtlLine(`📅 מתי: ${shortHebDate(f.date_from)}`));
  } else {
    lines.push(`📅 מתי: כל זמן (בלי הגבלה)`);
  }

  const timeBits = [];
  if (f.time_after) timeBits.push(`אחרי ${f.time_after}`);
  if (f.time_before) timeBits.push(`לפני ${f.time_before}`);
  if (timeBits.length) lines.push(rtlLine(`🕐 שעה: ${timeBits.join(", ")}`));

  if (f.proximity === "walk") {
    lines.push(`🚶 מרחק: רק במרחק הליכה (עד 1.5 ק"מ מהבית)`);
  } else if (f.proximity === "drive") {
    lines.push(`🚗 מרחק: רק במרחק נסיעה`);
  } else if (f.location_key) {
    const label = f.location_label || f.venue || f.location_key;
    lines.push(`📍 מקום: ${label}`);
  } else if (f.venue) {
    lines.push(`📍 מקום: ${f.venue} (טקסט חופשי)`);
  }

  if (f.format === "virtual") lines.push(`🌐 פורמט: רק מקוון`);
  else if (f.format === "physical") lines.push(`📍 פורמט: רק פיזי`);

  if (snapshot.tickets_needed) {
    lines.push(rtlLine(`🎫 כמות: ${snapshot.tickets_needed} כרטיסים`));
  }

  return lines.join("\n");
}

// ──────────────────────────────────────────────────────────────────────────
// Agent-context bridge
// ──────────────────────────────────────────────────────────────────────────
//
// The orchestrator runs against a `ctx` object that bundles everything the
// tools need: telegram renderers, the user's profile, the session, etc.
// We keep all Telegram-specific dependencies behind this one object so the
// tools never import telegraf directly.
//
// `markResponded` (optional) is provided by `withLiveness` and lets the
// outer liveness watchdog know that the user has actually seen content.
// Every renderer here calls it BEFORE sending — if Telegram's API call
// throws, we still want to count this turn as "spoke to the user" so
// we don't pile a stale "I'm still digging…" on top of a fresh error.
function buildAgentCtx(ctx, { traceId, markResponded } = {}) {
  const mark = typeof markResponded === "function" ? markResponded : () => {};
  return {
    traceId: traceId || null,
    tg: {
      reply: (text, markup) => {
        mark();
        // Central RTL wrap for every agent-driven text reply
        // (replyText / askClarification / presentEventResults intro_text
        // / orchestrator fallbacks). Telegram's bidi algorithm picks
        // paragraph direction from the FIRST strong-direction character
        // on each line — so a Hebrew sentence starting with English,
        // a number, punctuation or an emoji gets left-aligned without an
        // RLM prefix. We apply `rtlLine` per-line so every line in a
        // multi-line reply renders correctly. `rtlLine` is idempotent;
        // double-application is a no-op.
        const rtl = String(text || "")
          .split("\n")
          .map(rtlLine)
          .join("\n");
        return ctx.reply(rtl, markup);
      },
      renderEventCard: (event, opts) => {
        mark();
        return sendEventCard(ctx, event, opts);
      },
      renderTicketCard: (ticket) => {
        mark();
        return sendTicketCard(ctx, ticket);
      },
      // Used by the `present_invite_link` agent tool so a free-text
      // request ("איך להזמין חברים?") produces the IDENTICAL output
      // as the /invite command — same link, same share button, same
      // friend-count line.
      renderInviteCard: () => {
        mark();
        return sendInviteCard(ctx);
      },
      // Editable save-preview card. Renders the rich `pse:*` UI that
      // replaced the old static confirm card. The agent calls
      // `present_save_confirmation`, which (via this hook) renders the
      // initial main view; from then on the per-field callbacks edit
      // the card in place.
      renderSavePreview: () => {
        mark();
        return renderSavePreviewCard(ctx, { editInPlace: false });
      },
      // Used by `present_interest_picker`. Opens the same chip-toggle
      // UI as /interests, scoped to the user or their partner.
      // Resolving the partner name happens inside `openInterestsPicker`
      // (reads the profile), so the agent doesn't need to thread it
      // through this call.
      renderInterestPicker: async ({ target = "self" } = {}) => {
        mark();
        let partnerName = null;
        if (target === "partner") {
          try {
            const profile = await getProfile(ctx.from.id);
            partnerName = profile?.user_context?.partner?.name || null;
          } catch {
            // Defensive: if the profile fetch fails we still let the
            // picker open with a generic header. The save handler will
            // refuse to commit without a partner name in profile.
          }
        }
        return openInterestsPicker(ctx, { target, partnerName });
      },
      describeSnapshot: describeSnapshotDetailed,
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Commands
// ──────────────────────────────────────────────────────────────────────────
bot.start(async (ctx) => {
  // Reset the agent session on /start so the user gets a clean slate.
  sessionStore.clearSession(ctx.from.id);

  // Capture referral attribution BEFORE the greeting goes out. The
  // payload arrives via Telegram's deep-link mechanism: a friend
  // tapped https://t.me/<bot>?start=ref_<inviter_id>. We parse the
  // tail and record one row in `referrals`. Order matters: we record
  // FIRST so a network blip during the reply doesn't leave a credit
  // missing — the user can always retry, but the referral fires once.
  //
  // Best-effort: any failure path (malformed payload, FK miss, DB
  // hiccup) is silent. The greeting MUST still happen. The referrer
  // never knows their attempt failed — that's fine, this is a
  // growth-metric not a transaction.
  const payload = ctx.startPayload || (ctx.message?.text?.split(/\s+/)?.[1] ?? null);
  const inviterId = referralService.parseInviterFromPayload(payload);
  if (inviterId) {
    try {
      const res = await referralService.recordReferral({
        inviterTelegramId: inviterId,
        inviteeTelegramId: ctx.from.id,
      });
      if (res.ok && res.recorded) {
        console.log(`[Referrals] ${ctx.from.id} joined via invite from ${inviterId}`);
      } else if (res.ok && !res.recorded) {
        console.log(`[Referrals] ${ctx.from.id} already had a referrer — keeping original`);
      } else if (res.error === "self_referral") {
        // Silent — the user tested their own link. No harm done.
      } else {
        console.warn(`[Referrals] record failed for invitee=${ctx.from.id} inviter=${inviterId}: ${res.error}`);
      }
    } catch (err) {
      console.warn(`[Referrals] unexpected error: ${err.message}`);
    }
  }

  // First-time vs returning detection. The agent creates a profile
  // row the moment it learns ANYTHING durable (gender, address,
  // kids…), so "no profile row" is a reliable proxy for "this user
  // has never gotten past /start". We don't use the in-process
  // session for this — sessions expire after 30 min, and a user
  // returning a week later would get the long welcome on every
  // restart of the bot. The profile row is the durable record.
  //
  // Tradeoff: someone who types /start twice in 5 seconds before
  // sending a real message will see the long welcome both times.
  // That's fine — they haven't seen it as a useful greeting yet.
  let existingProfile = null;
  try {
    existingProfile = await getProfile(ctx.from.id);
  } catch (err) {
    // Profile fetch isn't critical — fall back to the long welcome
    // (better to over-welcome than miss the explanation).
    console.warn(`[Bot] /start getProfile failed: ${err.message}`);
  }

  if (existingProfile) {
    // Returning user. Keep the reply terse — they know the bot
    // already; the value of /start to them is the session reset
    // we did above. /help is included so they can recall the
    // feature overview without typing it from memory.
    await ctx.reply(
      "שיחה חדשה התחילה 🔄\n" +
        "אפשר לכתוב לי על מה לחפש, או לבחור מהתפריט:\n\n" +
        "/profile · /saved · /watching · /invite · /help",
    );
    return;
  }

  // First-timer. The actual content is in sendWelcome() so /help
  // can replay it identically for anyone who wants to re-discover
  // the features later (or for the operator to preview the welcome
  // without nuking their own profile).
  await sendWelcome(ctx);
});

// /help — manual trigger for the welcome / feature overview. Useful
// for two audiences:
//   1. Operator self-test — you can't run "first /start" again
//      without deleting your profile row, so /help is the only way
//      to inspect the welcome render after edits.
//   2. Returning users who forgot what the bot does — runs the
//      same overview that first-timers see. Open to all users (no
//      admin gate) because feature discovery isn't sensitive.
//
// Aliased to /start_help in case Telegram's command list ever
// hides /help by convention — kept under a single registration so
// the two stay byte-identical.
bot.command(["help", "start_help"], async (ctx) => {
  await sendWelcome(ctx);
});

// Centralized welcome renderer. Both bot.start (first-timer branch)
// and the /help command route through here, so a tweak to the
// content lands in exactly one place. The agent's first reply will
// pivot to feminine/masculine based on profile — this welcome
// stays gender-neutral ("ספר/י", "את/ה") because we haven't asked
// yet.
//
// Length is deliberate: each line earns its place by either
// teaching a feature OR setting expectations. Anything more is
// friction in a chat-first product.
async function sendWelcome(ctx) {
  // Escape the first_name against Markdown v1 control chars so a
  // Telegram display name with `_`, `*`, `[`, or `` ` `` doesn't
  // break the sendMessage call with "Bad Request: can't parse
  // entities". The file-level `escapeMarkdown` only strips
  // backticks (tuned for code spans); here we need to neutralize
  // the full set since first_name is interpolated into a
  // top-level bolded greeting.
  const escapeMarkdownStrict = (s) =>
    String(s).replace(/([_*`[\]])/g, "\\$1");
  const firstName = ctx.from?.first_name
    ? `, ${escapeMarkdownStrict(ctx.from.first_name)}`
    : "";
  const lines = [
    `שלום${firstName}! 🎟️ אני הבוט של Event Scout — עוזרת למצוא אירועים, חוגים וכרטיסים ברמת גן.`,
    "",
    "*🎯 למה דרכי:*",
    "🧭 *כל האירועים במקום אחד* — אני מאחדת מקורות שונים, כדי לא לפספס כלום",
    "🎫 *זמינות כרטיסים מראש* — מראה כאן אם נשארו כרטיסים, בלי לגלות באמצע הדרך שהכל אזל",
    "",
    "*✨ מה אפשר לבקש ממני:*",
    "🔍 *לחפש אירועים* — לדוגמה: \"מה יש בשבת בסביבה?\", \"סדנאות לילד בן 4\", \"מוזיקה השבוע\"",
    "🔔 *לעקוב אחרי נושא* — \"תתריעי לי על כל אירוע מוזיקה\", \"תעקבי אחרי סדנאות יצירה\"",
    "🎟️ *להציע התראות לכרטיסים יד-2* — אני מנטרת קבוצות וואטסאפ ומציעה כרטיסים שמתאימים לך",
    "💬 *להציע כרטיס למכירה* — \"יש לי כרטיס נוסף ל…\" ואני אצמיד אותו לאירוע אצלי ואיידע מי שמחכה",
    "",
    "*📋 פקודות זמינות:*",
    "/profile — הפרופיל שלך",
    "/interests — לבחור תחומי עניין מהרשימה",
    "/saved — המעקבים השמורים שלך",
    "/watching — האירועים במעקב שלך",
    "/invite — קישור להזמנת חברים",
    "/help — להציג את התפריט הזה שוב",
    "",
    "כדי שאוכל לעזור באמת — *אשמח להכיר אותך קצת*: איפה הבית, מי בני המשפחה (וגילאים אם יש ילדים), ועל אילו תחומים מעניין לשמוע?",
  ];
  // Inline keyboard surfacing the most common first-step a new user
  // takes — picking interests. Keeps the textual welcome explanatory
  // while giving a single-tap path into onboarding. The button fires
  // the same `ip:start_from_welcome` flow as /interests would, so the
  // experience stays consistent for users who type the slash command
  // instead.
  await ctx.reply(lines.join("\n"), {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "⭐ בחרי תחומי עניין", callback_data: "ip:start_from_welcome" }],
      ],
    },
  });
}

// Button on /start welcome — routes to the same picker /interests opens.
bot.action("ip:start_from_welcome", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  try {
    await openInterestsPicker(ctx, { target: "self" });
  } catch (err) {
    console.error("[Bot] ip:start_from_welcome error:", err.message);
  }
});

// /invite — produces the user's personal share-link and shows how
// many friends they've already brought in. The link is
// deterministic: same telegram_id → same URL, every time. We don't
// require any "active" status for inviting — anyone who's done
// /start can share their link. If the inviter's profile later gets
// deleted, ON DELETE CASCADE on `referrals.inviter_telegram_id`
// scrubs the credits.
bot.command("invite", async (ctx) => {
  try {
    await sendInviteCard(ctx);
  } catch (err) {
    console.error("[Bot] /invite error:", err.message);
    await ctx.reply("⚠️ לא הצלחתי להפיק קישור כרגע. נסי שוב בעוד רגע.");
  }
});

// Shared renderer. The /invite command calls it directly; the agent
// tool present_invite_link ALSO ends up here so a free-text request
// ("איך אני יכולה להזמין חברים?") and the command produce IDENTICAL
// output — promise we made to the operator.
async function sendInviteCard(ctx) {
  const inviterId = String(ctx.from.id);
  const link = await referralService.buildInviteLink(bot.telegram, inviterId);
  const stats = await referralService.listReferralsForUser(inviterId);

  // The share button uses Telegram's built-in share URL — taps open
  // the standard share-sheet with the link pre-filled. The "tg://"
  // scheme variant doesn't carry custom text on all clients, so we
  // use the https form which accepts both `url` and `text` params
  // for the user's caption.
  const sharePrompt = "מצאתי בוט שעוזר למצוא אירועים בסביבה, תיכנס/י דרכי 👇";
  const tgShareUrl =
    `https://t.me/share/url?url=${encodeURIComponent(link)}` +
    `&text=${encodeURIComponent(sharePrompt)}`;

  const lines = [
    "🎟️ *הזמינו חברים ל-Event Scout*",
    "",
    "הנה הקישור האישי שלך — מי שייכנס דרכו ירשם אצלך:",
    "",
    `\`${link}\``,
  ];
  if (stats.count > 0) {
    lines.push("");
    lines.push(
      stats.count === 1
        ? "_עד עכשיו הצטרף חבר אחד דרך הקישור שלך_"
        : `_עד עכשיו הצטרפו ${stats.count} חברים דרך הקישור שלך_`,
    );
  }

  // Two-button row layout:
  //   share  — opens Telegram's share-sheet pre-filled with the link
  //            and a caption (deep-links into contact picker).
  //   copy   — Bot API 8.0 `copy_text` button: a single tap copies the
  //            raw link to clipboard, no surrounding message text. We
  //            pass the raw button object because Telegraf 4.x's
  //            Markup.button helpers don't expose `copy_text` yet.
  //            Older Telegram clients (pre-Nov 2024) that don't
  //            support copy_text degrade to a no-op tap; the share
  //            button + the inline code-span in the message body are
  //            both still available as fallbacks.
  await ctx.reply(lines.join("\n"), {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [
        [{ text: "📤 שתפי בטלגרם", url: tgShareUrl }],
        [{ text: "📋 העתיקי קישור", copy_text: { text: link } }],
      ],
    },
  });
}

bot.command("saved", async (ctx) => {
  try {
    const items = await listSavedSearches(ctx.from.id);
    if (!items.length) {
      await ctx.reply(
        "עדיין לא שמרת חיפושים.\n" +
        "תכתבי לי 'תעקבי אחרי...' ואני אגדיר מעקב.",
      );
      return;
    }

    await ctx.reply(`📂 ${items.length} חיפושים שמורים:`);
    for (const item of items) {
      const summary = describeSnapshot({
        query: item.query,
        tokens: item.tokens,
        tickets_needed: item.tickets_needed,
        filters: item.filters || {},
      });
      const modeLabel = item.mode === "one_time" ? "🎯 פעם אחת" : "♾️ קבוע";
      const lines = [`🔍 ${item.query} — ${modeLabel}`];
      if (summary) lines.push(rtlLine(`📋 ${summary}`));
      if (item.tickets_remaining != null && item.tickets_needed != null) {
        lines.push(`🎫 חסרים ${item.tickets_remaining}/${item.tickets_needed}`);
      }
      const buttonRows = [];
      if (item.mode === "one_time") {
        buttonRows.push([Markup.button.callback("♾️ עדכני גם על עתידיים", `ss:rec:${item.id}`)]);
      }
      // Edit + archive are the two most common follow-up actions, so
      // they sit on a shared row right under the summary. Tapping
      // "ערכי" loads this watcher into the same editable card the
      // create-flow uses, but in "update" mode so save commits via
      // `updateSavedSearch` (preserves id + notification history).
      buttonRows.push([
        Markup.button.callback("✏️ ערכי", `pse:edit:${item.id}`),
        Markup.button.callback("🔕 הפסיקי לעקוב", `ss:rm:${item.id}`),
      ]);
      await ctx.reply(lines.join("\n"), Markup.inlineKeyboard(buttonRows));
    }
  } catch (err) {
    console.error("[Bot] /saved error:", err.message);
    await ctx.reply("⚠️ שגיאה בשליפת החיפושים השמורים.");
  }
});

bot.command("match", async (ctx) => {
  await ctx.reply("🔍 מחפשת התאמות...");
  try {
    const result = await runMatchingForAllUsers(bot.telegram);
    await ctx.reply(result.matched === 0
      ? "לא מצאתי התאמות כרגע. אעדכן אותך!"
      : `✅ נשלחו ${result.notified} התראות.`);
  } catch (err) {
    console.error("[Bot] /match error:", err.message);
    await ctx.reply("⚠️ שגיאה בחיפוש.");
  }
});

bot.command("profile", async (ctx) => {
  try {
    const profile = await getProfile(ctx.from.id);
    if (!profile) {
      await ctx.reply("אין לי פרופיל שלך עדיין. שלחי הודעה ואלמד אותך!");
      return;
    }

    const lines = [`📋 הפרופיל שלך:`];
    if (profile.first_name) lines.push(`👤 ${profile.first_name}`);
    const c = profile.user_context || {};
    if (c.kids?.length) {
      lines.push(`👧 ילדים: ${c.kids.map((k) => (k.age ? `${k.name} (${k.age})` : k.name)).join(", ")}`);
    }
    if (c.constraints) {
      if (c.constraints.home_address) {
        const coords = c.constraints.home_coordinates;
        const coordSuffix = coords ? ` ✓` : ` ⚠️ (לא אותר במפה)`;
        lines.push(`🏠 בית: ${c.constraints.home_address}${coordSuffix}`);
      }
      if (c.constraints.proximity_preference) {
        lines.push(`📏 העדפה: ${c.constraints.proximity_preference}`);
      }
    }
    if (c.interests?.length) lines.push(`⭐ תחומי עניין: ${c.interests.join(", ")}`);
    if (c.partner?.name) {
      const partnerInterests = Array.isArray(c.partner.interests) && c.partner.interests.length
        ? ` — ${c.partner.interests.join(", ")}`
        : "";
      lines.push(
        `❤️ בן/בת זוג: ${c.partner.name}${c.partner.age != null ? ` (${c.partner.age})` : ""}${partnerInterests}`,
      );
    }

    let watched = [];
    try { watched = await getWatchedEvents(ctx.from.id); } catch {}
    if (watched.length) lines.push(`\n🔔 אירועים במעקב (${watched.length}):`);

    // Quick action: jump straight into the interests picker. Most
    // /profile views end with "what can I edit?" — the interests
    // picker is the most common edit target and giving it a single-tap
    // shortcut beats forcing users to type /interests on the next
    // line.
    await ctx.reply(lines.join("\n"), {
      reply_markup: {
        inline_keyboard: [
          [{ text: "⭐ ערכי תחומי עניין", callback_data: "ip:start_from_welcome" }],
        ],
      },
    });
    if (watched.length) await sendWatchListCards(ctx, watched);
  } catch (err) {
    console.error("[Bot] /profile error:", err.message);
    await ctx.reply("⚠️ שגיאה.");
  }
});

// ──────────────────────────────────────────────────────────────────────────
// /interests — INTEREST PICKER
// ──────────────────────────────────────────────────────────────────────────
//
// A toggleable inline keyboard the user opens with `/interests` (or via
// the welcome screen button, or via the agent's `present_interest_picker`
// tool). Each chip is a curated category from `lib/interestCategories.js`;
// the user taps chips to toggle, then "שמרי" to commit.
//
// Why a dedicated UI instead of free-text conversation?
//   1. Cold-start: brand-new users have an empty profile and no idea
//      what tags the bot understands. A chip picker makes the vocabulary
//      visible — they can pick "מוסיקה" without guessing whether
//      "music" or "מוזיקה" or "הופעות חיות" is the canonical phrasing.
//   2. Multi-select: typing 5 interests into a chat is awkward; tapping
//      5 buttons is natural and reversible. Telegram doesn't ship a
//      native multi-select widget — we approximate it by editing the
//      keyboard in place on each tap (chips toggle a ✓ prefix).
//   3. Partner coverage: after the user finishes their own list we can
//      pivot to "ומה של <יובל>?" without forcing them to retype the
//      framing — same chips, fresh selection state.
//
// State lives on `session.interestsPicker` (see sessionStore.js for
// shape). The keyboard's callback_data uses tiny ASCII ids
// (`ip:tog:music`) so we stay under Telegram's 64-byte cap even with
// the longer Hebrew labels.
//
// EXISTING CHIPS — when the picker opens with an already-populated
// `profile.interests`, we pre-select any string that matches a chip
// label exactly. Free-text strings (e.g. older interests like "יין"
// that don't map to a chip) are PRESERVED in the profile but shown
// above the keyboard as a separate "תחומים נוספים" line, so the user
// sees their full history and isn't surprised by what "save" replaces.

function buildInterestsKeyboard(selectedLabels) {
  const selected = new Set(selectedLabels);
  const rows = [];
  // Two chips per row keeps each button wide enough that Hebrew labels
  // don't truncate on narrow phone screens.
  for (let i = 0; i < INTEREST_CATEGORIES.length; i += 2) {
    const row = INTEREST_CATEGORIES.slice(i, i + 2).map((cat) => {
      const checked = selected.has(cat.label);
      const prefix = checked ? "✅ " : "";
      return {
        text: `${prefix}${cat.emoji} ${cat.label}`,
        callback_data: `ip:tog:${cat.id}`,
      };
    });
    rows.push(row);
  }
  // Action row at the bottom — separate from chips so a stray tap on
  // an edge chip doesn't accidentally commit.
  rows.push([
    { text: "💾 שמרי", callback_data: "ip:save" },
    { text: "✏️ אחר...", callback_data: "ip:other" },
    { text: "❌ ביטול", callback_data: "ip:cancel" },
  ]);
  return { inline_keyboard: rows };
}

function buildInterestsHeader({ target, partnerName, extraLabels }) {
  const lines = [];
  if (target === "partner") {
    lines.push(`⭐ *מה ${partnerName || "בן/בת הזוג"} אוהב/ת?*`);
    lines.push("בחרי תחומי עניין כדי שאוכל להציע אירועים שמתאימים גם לו/ה.");
  } else {
    lines.push("⭐ *מה מעניין אותך?*");
    lines.push("בחרי כמה תחומים שתרצי — אשתמש בהם כדי להציע לך אירועים רלוונטיים.");
  }
  if (Array.isArray(extraLabels) && extraLabels.length) {
    // Free-text / legacy entries kept from a previous save. Surface them
    // so the user knows we're not silently dropping anything when they
    // "save" the new chip selection.
    lines.push("");
    lines.push(`_תחומים נוספים שכבר רשומים: ${extraLabels.join(", ")}_`);
  }
  return lines.join("\n");
}

async function openInterestsPicker(ctx, { target = "self", partnerName = null } = {}) {
  const telegramId = ctx.from.id;
  const profile = await getProfile(telegramId).catch(() => null);

  // Seed selection from existing profile data. For "self" we read
  // user_context.interests; for "partner" we read partner.interests.
  // Any label not in our curated chip list goes into `extraLabels` so
  // it's shown but not auto-selected.
  let existing = [];
  if (target === "partner") {
    existing = Array.isArray(profile?.user_context?.partner?.interests)
      ? profile.user_context.partner.interests
      : [];
  } else {
    existing = Array.isArray(profile?.user_context?.interests)
      ? profile.user_context.interests
      : [];
  }
  const selected = [];
  const extraLabels = [];
  for (const raw of existing) {
    if (typeof raw !== "string") continue;
    const chip = getInterestByLabel(raw);
    if (chip) selected.push(chip.label);
    else extraLabels.push(raw.trim());
  }

  const header = buildInterestsHeader({ target, partnerName, extraLabels });
  const keyboard = buildInterestsKeyboard(selected);

  const sent = await ctx.reply(header, {
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });

  sessionStore.setInterestsPicker(telegramId, {
    target,
    partnerName,
    selected,
    extraLabels,
    messageId: sent?.message_id || null,
    chatId: sent?.chat?.id || null,
  });
}

bot.command("interests", async (ctx) => {
  try {
    await openInterestsPicker(ctx, { target: "self" });
  } catch (err) {
    console.error("[Bot] /interests error:", err.message);
    await ctx.reply("⚠️ שגיאה בפתיחת בחירת תחומי עניין.");
  }
});

// Toggle a single chip. Edits the keyboard in place on the SAME message
// so the user sees the ✓ flip without the chat scrolling. Telegram
// silently no-ops `editMessageReplyMarkup` if the markup is byte-
// identical, so the "no change" case (race where the user tapped twice
// fast) is harmless.
bot.action(/^ip:tog:(.+)$/, async (ctx) => {
  const telegramId = ctx.from.id;
  const chipId = ctx.match[1];
  const state = sessionStore.getInterestsPicker(telegramId);
  const chip = getInterestById(chipId);
  if (!state || !chip) {
    await ctx.answerCbQuery("⏰ פג תוקף — שלחי /interests מחדש");
    return;
  }
  const set = new Set(state.selected);
  if (set.has(chip.label)) set.delete(chip.label);
  else set.add(chip.label);
  const nextSelected = Array.from(set);
  sessionStore.updateInterestsPicker(telegramId, { selected: nextSelected });
  await ctx.answerCbQuery(set.has(chip.label) ? `✓ ${chip.label}` : `הוסר: ${chip.label}`);
  try {
    await ctx.editMessageReplyMarkup(buildInterestsKeyboard(nextSelected));
  } catch (err) {
    // "message is not modified" surfaces when the user double-taps the
    // same chip; safe to swallow. Anything else (deleted message,
    // permissions) we just log — the session state stays consistent.
    if (!/not modified/i.test(err.message || "")) {
      console.warn("[Bot] ip:tog edit failed:", err.message);
    }
  }
});

// "אחר..." — switch the picker into a free-text mode. The next text
// message the user sends is parsed as a comma/newline separated list of
// extra interest labels and merged into the selection. We don't
// dismiss the picker UI: the user can keep tapping chips after typing.
bot.action("ip:other", async (ctx) => {
  const telegramId = ctx.from.id;
  const state = sessionStore.getInterestsPicker(telegramId);
  if (!state) {
    await ctx.answerCbQuery("⏰ פג תוקף — שלחי /interests מחדש");
    return;
  }
  sessionStore.updateInterestsPicker(telegramId, { freeTextMode: true });
  await ctx.answerCbQuery("✏️");
  await replyAsCallbackResult(
    ctx,
    "כתבי תחומי עניין נוספים, מופרדים בפסיק (לדוגמה: יין, ריצה, ג׳אז). אחרי שתשלחי — אוסיף אותם לרשימה.",
  );
});

// Commit. Save the selection to the profile and (when target=self and
// a partner exists without interests yet) pivot to a partner picker.
bot.action("ip:save", async (ctx) => {
  const telegramId = ctx.from.id;
  const state = sessionStore.getInterestsPicker(telegramId);
  if (!state) {
    await ctx.answerCbQuery("⏰ פג תוקף");
    return;
  }
  try {
    // Persist: chips selected + any preserved extraLabels so we don't
    // silently drop the user's legacy free-text interests.
    const finalList = Array.from(
      new Set([...(state.selected || []), ...(state.extraLabels || [])]),
    );
    const existingProfile = await getProfile(telegramId);
    const brainShape = existingProfile
      ? profileToBrainShape(existingProfile)
      : { kids: [], partner: null, constraints: null, interests: [] };

    if (state.target === "partner") {
      const partnerName = state.partnerName || existingProfile?.user_context?.partner?.name;
      const partnerAge = existingProfile?.user_context?.partner?.age ?? null;
      if (!partnerName) {
        await ctx.answerCbQuery("⚠️ חסר שם של בן/בת זוג בפרופיל");
        return;
      }
      await saveProfile(
        telegramId,
        { ...brainShape, partner: { name: partnerName, age: partnerAge, interests: finalList } },
        existingProfile,
      );
    } else {
      await saveProfile(
        telegramId,
        { ...brainShape, interests: finalList },
        existingProfile,
      );
    }

    await ctx.answerCbQuery("✅ נשמר");
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});

    const summary = finalList.length
      ? `שמרתי את התחומים: ${finalList.join(", ")} ✨`
      : "שמרתי. בלי תחומי עניין מוגדרים אעדכן עליך בלי סינון לפי נושא.";
    await replyAsCallbackResult(ctx, summary);

    // After saving the USER's own interests, offer a partner picker if
    // a partner exists in profile and we don't yet have their
    // interests. Single follow-up question — user can decline and
    // come back later via /interests on their own.
    if (state.target === "self") {
      const partner = existingProfile?.user_context?.partner;
      const partnerHasNoInterests =
        partner?.name &&
        (!Array.isArray(partner.interests) || partner.interests.length === 0);
      if (partnerHasNoInterests) {
        sessionStore.clearInterestsPicker(telegramId);
        await ctx.reply(
          `רוצה להגדיר גם תחומי עניין של ${partner.name}? (כדי שאוכל להציע גם בילויים זוגיים שמתאימים לשניכם)`,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: `✏️ כן, בואי נגדיר עבור ${partner.name}`, callback_data: "ip:partner:start" },
                  { text: "⏭️ לא עכשיו", callback_data: "ip:partner:skip" },
                ],
              ],
            },
          },
        );
        return;
      }
    }

    sessionStore.clearInterestsPicker(telegramId);
  } catch (err) {
    console.error("[Bot] ip:save error:", err.message);
    await ctx.answerCbQuery("⚠️");
    await replyAsCallbackResult(ctx, "⚠️ שגיאה בשמירה. אפשר לנסות שוב עם /interests.");
  }
});

bot.action("ip:cancel", async (ctx) => {
  const telegramId = ctx.from.id;
  sessionStore.clearInterestsPicker(telegramId);
  await ctx.answerCbQuery("👍 ביטלתי");
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  await replyAsCallbackResult(ctx, "👍 לא שיניתי כלום. תוכלי לחזור מתי שתרצי עם /interests.");
});

// Partner-pivot handlers — fired by the "כן, בואי נגדיר עבור <name>"
// follow-up after the user saves their own list.
bot.action("ip:partner:start", async (ctx) => {
  const telegramId = ctx.from.id;
  try {
    const profile = await getProfile(telegramId);
    const partnerName = profile?.user_context?.partner?.name || null;
    if (!partnerName) {
      await ctx.answerCbQuery("⚠️");
      await replyAsCallbackResult(ctx, "לא מצאתי בן/בת זוג בפרופיל שלך.");
      return;
    }
    await ctx.answerCbQuery();
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    await openInterestsPicker(ctx, { target: "partner", partnerName });
  } catch (err) {
    console.error("[Bot] ip:partner:start error:", err.message);
    await ctx.answerCbQuery("⚠️");
  }
});

bot.action("ip:partner:skip", async (ctx) => {
  await ctx.answerCbQuery("👍");
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  await replyAsCallbackResult(ctx, "אוקיי, אפשר תמיד לחזור לזה אחר כך עם /interests.");
});

// Hidden admin-only command for inspecting an execution trace.
// Usage: /debug <traceId>
//        /debug last      → most recent trace for THIS user
// Not advertised in /start so regular users can't see it. Authorization
// uses TELEGRAM_CHAT_ID (the operator chat id) as the single allowed
// caller; if env var is unset, the command is disabled entirely.
bot.command("debug", async (ctx) => {
  if (!ADMIN_CHAT_ID || String(ctx.from.id) !== String(ADMIN_CHAT_ID)) {
    return; // silent for non-admins
  }
  const arg = ctx.message.text.split(/\s+/).slice(1).join(" ").trim();
  if (!arg) {
    await ctx.reply("Usage: `/debug <traceId>` or `/debug last`", { parse_mode: "Markdown" });
    return;
  }

  let trace = null;
  if (arg === "last") {
    // Pull the most recent trace owned by THIS chat. Errors first so
    // operators can quickly inspect what just blew up.
    const supabase = require("../lib/supabase");
    const { data, error } = await supabase
      .from("request_traces")
      .select("*")
      .eq("telegram_id", String(ctx.from.id))
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      await ctx.reply(`⚠️ ${error.message}`);
      return;
    }
    trace = data ? { ...data, _source: "db" } : null;
  } else {
    trace = await tracing.getTrace(arg);
  }

  if (!trace) {
    await ctx.reply("❌ Trace לא נמצא.");
    return;
  }
  const text = tracing.formatTraceForTelegram(trace);
  // Markdown — the formatter uses backticks and code blocks. We send
  // as Markdown (not HTML) because backticks are easier to keep clean.
  try {
    await ctx.reply(text, { parse_mode: "Markdown" });
  } catch {
    // Markdown parse error → fallback to plain text. Some payloads
    // contain unbalanced backticks from user input; this saves us.
    await ctx.reply(text);
  }
});

bot.command("watching", async (ctx) => {
  try {
    const watched = await getWatchedEvents(ctx.from.id);
    if (!watched.length) {
      await ctx.reply("🔕 אין אירועים ברשימת המעקב שלך כרגע.");
      return;
    }
    await ctx.reply(`🔔 אירועים במעקב (${watched.length}):`);
    await sendWatchListCards(ctx, watched);
  } catch (err) {
    console.error("[Bot] /watching error:", err.message);
    await ctx.reply("⚠️ שגיאה.");
  }
});

// /recap — admin-only WhatsApp ticket recap. Surfaces every
// currently-active ticket (status='active' AND event_date in the
// future OR null) so the operator can spot deals they remember
// seeing posted that haven't been marked sold yet. We gate strictly
// against TELEGRAM_CHAT_ID so a stranger who guesses the command
// can't pull our seller list.
bot.command("recap", async (ctx) => {
  if (!ADMIN_CHAT_ID || String(ctx.from.id) !== String(ADMIN_CHAT_ID)) {
    // Silent no-op for non-admins. We don't even acknowledge the
    // command exists — minimises the recon surface for anyone
    // poking around the bot.
    return;
  }
  try {
    await sendRecap(ctx.from.id, { silentEmpty: false });
  } catch (err) {
    console.error("[Bot] /recap error:", err.message);
    await ctx.reply("⚠️ שגיאה בבניית הסקירה.");
  }
});

// /broadcast — operator-only feature announcement. The operator
// composes a normal message TO THE BOT (any text, image, video,
// formatting) and then REPLIES to it with /broadcast. The bot
// copies that message 1:1 to every registered profile, paced to
// avoid Telegram's rate limit.
//
// Why reply-to instead of inline /broadcast <text>:
//   - Multi-line bodies: Telegram strips leading whitespace on
//     command args, so "1.\n2.\n3." style announcements arrive
//     mangled.
//   - Media: image + caption announcements are natural; an inline
//     command can't carry an image.
//   - Self-preview: the operator literally sees their own message
//     before tapping "send". No risk of pushing a typo.
//
// Why copyMessage and not forwardMessage:
//   - forwardMessage shows a "Forwarded from <bot>" header in the
//     recipient's chat. We want the message to look native.
//   - copyMessage strips the forward attribution AND the inline
//     keyboard (Telegram limitation). If the operator wants a
//     button on the announcement, that needs a separate path —
//     out of scope here.
//
// Flow: /broadcast → preview card (audience count + ✅ / ✖️) →
// fan-out with live progress updates → final summary.
const BROADCAST_PACING_MS = 50; // ~20 msgs/sec, well under Telegram's ~30 limit
const broadcastPending = new Map(); // sourceMessageId → { sourceChatId, targets: [...], requestedAt }

bot.command("broadcast", async (ctx) => {
  if (!ADMIN_CHAT_ID || String(ctx.from.id) !== String(ADMIN_CHAT_ID)) {
    return; // silent no-op for non-admins
  }
  const reply = ctx.message.reply_to_message;
  if (!reply) {
    await ctx.reply(
      "📢 *broadcast* — שליחת הודעה לכל המשתמשים\n\n" +
        "1. כתבי קודם את ההודעה (טקסט, תמונה, מה שתרצי).\n" +
        "2. השיבי לאותה הודעה עם הפקודה /broadcast.\n" +
        "אאסוף את הקהל ואציג תצוגה מקדימה לאישור.",
      { parse_mode: "Markdown" },
    );
    return;
  }

  try {
    // We compute BOTH audiences (all-registered and active-only) at
    // preview time so the operator sees both counts side-by-side
    // and picks the scope as part of the confirmation. Doing this
    // up-front (vs lazily after the user clicks) makes the choice
    // an informed one — "send to 14 active or 23 total?" — and
    // sidesteps a race where the audience grows between preview
    // and send.
    //
    // "active" = anyone the matcher would naturally consider for
    // notifications. We re-use the existing `getActiveProfiles`
    // definition so this stays consistent with the WhatsApp ticket
    // notifier's audience. "all" is just every row in profiles —
    // includes users who started onboarding but never finished.
    const supabase = require("../lib/supabase");
    const { data: allRows, error: allErr } = await supabase
      .from("profiles")
      .select("telegram_id")
      .limit(10000);
    if (allErr) throw new Error(allErr.message);
    const targetsAll = (allRows || []).map((r) => String(r.telegram_id)).filter(Boolean);
    if (!targetsAll.length) {
      await ctx.reply("📢 אין משתמשים רשומים — לא נשלח כלום.");
      return;
    }

    const { getActiveProfiles } = require("./matchingService");
    const activeRows = await getActiveProfiles();
    const targetsActive = (activeRows || []).map((r) => String(r.telegram_id)).filter(Boolean);

    // Stash both audiences keyed by the source message id. The
    // callback string carries the scope so we know which list to
    // fan out (and a stale callback can't be forced through with
    // crafted data — the key gates it).
    const sourceChatId = reply.chat?.id ?? ctx.chat.id;
    const sourceMessageId = reply.message_id;
    const key = String(sourceMessageId);
    broadcastPending.set(key, {
      sourceChatId,
      sourceMessageId,
      targetsAll,
      targetsActive,
      requestedAt: Date.now(),
    });

    // Garbage-collect stale entries (>30 min) so the map doesn't
    // grow unbounded across operator sessions.
    for (const [k, v] of broadcastPending.entries()) {
      if (Date.now() - v.requestedAt > 30 * 60 * 1000) {
        broadcastPending.delete(k);
      }
    }

    const previewLines = [
      "📢 *תצוגה מקדימה ל-broadcast*",
      "",
      `👥 כל המשתמשים הרשומים: *${targetsAll.length}*`,
      `🔔 רק פעילים (יש user_context או רשימת מעקב): *${targetsActive.length}*`,
      "",
      "אל מי לשלוח?",
    ];
    // Send buttons are split: "to all" only shows when it differs
    // from "active" (no point offering the same scope twice when
    // everyone is active). Active stays disabled if its count is 0.
    const rows = [];
    if (targetsActive.length > 0) {
      rows.push([Markup.button.callback(`📤 שלחי לפעילים (${targetsActive.length})`, `bc:send:active:${key}`)]);
    }
    if (targetsAll.length !== targetsActive.length) {
      rows.push([Markup.button.callback(`📤 שלחי לכולם (${targetsAll.length})`, `bc:send:all:${key}`)]);
    }
    rows.push([Markup.button.callback("✖️ ביטול", `bc:cancel:${key}`)]);

    await ctx.reply(previewLines.join("\n"), {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard(rows),
    });
  } catch (err) {
    console.error("[Bot] /broadcast prep error:", err.message);
    await ctx.reply("⚠️ לא הצלחתי להכין את ה-broadcast. נסי שוב.");
  }
});

bot.action(/^bc:cancel:(.+)$/, async (ctx) => {
  if (!ADMIN_CHAT_ID || String(ctx.from.id) !== String(ADMIN_CHAT_ID)) {
    await ctx.answerCbQuery();
    return;
  }
  const key = ctx.match[1];
  broadcastPending.delete(key);
  await ctx.answerCbQuery("✖️ בוטל");
  try { await ctx.editMessageText("✖️ ה-broadcast בוטל."); } catch {}
});

bot.action(/^bc:send:(active|all):(.+)$/, async (ctx) => {
  if (!ADMIN_CHAT_ID || String(ctx.from.id) !== String(ADMIN_CHAT_ID)) {
    await ctx.answerCbQuery();
    return;
  }
  const scope = ctx.match[1];
  const key = ctx.match[2];
  const job = broadcastPending.get(key);
  if (!job) {
    await ctx.answerCbQuery("פג תוקף");
    try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch {}
    return;
  }
  // Consume the job synchronously to prevent a double-tap from
  // firing two fan-outs. Any caller after this point will hit the
  // "פג תוקף" branch above.
  broadcastPending.delete(key);

  // Pick the actual recipient list based on which button was
  // tapped. Stored at preview time so the count we showed is the
  // count we send to (no race between preview and click).
  const targets = scope === "active" ? job.targetsActive : job.targetsAll;
  const scopeLabel = scope === "active" ? "פעילים" : "כל המשתמשים";

  await ctx.answerCbQuery("📤 שולחת…");
  let progressMsgId = null;
  try {
    const sent = await ctx.editMessageText(`📤 שולחת ל-${targets.length} ${scopeLabel}…`);
    progressMsgId = sent?.message_id || ctx.callbackQuery.message.message_id;
  } catch {
    progressMsgId = ctx.callbackQuery.message.message_id;
  }

  // Telemetry buckets. We only edit the progress message when a
  // bucket changes (every ~10% of progress) — frequent edits
  // burn Telegram quota and add no value.
  let okCount = 0;
  let blockedCount = 0;
  let errorCount = 0;
  let lastProgressUpdate = 0;
  const total = targets.length;

  for (let i = 0; i < total; i++) {
    const telegramId = targets[i];
    try {
      await bot.telegram.copyMessage(telegramId, job.sourceChatId, job.sourceMessageId);
      okCount++;
    } catch (err) {
      const msg = err.message || "";
      // 403: user blocked the bot OR deactivated their account.
      // Both are normal end-states; not an error worth alerting.
      if (/forbidden|user is deactivated|bot was blocked|chat not found/i.test(msg)) {
        blockedCount++;
      } else if (/too many requests|429/i.test(msg)) {
        // Honour Telegram's rate-limit hint. err.parameters?.retry_after
        // is in seconds; default to 5s when missing.
        const retryAfter = err.parameters?.retry_after || 5;
        console.warn(`[Broadcast] 429 — sleeping ${retryAfter}s`);
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        // Retry this same target ONCE then move on.
        try {
          await bot.telegram.copyMessage(telegramId, job.sourceChatId, job.sourceMessageId);
          okCount++;
        } catch (retryErr) {
          if (/forbidden|user is deactivated|bot was blocked|chat not found/i.test(retryErr.message || "")) {
            blockedCount++;
          } else {
            errorCount++;
            console.warn(`[Broadcast] retry failed for ${telegramId}: ${retryErr.message}`);
          }
        }
      } else {
        errorCount++;
        console.warn(`[Broadcast] send failed for ${telegramId}: ${msg}`);
      }
    }

    // Live progress: edit the operator's message every ~10% of
    // progress (or at least every 30s for long runs).
    const now = Date.now();
    if (
      i === total - 1 ||
      i % Math.max(1, Math.floor(total / 10)) === 0 ||
      now - lastProgressUpdate > 30_000
    ) {
      lastProgressUpdate = now;
      try {
        await bot.telegram.editMessageText(
          ADMIN_CHAT_ID,
          progressMsgId,
          undefined,
          `📤 שולחת… ${i + 1}/${total}\n` +
            `✅ הצלחות: ${okCount}\n` +
            `🚫 חסמו את הבוט: ${blockedCount}\n` +
            (errorCount > 0 ? `⚠️ שגיאות: ${errorCount}` : ""),
        );
      } catch {
        // editMessageText fails benignly when the message is too
        // old to edit or hasn't changed — both are non-issues for
        // a progress indicator.
      }
    }

    if (i < total - 1) {
      await new Promise((r) => setTimeout(r, BROADCAST_PACING_MS));
    }
  }

  // Final summary as a NEW message (more visible than another
  // edit, and the progress message stays as a record).
  try {
    await bot.telegram.sendMessage(
      ADMIN_CHAT_ID,
      `✅ *broadcast הסתיים* (${scopeLabel})\n\n` +
        `נשלח בהצלחה: *${okCount}*\n` +
        `חסמו את הבוט: *${blockedCount}*\n` +
        (errorCount > 0 ? `שגיאות אחרות: *${errorCount}*` : `שגיאות אחרות: 0`),
      { parse_mode: "Markdown" },
    );
  } catch (err) {
    console.warn("[Broadcast] final summary failed:", err.message);
  }
});

// Reusable recap sender. Called by both the /recap command (where
// the operator's chat is the target) and the nightly scheduler
// (where the target is ADMIN_CHAT_ID). Splits the recap across
// multiple Telegram messages when it exceeds the per-message limit
// and tap-pauses between sends to stay clear of the flood limit.
async function sendRecap(chatId, { silentEmpty = true } = {}) {
  const { buildRecap } = require("../lib/recapService");
  const { pages, total } = await buildRecap();

  if (total === 0) {
    if (silentEmpty) return;
    await bot.telegram.sendMessage(chatId, "📋 אין כרטיסים פעילים כרגע.");
    return;
  }

  for (let i = 0; i < pages.length; i++) {
    try {
      await bot.telegram.sendMessage(chatId, pages[i], {
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      });
    } catch (err) {
      console.warn(`[Bot] sendRecap page ${i + 1}/${pages.length} failed:`, err.message);
    }
    // Telegram's per-chat limit is 1 msg/sec for the same chat — a
    // multi-page recap of 30+ tickets would otherwise trip the
    // flood control on the second page. 1100ms gives us slack.
    if (i < pages.length - 1) await new Promise((r) => setTimeout(r, 1100));
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Main text handler — routes everything through the agent
// ──────────────────────────────────────────────────────────────────────────
bot.on("text", async (ctx) => {
  const telegramId = ctx.from.id;
  const message = ctx.message.text;

  console.log(`\n[Bot] From: ${telegramId} (${ctx.from.first_name})`);
  console.log(`[Bot] Text: "${message}"`);

  // Trace lifecycle wraps the entire handler. We open the trace BEFORE
  // the static-reply / cancel branches so we have a record of every
  // inbound message — even the trivial ones — and can correlate them
  // when debugging accuracy issues.
  const traceId = await tracing.startTrace({
    telegramId,
    inputText: message,
    kind: "text",
  }).catch((err) => {
    console.warn("[Bot] startTrace failed:", err.message);
    return null;
  });

  let agentInvoked = false;
  try {
    // Static reply check — short greetings / acks bypass the agent
    // entirely to save a Gemini round-trip. Disable for users currently
    // mid-flow, since "תודה" mid-clarification could mean something
    // specific.
    const session = sessionStore.getSession(telegramId);

    // SAVE-PREVIEW FREE TEXT — when the user is on a free-text view of
    // the editable save card (title / venue / tags / tokens), the next
    // text message is captured and merged into pendingSave. Handled
    // BEFORE the agent path so the text doesn't get interpreted as a
    // search query.
    if (session?.pendingSave?._fieldEdit?.field) {
      const snapshot = session.pendingSave;
      const field = snapshot._fieldEdit.field;
      snapshot.filters = snapshot.filters || {};
      let ack = "👌 עודכן";
      if (field === "title") {
        const cleaned = message.trim();
        if (cleaned) snapshot.query = cleaned;
        ack = "📝 הכותרת עודכנה";
      } else if (field === "tokens") {
        snapshot.tokens = message
          .split(/[,\n]/)
          .map((s) => s.trim())
          .filter(Boolean);
        ack = "🔠 המילים עודכנו";
      } else if (field === "tags") {
        const tags = message
          .split(/[,\n]/)
          .map((s) => s.trim())
          .filter(Boolean);
        if (tags.length) snapshot.filters.watch_tag_names = tags;
        else delete snapshot.filters.watch_tag_names;
        ack = "🏷️ התגיות עודכנו";
      } else if (field === "venue") {
        const cleaned = message.trim();
        // Free-text venue: we don't run resolve_venue here because that
        // helper lives inside the agent's tool flow and depends on
        // Gemini for fuzzy matching. Storing as `venue` (free-text
        // fallback path in the matcher) is the right behaviour — the
        // notifier substring-matches it against event.address until
        // the venue gets indexed into `locations` and resolves to a
        // proper location_key.
        if (cleaned) {
          snapshot.filters.venue = cleaned;
          snapshot.filters.location_label = cleaned;
          delete snapshot.filters.location_key;
          // Free-form venue mode is incompatible with proximity ("walk
          // within X km from home" vs "anything at THIS venue"). Drop
          // proximity so the matcher doesn't enforce both — the user
          // can re-enable it from the proximity picker if they meant
          // both, but in practice picking a venue overrides proximity.
          delete snapshot.filters.proximity;
        }
        ack = "📍 המקום עודכן";
      }
      // Clear field-edit mode and bounce back to the main preview.
      snapshot._fieldEdit = null;
      tracing.addStep(traceId, `save_preview_freetext:${field}`);
      // Re-render the main preview card IN PLACE (same message_id) so
      // the user sees the updated filter row. Do this BEFORE the ack
      // reply so the card update animation comes first.
      await renderSavePreviewView(ctx, PSE_VIEWS.MAIN);
      try { await ctx.reply(ack); } catch {}
      return;
    }

    // INTERESTS-PICKER FREE TEXT — when the user tapped "אחר..." on the
    // picker, the next text message is parsed as a comma/newline-
    // separated list of extra interest labels and merged into the
    // current selection. We handle this BEFORE the agent path so the
    // message doesn't get interpreted as a search query.
    if (session?.interestsPicker?.freeTextMode) {
      const raw = message
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (raw.length) {
        const state = session.interestsPicker;
        // Free-text values go into BOTH selected (visible as chips when
        // they happen to match) and extraLabels (preserved on save).
        const nextExtra = Array.from(new Set([...(state.extraLabels || []), ...raw]));
        // Match each entry against the curated catalog; if it matches a
        // chip label exactly, also flip the chip to selected so the
        // user sees their input reflected in the keyboard.
        const nextSelected = new Set(state.selected || []);
        for (const label of raw) {
          const chip = getInterestByLabel(label);
          if (chip) nextSelected.add(chip.label);
        }
        sessionStore.updateInterestsPicker(telegramId, {
          extraLabels: nextExtra,
          selected: Array.from(nextSelected),
          freeTextMode: false,
        });
        tracing.addStep(traceId, "interests_picker_freetext");
        await ctx.reply(
          `👌 הוספתי: ${raw.join(", ")}. אפשר להמשיך לסמן או ללחוץ "שמרי" כשמסיימים.`,
        );
        tracing.setOutput(traceId, "[interests_picker_freetext_added]");
        return;
      }
    }

    if (!session?.pendingClarification) {
      const staticReply = getStaticReply(message);
      if (staticReply) {
        console.log("[Bot] Static reply (no agent call)");
        tracing.addStep(traceId, "static_reply");
        await ctx.reply(staticReply);
        tracing.setOutput(traceId, staticReply);
        return;
      }
    }

    // Magic words to abort an open clarification flow.
    if (session?.pendingClarification) {
      const lowered = message.trim().toLowerCase();
      if (["ביטול", "בטל", "stop", "cancel", "/cancel"].includes(lowered)) {
        sessionStore.clearPendingClarification(telegramId);
        sessionStore.clearPendingSave(telegramId);
        tracing.addStep(traceId, "cancelled_clarification");
        const reply = "👍 ביטלתי. במה אפשר לעזור?";
        await ctx.reply(reply);
        tracing.setOutput(traceId, reply);
        return;
      }
    }

    // Append the new user input to history and run the agent.
    sessionStore.appendUserMessage(telegramId, message);
    agentInvoked = true;

    await withLiveness(ctx, async ({ markResponded }) => {
      await runAgent(telegramId, buildAgentCtx(ctx, { traceId, markResponded }));
    });
  } catch (err) {
    console.error("[Bot] Agent error:", err?.message || err);
    tracing.setError(traceId, err);
    try {
      await ctx.reply("סליחה, לא הצלחתי לעבד את הבקשה הזו עד הסוף. אפשר לנסח אותה אחרת?");
    } catch {}
    // Notify the operator only on real exceptions — not on "static
    // reply" or "cancelled" branches (those are normal flows).
    if (agentInvoked) {
      notifyAdminOfError({ traceId, telegramId, inputText: message, err }).catch(() => {});
    }
  } finally {
    // Always close the trace, even if we returned early. duration_ms
    // and error are persisted in this single final UPDATE.
    if (traceId) {
      tracing.finishTrace(traceId).catch((err) =>
        console.warn("[Bot] finishTrace failed:", err.message),
      );
    }
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Callback-result reply helper
// ──────────────────────────────────────────────────────────────────────────
//
// When a button tap produces a NEW message (not an in-place edit of the
// card), the new message lands at the bottom of the chat — often
// off-screen if the user is still looking at the card above. Two UX
// problems with a plain `ctx.reply`:
//
//   1. Awareness: there's no signal that anything arrived; the user
//      has to know to scroll down.
//   2. Provenance: when they do scroll, there's no visual link back
//      to which card they tapped — three messages later the context
//      is gone.
//
// Sending the result as a REPLY to the original card fixes both:
//   • Telegram renders the card as a quoted preview at the top of the
//     new message, so "I tapped X → got this" is obvious at a glance.
//   • Replies trigger Telegram's floating "↓ new message" arrow more
//     reliably than plain messages, and the reply preview that flashes
//     in notifications is much harder to miss.
//
// `allow_sending_without_reply: true` is defensive — if the user
// cleared chat history then tapped an old keyboard, the original card
// is gone but we still want the new message to land (just without the
// quote). Without this flag Telegram would reject the send.
//
// The helper falls back to a plain reply if called outside a callback
// context (defensive — every current call site IS a callback, but the
// guard is cheap insurance against a future caller).
function replyAsCallbackResult(ctx, text, opts = {}) {
  const replyToId = ctx.callbackQuery?.message?.message_id || null;
  if (!replyToId) return ctx.reply(text, opts);
  return ctx.reply(text, {
    reply_parameters: {
      message_id: replyToId,
      allow_sending_without_reply: true,
    },
    ...opts,
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Clarification button — user picked one of the options the agent offered
// via ask_clarification. We append the picked label as a synthetic user
// message and resume the agent loop.
// ──────────────────────────────────────────────────────────────────────────
bot.action(/^clr:(\d+)$/, async (ctx) => {
  const telegramId = ctx.from.id;
  const idx = parseInt(ctx.match[1], 10);
  const session = sessionStore.getSession(telegramId);
  const pending = session?.pendingClarification;
  if (!pending || !Array.isArray(pending.options) || idx < 0 || idx >= pending.options.length) {
    alertAdmin({
      severity: "warning",
      code: "clarification_expired",
      message: "user tapped a clarification option but pendingClarification was missing",
      context: {
        telegramId,
        idx,
        hadSession: Boolean(session),
        hadPending: Boolean(pending),
        optionsLen: pending?.options?.length ?? null,
      },
    }).catch(() => {});
    await ctx.answerCbQuery("⏰ פג תוקף. אפשר לכתוב את הבחירה?");
    return;
  }
  const opt = pending.options[idx];
  await ctx.answerCbQuery(opt.label.length > 30 ? `✅` : `✅ ${opt.label}`);
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});

  // ─────────────────────────────────────────────────────────────────────
  // Adaptive learning: when the user picks a venue from a disambiguation
  // picker, that's our highest-quality signal — the user explicitly
  // told us "this alias means this location". Record it BEFORE resuming
  // the agent so the next call to resolve_venue (in the same chain or
  // future) finds the new memory.
  //
  // We also handle the correction case: if the agent had already
  // auto-resolved this alias to a DIFFERENT location and the user is now
  // overriding via this picker, decrement the wrong mapping.
  // ─────────────────────────────────────────────────────────────────────
  if (pending.kind === "venue_pick") {
    const lastResolve = session?.lastResolveVenue || null;
    const aliasText = lastResolve?.alias_text || null;
    const pickedKey = String(opt.value || "");
    if (aliasText && pickedKey) {
      const previousAuto =
        lastResolve?.status === "matched" && lastResolve?.candidate_keys?.[0];
      const wasCorrection = previousAuto && previousAuto !== pickedKey;
      try {
        if (wasCorrection) {
          await venueMemory.recordCorrection(aliasText, previousAuto, pickedKey, telegramId);
        } else {
          await venueMemory.recordConfirmation(aliasText, pickedKey, telegramId);
        }
      } catch (err) {
        console.warn("[Bot] venue memory write failed:", err.message);
      }
    }
    sessionStore.clearLastResolveVenue(telegramId);
  }

  sessionStore.appendUserMessage(telegramId, `[בחירה] ${opt.label} (value=${opt.value})`);
  sessionStore.clearPendingClarification(telegramId);

  const traceId = await tracing.startTrace({
    telegramId,
    inputText: `[clr] ${opt.label}`,
    kind: "callback",
  }).catch(() => null);
  try {
    await runAgent(telegramId, buildAgentCtx(ctx, { traceId }));
  } catch (err) {
    console.error("[Bot] clr resume failed:", err?.message || err);
    tracing.setError(traceId, err);
    notifyAdminOfError({ traceId, telegramId, inputText: `[clr] ${opt.label}`, err }).catch(() => {});
  } finally {
    if (traceId) tracing.finishTrace(traceId).catch(() => {});
  }
});

// ──────────────────────────────────────────────────────────────────────────
// EDITABLE SAVE-PREVIEW (`pse:*` callbacks)
// ──────────────────────────────────────────────────────────────────────────
//
// The agent's `present_save_confirmation` tool now renders a rich,
// editable card instead of a static text+confirm. Each filter is a row
// the user can tap to open a chip-picker; tapping "💾 שמרי" commits
// via the same `[שמירת מעקב מאושרת]` synthetic-user-message dance that
// the legacy `ss:confirm` handler used (so `create_saved_search` /
// `update_saved_search` keep working unchanged).
//
// Why an in-place editable card rather than a chat-driven correction
// loop: the pre-redesign UX asked the user to TYPE corrections in
// natural language and trusted the agent to re-extract the filters.
// That round-tripped through Gemini for every edit, exposed every
// chip's underlying ENUM to the user as a word they had to remember,
// and silently miscategorized partial corrections ("רק בערב" landed
// in the label, not in `filters.time_after`). Chips eliminate the
// guesswork: what the user sees IS the filter.
//
// All state lives on `session.pendingSave` (set originally by
// `presentSaveConfirmation`). Internal preview metadata goes on
// `pendingSave._preview` and `pendingSave._fieldEdit` — both are
// stripped by `buildSearchRowPayload` because of the leading `_`.

// View constants. Drives which keyboard the current preview message
// shows; the main view is the filter-row card, the rest are per-field
// chip pickers.
const PSE_VIEWS = {
  MAIN: "main",
  AUDIENCE: "audience",
  AGES: "ages",
  PROXIMITY: "proximity",
  TAGS: "tags",
  DATES: "dates",
  TIMES: "times",
  VENUE: "venue",
  TITLE: "title",
  TOKENS: "tokens",
};

// Centralised wrap so every editable-card message gets the same RTL
// treatment as agent-driven replies. Telegram's bidi algorithm picks
// paragraph direction from the FIRST strong character on each line, so
// without rtlLine the labels-line ("👥 קהל: ילדים") would render LTR.
function rtlMultiline(text) {
  return String(text || "")
    .split("\n")
    .map(rtlLine)
    .join("\n");
}

function pseRowLabel(emoji, name, valueText) {
  // "🎯 קהל: בהתאם לפרופיל" — the label-with-value chip on the main
  // card. Keeping the value inline (rather than under the button) makes
  // the card scannable at a glance and avoids forcing the user to OPEN
  // every picker just to see what's configured.
  const value = valueText ? ` · ${valueText}` : "";
  return `${emoji} ${name}${value}`;
}

function summariseFieldValue(snapshot, field) {
  const f = snapshot?.filters || {};
  switch (field) {
    case "title":
      return snapshot?.query || "(אין)";
    case "audience":
      if (f.audience === "all") return "הכל";
      if (f.audience) return audienceLabel(f.audience) || f.audience;
      return "לפי הפרופיל";
    case "ages":
      if (Array.isArray(f.ages) && f.ages.length) return f.ages.join(", ");
      return "ללא";
    case "proximity":
      if (f.proximity === "walk") return "הליכה";
      if (f.proximity === "drive") return "נסיעה";
      if (f.location_key || f.venue) return `📍 ${f.location_label || f.venue}`;
      return "ללא";
    case "tags":
      if (Array.isArray(f.watch_tag_names) && f.watch_tag_names.length) {
        const shown = f.watch_tag_names.slice(0, 2).join(", ");
        const more = f.watch_tag_names.length > 2 ? ` +${f.watch_tag_names.length - 2}` : "";
        return `${shown}${more}`;
      }
      return "ללא";
    case "dates":
      if (f.date_from && f.date_to && f.date_from !== f.date_to) {
        return `${shortHebDate(f.date_from)}–${shortHebDate(f.date_to)}`;
      }
      if (f.date_from) return shortHebDate(f.date_from);
      return "ללא";
    case "times":
      if (f.time_after && f.time_before) return `${f.time_after}–${f.time_before}`;
      if (f.time_after) return `מ-${f.time_after}`;
      if (f.time_before) return `עד ${f.time_before}`;
      return "ללא";
    case "tokens":
      if (Array.isArray(snapshot.tokens) && snapshot.tokens.length) {
        return snapshot.tokens.join(", ");
      }
      return "ללא";
    default:
      return "ללא";
  }
}

function buildSavePreviewKeyboard(snapshot, { mode = "create" } = {}) {
  // Each editable filter is a single full-width row so the value text
  // never gets truncated by Telegram's narrow side-by-side button layout.
  const rows = [
    [{ text: pseRowLabel("📝", "כותרת", summariseFieldValue(snapshot, "title")), callback_data: "pse:title" }],
    [{ text: pseRowLabel("👥", "קהל", summariseFieldValue(snapshot, "audience")), callback_data: "pse:audience" }],
    [{ text: pseRowLabel("🧒", "גילאים", summariseFieldValue(snapshot, "ages")), callback_data: "pse:ages" }],
    [{ text: pseRowLabel("📍", "מקום/מרחק", summariseFieldValue(snapshot, "proximity")), callback_data: "pse:proximity" }],
    [{ text: pseRowLabel("🏷️", "תגיות", summariseFieldValue(snapshot, "tags")), callback_data: "pse:tags" }],
    [{ text: pseRowLabel("📅", "תאריכים", summariseFieldValue(snapshot, "dates")), callback_data: "pse:dates" }],
    [{ text: pseRowLabel("🕐", "שעות", summariseFieldValue(snapshot, "times")), callback_data: "pse:times" }],
    [{ text: pseRowLabel("🔠", "מילים בכותרת", summariseFieldValue(snapshot, "tokens")), callback_data: "pse:tokens" }],
    [
      { text: mode === "update" ? "💾 עדכני" : "💾 שמרי", callback_data: "pse:save" },
      { text: "❌ ביטול", callback_data: "pse:cancel" },
    ],
  ];
  return { inline_keyboard: rows };
}

function buildSavePreviewText(snapshot, { mode = "create" } = {}) {
  const headline = mode === "update" ? "🔧 עריכת מעקב" : "🔔 מעקב חדש";
  const lines = [`*${headline}*`, ""];
  if (typeof describeSnapshotDetailed === "function") {
    lines.push(describeSnapshotDetailed(snapshot));
  } else {
    lines.push(`🔍 ${snapshot.query || "(ללא כותרת)"}`);
  }
  lines.push("");
  lines.push("_תוכלי לערוך כל שדה בלחיצה. בסיום — 💾 שמרי._");
  return lines.join("\n");
}

// Send or edit the preview card in place. `editInPlace=true` uses
// `editMessageText` on the cached message_id; false sends a fresh
// message and stashes the new message_id for the next edit.
async function renderSavePreviewCard(ctx, { editInPlace = false } = {}) {
  const telegramId = ctx.from.id;
  const session = sessionStore.getSession(telegramId);
  const snapshot = session?.pendingSave;
  if (!snapshot) return null;
  const mode = snapshot?._preview?.mode || "create";
  const text = rtlMultiline(buildSavePreviewText(snapshot, { mode }));
  const reply_markup = buildSavePreviewKeyboard(snapshot, { mode });

  // editMessageText fails with "message is not modified" when the body
  // is byte-identical to what's already on screen. We swallow that
  // specific error so a no-op toggle doesn't log noise; everything
  // else still surfaces.
  if (editInPlace && snapshot._preview?.chatId && snapshot._preview?.messageId) {
    try {
      await ctx.telegram.editMessageText(
        snapshot._preview.chatId,
        snapshot._preview.messageId,
        undefined,
        text,
        { parse_mode: "Markdown", reply_markup },
      );
      return snapshot._preview.messageId;
    } catch (err) {
      if (!/not modified/i.test(err?.message || "")) {
        console.warn("[Bot] renderSavePreviewCard edit failed:", err.message);
      }
      return snapshot._preview.messageId;
    }
  }

  const sent = await ctx.reply(text, { parse_mode: "Markdown", reply_markup });
  snapshot._preview = {
    chatId: sent.chat.id,
    messageId: sent.message_id,
    mode,
    view: PSE_VIEWS.MAIN,
    existingSearchId: snapshot._preview?.existingSearchId || null,
  };
  return sent.message_id;
}

// ────── PER-FIELD CHIP PICKERS ──────
//
// Each picker edits the same card in place. The header text changes
// and the keyboard is replaced; tapping a chip mutates pendingSave and
// re-renders. "↩️ חזרה" returns to the main preview view.

const PROXIMITY_OPTIONS = [
  { value: "walk", label: "🚶 הליכה" },
  { value: "drive", label: "🚗 נסיעה" },
];

const DATE_PRESETS = [
  // Each preset resolves to a { date_from, date_to } pair at click time
  // so storing the static iso strings here would go stale across days.
  // The resolver below computes them from a fresh Date() reference.
  { id: "today",     label: "היום" },
  { id: "tomorrow",  label: "מחר" },
  { id: "thisweek",  label: "השבוע" },
  { id: "next2w",    label: "השבועיים הבאים" },
  { id: "thismonth", label: "החודש" },
];

function resolveDatePreset(id) {
  const today = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  if (id === "today") {
    return { date_from: iso(today), date_to: iso(today) };
  }
  if (id === "tomorrow") {
    const t = addDays(today, 1);
    return { date_from: iso(t), date_to: iso(t) };
  }
  if (id === "thisweek") {
    // Saturday-week semantics (Israel): "this week" = today through
    // upcoming Saturday inclusive. Picking the cut-off on Saturday
    // matches how the rest of the bot talks about weekend planning.
    const dow = today.getDay(); // 0 Sun … 6 Sat
    const daysToSat = (6 - dow + 7) % 7;
    return { date_from: iso(today), date_to: iso(addDays(today, daysToSat)) };
  }
  if (id === "next2w") {
    return { date_from: iso(today), date_to: iso(addDays(today, 14)) };
  }
  if (id === "thismonth") {
    const end = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    return { date_from: iso(today), date_to: iso(end) };
  }
  return null;
}

const TIME_PRESETS = [
  // Tuples [time_after, time_before] keeping inclusive endpoints. The
  // notifier uses simple lexicographic compare on HH:MM so these stay
  // straightforward.
  { id: "morning",   label: "בוקר",   time_after: "06:00", time_before: "12:00" },
  { id: "noon",      label: "צהריים", time_after: "12:00", time_before: "16:00" },
  { id: "evening",   label: "ערב",    time_after: "16:00", time_before: "21:00" },
  { id: "night",     label: "לילה",   time_after: "21:00", time_before: "23:59" },
];

function buildBackRow() {
  return [{ text: "↩️ חזרה", callback_data: "pse:back" }];
}

function buildClearRow(field) {
  return [{ text: `🧹 ניקוי`, callback_data: `pse:clear:${field}` }];
}

function buildAudienceKeyboard(snapshot) {
  const cur = snapshot?.filters?.audience || null;
  // Visible label + value. Mirrors the AUDIENCE_LABELS map in
  // lib/categories so the agent's `search_events` filter and this
  // picker speak the same vocabulary. "Profile default" = unset; a
  // dedicated chip for "everything" (audience='all') lets the user
  // explicitly opt out of audience filtering for niche cases.
  const chips = [
    { value: null, label: "📌 לפי הפרופיל" },
    { value: "all", label: "🌐 הכל (בלי סינון)" },
    ...Object.keys(AUDIENCE_LABELS).map((k) => ({
      value: k,
      label: AUDIENCE_LABELS[k],
    })),
  ];
  const rows = [];
  for (let i = 0; i < chips.length; i += 2) {
    const pair = chips.slice(i, i + 2).map((chip) => {
      const checked = (chip.value || null) === cur ? "✅ " : "";
      const valuePart = chip.value === null ? "_null" : `:${chip.value}`;
      return {
        text: `${checked}${chip.label}`,
        callback_data: `pse:set:audience${valuePart}`,
      };
    });
    rows.push(pair);
  }
  rows.push(buildBackRow());
  return { inline_keyboard: rows };
}

function buildAgesKeyboard(snapshot) {
  const cur = new Set(Array.isArray(snapshot?.filters?.ages) ? snapshot.filters.ages : []);
  const rows = [];
  // Ages 0..15 — 4 chips per row keeps phone layouts readable.
  for (let n = 0; n <= 15; n += 4) {
    const row = [];
    for (let m = n; m < Math.min(n + 4, 16); m++) {
      const checked = cur.has(m) ? "✅ " : "";
      row.push({
        text: `${checked}${m}`,
        callback_data: `pse:tog:ages:${m}`,
      });
    }
    rows.push(row);
  }
  rows.push(buildClearRow("ages"));
  rows.push(buildBackRow());
  return { inline_keyboard: rows };
}

function buildProximityKeyboard(snapshot) {
  const cur = snapshot?.filters?.proximity || null;
  const rows = PROXIMITY_OPTIONS.map((opt) => [{
    text: (cur === opt.value ? "✅ " : "") + opt.label,
    callback_data: `pse:set:proximity:${opt.value}`,
  }]);
  // Hint that venue overrides proximity — `pse:venue` is the way in.
  rows.push([{ text: "📍 קביעת מקום ספציפי", callback_data: "pse:venue" }]);
  rows.push(buildClearRow("proximity"));
  rows.push(buildBackRow());
  return { inline_keyboard: rows };
}

function buildDatesKeyboard(snapshot) {
  // Active preset highlighting is heuristic — we recompute each preset
  // and compare to the stored range. Close enough for the common cases;
  // the user can always tap "ניקוי" if it goes weird.
  const f = snapshot?.filters || {};
  const rows = DATE_PRESETS.map((p) => {
    const r = resolveDatePreset(p.id);
    const matches = r && r.date_from === f.date_from && r.date_to === f.date_to;
    return [{
      text: (matches ? "✅ " : "") + p.label,
      callback_data: `pse:set:dates:${p.id}`,
    }];
  });
  rows.push(buildClearRow("dates"));
  rows.push(buildBackRow());
  return { inline_keyboard: rows };
}

function buildTimesKeyboard(snapshot) {
  const f = snapshot?.filters || {};
  const rows = TIME_PRESETS.map((p) => {
    const matches = f.time_after === p.time_after && f.time_before === p.time_before;
    return [{
      text: (matches ? "✅ " : "") + p.label,
      callback_data: `pse:set:times:${p.id}`,
    }];
  });
  rows.push(buildClearRow("times"));
  rows.push(buildBackRow());
  return { inline_keyboard: rows };
}

// Field-edit views (tags / venue / title / tokens) — switch the user
// into free-text capture mode. The next non-command text message gets
// merged into the corresponding field. We render a minimal header on
// the card and just leave it visible so the user has context.

function buildFreeTextHeader({ field, current, hint }) {
  const cur = current ? `\n\n*כרגע:* ${current}` : "";
  return rtlMultiline(`✏️ *${field}*${cur}\n\n${hint}\n\n(אפשר גם _להחזיר_ בלי לשנות)`);
}

function buildFreeTextKeyboard(field) {
  const rows = [];
  rows.push(buildClearRow(field));
  rows.push(buildBackRow());
  return { inline_keyboard: rows };
}

// View dispatcher — given the desired view, mutate the card to show
// that view's keyboard. Used by every pse:<field> handler.
async function renderSavePreviewView(ctx, view) {
  const telegramId = ctx.from.id;
  const session = sessionStore.getSession(telegramId);
  const snapshot = session?.pendingSave;
  if (!snapshot?._preview) return;

  if (view === PSE_VIEWS.MAIN) {
    snapshot._fieldEdit = null;
    snapshot._preview.view = view;
    await renderSavePreviewCard(ctx, { editInPlace: true });
    return;
  }

  // Sub-views: build the header + keyboard tailored to the field. The
  // text body re-uses the same describeSnapshotDetailed summary so the
  // user keeps the full context visible while editing one field.
  let header = "";
  let reply_markup = null;

  if (view === PSE_VIEWS.AUDIENCE) {
    header = "👥 *בחרי קהל יעד*\n";
    reply_markup = buildAudienceKeyboard(snapshot);
  } else if (view === PSE_VIEWS.AGES) {
    header = "🧒 *בחרי גילאים* (סמני אחד או יותר)\n";
    reply_markup = buildAgesKeyboard(snapshot);
  } else if (view === PSE_VIEWS.PROXIMITY) {
    header = "📍 *בחרי מקום או מרחק*\n";
    reply_markup = buildProximityKeyboard(snapshot);
  } else if (view === PSE_VIEWS.DATES) {
    header = "📅 *בחרי טווח תאריכים*\n";
    reply_markup = buildDatesKeyboard(snapshot);
  } else if (view === PSE_VIEWS.TIMES) {
    header = "🕐 *בחרי טווח שעות*\n";
    reply_markup = buildTimesKeyboard(snapshot);
  } else if (view === PSE_VIEWS.TAGS) {
    snapshot._fieldEdit = { field: "tags" };
    header = buildFreeTextHeader({
      field: "תגיות לעקוב",
      current: (snapshot.filters?.watch_tag_names || []).join(", "),
      hint: "כתבי תגיות מופרדות בפסיק (לדוגמה: מוזיקה, סדנאות יצירה).",
    });
    reply_markup = buildFreeTextKeyboard("tags");
  } else if (view === PSE_VIEWS.VENUE) {
    snapshot._fieldEdit = { field: "venue" };
    header = buildFreeTextHeader({
      field: "מקום ספציפי",
      current: snapshot.filters?.location_label || snapshot.filters?.venue || "",
      hint: "כתבי שם של מקום (לדוגמה: מרכז פיס גאולים). ננסה לזהות אותו אוטומטית.",
    });
    reply_markup = buildFreeTextKeyboard("venue");
  } else if (view === PSE_VIEWS.TITLE) {
    snapshot._fieldEdit = { field: "title" };
    header = buildFreeTextHeader({
      field: "כותרת המעקב",
      current: snapshot.query,
      hint: "הכותרת מוצגת ב-/saved ולא משפיעה על הסינון.",
    });
    reply_markup = buildFreeTextKeyboard("title");
  } else if (view === PSE_VIEWS.TOKENS) {
    snapshot._fieldEdit = { field: "tokens" };
    header = buildFreeTextHeader({
      field: "מילים חובה בשם האירוע",
      current: (snapshot.tokens || []).join(", "),
      hint: "השאירי ריק במקרים רגילים. כתבי מילים רק אם חשוב שהמילה תופיע בשם האירוע (לדוגמה: יין).",
    });
    reply_markup = buildFreeTextKeyboard("tokens");
  }

  snapshot._preview.view = view;

  // Replace the on-screen card: header + the current summary so the
  // user still sees what's set elsewhere while editing this field.
  const body = rtlMultiline(describeSnapshotDetailed(snapshot));
  const text = `${header}\n${body}`;
  try {
    await ctx.telegram.editMessageText(
      snapshot._preview.chatId,
      snapshot._preview.messageId,
      undefined,
      text,
      { parse_mode: "Markdown", reply_markup },
    );
  } catch (err) {
    if (!/not modified/i.test(err?.message || "")) {
      console.warn("[Bot] renderSavePreviewView edit failed:", err.message);
    }
  }
}

// ────── CALLBACK HANDLERS ──────

bot.action("pse:title",     async (ctx) => { await ctx.answerCbQuery(); await renderSavePreviewView(ctx, PSE_VIEWS.TITLE); });
bot.action("pse:audience",  async (ctx) => { await ctx.answerCbQuery(); await renderSavePreviewView(ctx, PSE_VIEWS.AUDIENCE); });
bot.action("pse:ages",      async (ctx) => { await ctx.answerCbQuery(); await renderSavePreviewView(ctx, PSE_VIEWS.AGES); });
bot.action("pse:proximity", async (ctx) => { await ctx.answerCbQuery(); await renderSavePreviewView(ctx, PSE_VIEWS.PROXIMITY); });
bot.action("pse:tags",      async (ctx) => { await ctx.answerCbQuery(); await renderSavePreviewView(ctx, PSE_VIEWS.TAGS); });
bot.action("pse:dates",     async (ctx) => { await ctx.answerCbQuery(); await renderSavePreviewView(ctx, PSE_VIEWS.DATES); });
bot.action("pse:times",     async (ctx) => { await ctx.answerCbQuery(); await renderSavePreviewView(ctx, PSE_VIEWS.TIMES); });
bot.action("pse:venue",     async (ctx) => { await ctx.answerCbQuery(); await renderSavePreviewView(ctx, PSE_VIEWS.VENUE); });
bot.action("pse:tokens",    async (ctx) => { await ctx.answerCbQuery(); await renderSavePreviewView(ctx, PSE_VIEWS.TOKENS); });
bot.action("pse:back",      async (ctx) => { await ctx.answerCbQuery(); await renderSavePreviewView(ctx, PSE_VIEWS.MAIN); });

// Radio-set (single value). Handles audience, proximity, plus date/time
// preset selection. `_null` is a sentinel for unsetting audience back
// to "profile default".
bot.action(/^pse:set:(audience|proximity|dates|times):(.+)$/, async (ctx) => {
  const telegramId = ctx.from.id;
  const session = sessionStore.getSession(telegramId);
  const snapshot = session?.pendingSave;
  if (!snapshot) { await ctx.answerCbQuery("⏰ פג תוקף"); return; }
  const [, field, rawValue] = ctx.match;
  snapshot.filters = snapshot.filters || {};
  if (field === "audience") {
    if (rawValue === "_null") delete snapshot.filters.audience;
    else snapshot.filters.audience = rawValue;
  } else if (field === "proximity") {
    snapshot.filters.proximity = rawValue;
    // Setting proximity REMOVES any pinned venue — the user picked
    // "near home" instead of "at this venue", and the two modes can't
    // both be active without confusing the matcher.
    delete snapshot.filters.location_key;
    delete snapshot.filters.location_label;
    delete snapshot.filters.venue;
  } else if (field === "dates") {
    const r = resolveDatePreset(rawValue);
    if (r) {
      snapshot.filters.date_from = r.date_from;
      snapshot.filters.date_to = r.date_to;
    }
  } else if (field === "times") {
    const preset = TIME_PRESETS.find((p) => p.id === rawValue);
    if (preset) {
      snapshot.filters.time_after = preset.time_after;
      snapshot.filters.time_before = preset.time_before;
    }
  }
  await ctx.answerCbQuery("✓");
  // Stay on the same view so the user can see the new state and pick a
  // different chip if they tapped the wrong one. They tap "↩️ חזרה" to
  // return to the main preview when done.
  await renderSavePreviewView(ctx, snapshot._preview?.view || PSE_VIEWS.MAIN);
});

// Multi-toggle — used for ages (sets of numbers). Sorts the resulting
// array so storage stays canonical across edits.
bot.action(/^pse:tog:(ages):(\d+)$/, async (ctx) => {
  const telegramId = ctx.from.id;
  const session = sessionStore.getSession(telegramId);
  const snapshot = session?.pendingSave;
  if (!snapshot) { await ctx.answerCbQuery("⏰ פג תוקף"); return; }
  const [, field, rawValue] = ctx.match;
  snapshot.filters = snapshot.filters || {};
  const val = parseInt(rawValue, 10);
  if (field === "ages") {
    const cur = new Set(Array.isArray(snapshot.filters.ages) ? snapshot.filters.ages : []);
    if (cur.has(val)) cur.delete(val);
    else cur.add(val);
    snapshot.filters.ages = [...cur].sort((a, b) => a - b);
  }
  await ctx.answerCbQuery("✓");
  await renderSavePreviewView(ctx, snapshot._preview?.view || PSE_VIEWS.MAIN);
});

// Clear a field back to its default state. Maps onto the natural empty
// for each field type (delete the key for filters, empty array for
// list-valued, empty string for title — fallback to a placeholder).
bot.action(/^pse:clear:(.+)$/, async (ctx) => {
  const telegramId = ctx.from.id;
  const session = sessionStore.getSession(telegramId);
  const snapshot = session?.pendingSave;
  if (!snapshot) { await ctx.answerCbQuery("⏰ פג תוקף"); return; }
  const field = ctx.match[1];
  snapshot.filters = snapshot.filters || {};
  if (field === "ages") delete snapshot.filters.ages;
  else if (field === "proximity") delete snapshot.filters.proximity;
  else if (field === "tags") delete snapshot.filters.watch_tag_names;
  else if (field === "dates") { delete snapshot.filters.date_from; delete snapshot.filters.date_to; }
  else if (field === "times") { delete snapshot.filters.time_after; delete snapshot.filters.time_before; }
  else if (field === "venue") { delete snapshot.filters.location_key; delete snapshot.filters.location_label; delete snapshot.filters.venue; }
  else if (field === "title") snapshot.query = "(ללא כותרת)";
  else if (field === "tokens") snapshot.tokens = [];
  await ctx.answerCbQuery("🧹 נוקה");
  await renderSavePreviewView(ctx, snapshot._preview?.view || PSE_VIEWS.MAIN);
});

bot.action("pse:cancel", async (ctx) => {
  const telegramId = ctx.from.id;
  await ctx.answerCbQuery("👍 ביטלתי");
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  sessionStore.clearPendingSave(telegramId);
  sessionStore.clearPendingClarification(telegramId);
  await replyAsCallbackResult(ctx, "👍 לא שמרתי. תוכלי לבקש מעקב שוב מתי שתרצי.");
});

// Save — commit the snapshot.
//
// Two paths:
//   CREATE: route through the agent. Append a synthetic user message
//           ("[אישור שמירה] …") and resume the loop so the agent's
//           existing `create_saved_search` tool fires, lets it do any
//           "great, I'll keep watching for X" follow-up reply, and the
//           tracing/overlap pieces stay consistent with text-driven
//           saves.
//   UPDATE: commit IN-PROCESS without an agent round-trip. The user
//           explicitly tapped each filter and confirmed — there's
//           nothing for the agent to add, and routing through Gemini
//           is just extra latency + a risk it freelances on the
//           response. We hit updateSavedSearch directly and send a
//           plain ack message, skipping the loop entirely.
async function commitPendingSave(ctx) {
  const telegramId = ctx.from.id;
  const session = sessionStore.getSession(telegramId);
  const snapshot = session?.pendingSave;
  if (!snapshot) {
    alertAdmin({
      severity: "warning",
      code: "pending_save_expired",
      message: "user tapped save but pendingSave was missing",
      context: { telegramId, hadSession: Boolean(session) },
    }).catch(() => {});
    await ctx.answerCbQuery("⏰ פג תוקף — אפשר לבקש מעקב מחדש.");
    return;
  }
  const isUpdate = snapshot._preview?.mode === "update";
  const existingId = snapshot._preview?.existingSearchId || null;
  await ctx.answerCbQuery("✅ אישרת");
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});

  if (isUpdate && existingId) {
    try {
      // Preserve the existing row's mode (recurring / one_time) unless
      // we have a stronger signal. The edit flow doesn't currently let
      // the user change mode, so reading the current value off the DB
      // is safer than guessing.
      const existing = await getSavedSearch(existingId, telegramId);
      const mode = existing?.mode === "one_time" ? "one_time" : "recurring";
      let expiresAt = null;
      if (mode === "one_time" && snapshot.filters?.date_to) {
        expiresAt = new Date(`${snapshot.filters.date_to}T23:59:59+03:00`).toISOString();
      }
      await updateSavedSearch(existingId, telegramId, {
        query: snapshot.query,
        tokens: snapshot.tokens,
        filters: snapshot.filters,
        tickets_needed: snapshot.tickets_needed,
        mode,
        expires_at: expiresAt,
      });
      sessionStore.clearPendingSave(telegramId);
      sessionStore.clearPendingClarification(telegramId);
      await replyAsCallbackResult(
        ctx,
        `✅ עדכנתי את המעקב "${snapshot.query || "(ללא כותרת)"}". ההיסטוריה והדדאפ של ההתראות נשמרו.`,
      );
    } catch (err) {
      console.error("[Bot] pse:save (update) failed:", err.message);
      await replyAsCallbackResult(ctx, "⚠️ שגיאה בעדכון המעקב. אפשר לנסות שוב.");
    }
    return;
  }

  // CREATE path — synthesise the cue + resume the agent loop. The
  // agent's create_saved_search reads pendingSave and persists.
  sessionStore.appendUserMessage(telegramId, "[אישור שמירה] המשתמשת אישרה את החיפוש השמור.");
  sessionStore.clearPendingClarification(telegramId);

  const traceId = await tracing.startTrace({
    telegramId,
    inputText: "[pse:save:create]",
    kind: "callback",
  }).catch(() => null);
  try {
    await runAgent(telegramId, buildAgentCtx(ctx, { traceId }));
  } catch (err) {
    console.error("[Bot] pse:save resume failed:", err?.message || err);
    tracing.setError(traceId, err);
    notifyAdminOfError({ traceId, telegramId, inputText: "[pse:save]", err }).catch(() => {});
  } finally {
    if (traceId) tracing.finishTrace(traceId).catch(() => {});
  }
}

bot.action("pse:save", async (ctx) => { await commitPendingSave(ctx); });

// ────── EDIT EXISTING WATCHER ──────
//
// `pse:edit:<id>` — entry point from /saved. Loads the row, seeds
// pendingSave with `_preview.mode="update"` so the save handler routes
// to updateSavedSearch instead of createSavedSearch, and renders the
// same editable card the create flow uses.
bot.action(/^pse:edit:([0-9a-f-]+)$/, async (ctx) => {
  const telegramId = ctx.from.id;
  const id = ctx.match[1];
  try {
    const row = await getSavedSearch(id, telegramId);
    if (!row) {
      await ctx.answerCbQuery("⚠️ לא נמצא");
      return;
    }
    sessionStore.setPendingSave(telegramId, {
      query: row.query || "",
      tokens: Array.isArray(row.tokens) ? row.tokens : [],
      filters: row.filters || {},
      tickets_needed: row.tickets_needed ?? null,
      _preview: {
        mode: "update",
        existingSearchId: id,
        // chatId/messageId filled in by the first renderSavePreviewCard
        // call below.
        chatId: null,
        messageId: null,
        view: PSE_VIEWS.MAIN,
      },
    });
    await ctx.answerCbQuery();
    await renderSavePreviewCard(ctx, { editInPlace: false });
  } catch (err) {
    console.error("[Bot] pse:edit error:", err.message);
    await ctx.answerCbQuery("⚠️");
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Save-confirmation buttons — confirm or cancel a pending saved search
// ──────────────────────────────────────────────────────────────────────────
bot.action("ss:confirm", async (ctx) => {
  const telegramId = ctx.from.id;
  const session = sessionStore.getSession(telegramId);
  if (!session?.pendingSave) {
    alertAdmin({
      severity: "warning",
      code: "pending_save_expired",
      message: "user tapped save-confirm but pendingSave was missing",
      context: { telegramId, hadSession: Boolean(session) },
    }).catch(() => {});
    await ctx.answerCbQuery("⏰ פג תוקף — אפשר לבקש מעקב מחדש.");
    return;
  }
  await ctx.answerCbQuery("✅ אישרת");
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});

  sessionStore.appendUserMessage(telegramId, "[אישור שמירה] המשתמשת אישרה את החיפוש השמור.");
  sessionStore.clearPendingClarification(telegramId);

  const traceId = await tracing.startTrace({
    telegramId,
    inputText: "[ss:confirm]",
    kind: "callback",
  }).catch(() => null);
  try {
    await runAgent(telegramId, buildAgentCtx(ctx, { traceId }));
  } catch (err) {
    console.error("[Bot] ss:confirm resume failed:", err?.message || err);
    tracing.setError(traceId, err);
    notifyAdminOfError({ traceId, telegramId, inputText: "[ss:confirm]", err }).catch(() => {});
  } finally {
    if (traceId) tracing.finishTrace(traceId).catch(() => {});
  }
});

bot.action("ss:cancel", async (ctx) => {
  const telegramId = ctx.from.id;
  await ctx.answerCbQuery("👍 ביטלתי");
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  sessionStore.clearPendingSave(telegramId);
  sessionStore.clearPendingClarification(telegramId);
  await replyAsCallbackResult(ctx, "👍 לא שמרתי. תוכלי לבקש מעקב שוב מתי שתרצי.");
});

// Promote one_time → recurring (keeps id + dedup history; clears expiry).
bot.action(/^ss:rec:([0-9a-f-]+)$/, async (ctx) => {
  const id = ctx.match[1];
  try {
    await promoteSavedSearchToRecurring(id, ctx.from.id);
    await ctx.answerCbQuery("♾️ קבוע");
    await ctx.editMessageReplyMarkup({
      inline_keyboard: [[{ text: "🔕 הפסיקי לעקוב", callback_data: `ss:rm:${id}` }]],
    });
    await replyAsCallbackResult(ctx, "♾️ מצוין! אעדכן אותך כל פעם שייפתחו אירועים חדשים שמתאימים.");
  } catch (err) {
    console.error("[Bot] ss:rec error:", err.message);
    await ctx.answerCbQuery("⚠️");
  }
});

bot.action(/^ss:rm:([0-9a-f-]+)$/, async (ctx) => {
  const id = ctx.match[1];
  try {
    await archiveSavedSearch(id, ctx.from.id);
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    await ctx.answerCbQuery("🔕 הוסר מהחיפושים השמורים");
    await replyAsCallbackResult(ctx, "👍 הפסקתי לעקוב אחרי החיפוש הזה.");
  } catch (err) {
    console.error("[Bot] ss:rm error:", err.message);
    await ctx.answerCbQuery("⚠️");
  }
});

// "✅ קניתי N" on a saved-search notification — decrements remaining.
// one_time mode archives on ANY decrement; recurring resets at zero.
bot.action(/^sb:([0-9a-f-]+):(\d+)$/, async (ctx) => {
  const id = ctx.match[1];
  const bought = parseInt(ctx.match[2], 10);
  try {
    const result = await decrementSavedSearchRemaining(id, bought);
    if (result === null) {
      await ctx.answerCbQuery("✅ נרשם");
      await ctx.editMessageReplyMarkup({
        inline_keyboard: [[{ text: "🔕 הפסיקי לעקוב", callback_data: `ss:rm:${id}` }]],
      });
      return;
    }
    const { remaining, archived } = result;
    if (archived) {
      await ctx.answerCbQuery("🎉 מצוין! הפסקתי לעקוב.");
      await ctx.editMessageReplyMarkup({
        inline_keyboard: [[{ text: "✅ סודר — מחוץ למעקב", callback_data: `noop:${id}` }]],
      });
      return;
    }
    await ctx.answerCbQuery(`✅ עוד ${remaining} חסרים`);
    await ctx.editMessageReplyMarkup({
      inline_keyboard: [
        [{ text: `📋 ממשיכה לחפש לך עוד ${remaining}`, callback_data: `noop:${id}` }],
        [{ text: "🔕 הפסיקי לעקוב", callback_data: `ss:rm:${id}` }],
      ],
    });
  } catch (err) {
    console.error("[Bot] sb error:", err.message);
    await ctx.answerCbQuery("⚠️ שגיאה");
  }
});

// "✅ מצאתי, סיימי לעקוב" on a batch notification — archive without decrement.
bot.action(/^sf:([0-9a-f-]+)$/, async (ctx) => {
  const id = ctx.match[1];
  try {
    await archiveSavedSearch(id, ctx.from.id);
    await ctx.answerCbQuery("🎉 מצוין! הפסקתי לעקוב.");
    await ctx.editMessageReplyMarkup({
      inline_keyboard: [[{ text: "✅ סודר — מחוץ למעקב", callback_data: `noop:${id}` }]],
    });
  } catch (err) {
    console.error("[Bot] sf error:", err.message);
    await ctx.answerCbQuery("⚠️ שגיאה");
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Single-event watcher buttons (sold-out events)
// ──────────────────────────────────────────────────────────────────────────
const QUANTITY_OPTIONS = [1, 2, 3, 4, 5, 6];

function buildNeededKeyboard(eventId) {
  const buttons = QUANTITY_OPTIONS.map((n) => ({
    text: String(n),
    callback_data: `wq:${eventId}:${n}`,
  }));
  return {
    inline_keyboard: [
      buttons.slice(0, 3),
      buttons.slice(3, 6),
      [{ text: "דלג", callback_data: `wq:${eventId}:skip` }],
    ],
  };
}

bot.action(/^wt:(\d+)(?::(\d+))?$/, async (ctx) => {
  const eventId = ctx.match[1];
  const presetNeeded = ctx.match[2] ? parseInt(ctx.match[2], 10) : null;
  try {
    if (presetNeeded && presetNeeded > 0) {
      await addWatcher(ctx.from.id, eventId, { ticketsNeeded: presetNeeded });
      await ctx.answerCbQuery(`🔔 במעקב — ${presetNeeded} כרטיסים`);
      await ctx.editMessageReplyMarkup({
        inline_keyboard: [[{ text: "🔕 בטל מעקב", callback_data: `unw:${eventId}` }]],
      });
      return;
    }
    await addWatcher(ctx.from.id, eventId);
    await ctx.answerCbQuery("🔔 נוספת לרשימת המעקב!");
    await replyAsCallbackResult(ctx, "🎫 כמה כרטיסים את צריכה לאירוע הזה?", {
      reply_markup: buildNeededKeyboard(eventId),
    });
  } catch (err) {
    console.error("[Bot] wt error:", err.message);
    await ctx.answerCbQuery("⚠️ שגיאה");
  }
});

bot.action(/^wq:(\d+):(\d+|skip)$/, async (ctx) => {
  const eventId = ctx.match[1];
  const raw = ctx.match[2];
  try {
    if (raw === "skip") {
      await ctx.answerCbQuery("👍");
      await ctx.editMessageText("✅ במעקב. אעדכן אותך כשייפתחו כרטיסים.", {
        reply_markup: {
          inline_keyboard: [[{ text: "🔕 בטל מעקב", callback_data: `unw:${eventId}` }]],
        },
      });
      return;
    }
    const needed = parseInt(raw, 10);
    await setTicketsNeeded(ctx.from.id, eventId, needed);
    await ctx.answerCbQuery(`✅ ${needed} כרטיסים`);
    await ctx.editMessageText(`🔔 במעקב — מחפשת ${needed} כרטיסים. אעדכן אותך כשייפתחו.`, {
      reply_markup: {
        inline_keyboard: [[{ text: "🔕 בטל מעקב", callback_data: `unw:${eventId}` }]],
      },
    });
  } catch (err) {
    console.error("[Bot] wq error:", err.message);
    await ctx.answerCbQuery("⚠️ שגיאה");
  }
});

// "✅ קניתי N" on a watcher notification when stock returned.
bot.action(/^bg:(\d+):(\d+)$/, async (ctx) => {
  const eventId = ctx.match[1];
  const bought = parseInt(ctx.match[2], 10);
  try {
    const remaining = await decrementTicketsNeeded(ctx.from.id, eventId, bought);
    if (remaining === null) {
      await removeWatcher(ctx.from.id, eventId).catch(() => {});
      await ctx.answerCbQuery("✅ נרשם. הוסר מהמעקב.");
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
      return;
    }
    if (remaining === 0) {
      await ctx.answerCbQuery("🎉 כל הכבוד! המעקב הוסר.");
      await ctx.editMessageReplyMarkup({
        inline_keyboard: [[{ text: "✅ סודר — מחוץ למעקב", callback_data: `noop:${eventId}` }]],
      });
      return;
    }
    // Look up the source so the booking link points at the right
    // tenant. Cheap (PK lookup, <5ms) and the only call site that has
    // an event id without a row in hand. Falls back to mbe-rg if the
    // row vanished (archived between scrapes) — still gives the user
    // a clickable link, just possibly to the wrong host.
    const supabase = require("../lib/supabase");
    const { data: row } = await supabase
      .from("events")
      .select("source, external_slug")
      .eq("id", eventId)
      .maybeSingle();
    const linkEvent = {
      id: eventId,
      source: row?.source,
      external_slug: row?.external_slug || null,
    };

    await ctx.answerCbQuery(`✅ עודכן — חסרים עוד ${remaining}`);
    await ctx.editMessageReplyMarkup({
      inline_keyboard: [
        [{ text: "🎟️ לרכישה", url: getBookingUrl(linkEvent) }],
        [{ text: `📋 ממשיכה לחפש עוד ${remaining}`, callback_data: `noop:${eventId}` }],
        [{ text: "🔕 בטל מעקב", callback_data: `unw:${eventId}` }],
      ],
    });
  } catch (err) {
    console.error("[Bot] bg error:", err.message);
    await ctx.answerCbQuery("⚠️ שגיאה");
  }
});

bot.action(/^noop:/, async (ctx) => { await ctx.answerCbQuery(); });

// ──────────────────────────────────────────────────────────────────────────
// Series expansion: "📋 כל המופעים" button on a series-card
// ──────────────────────────────────────────────────────────────────────────
//
// When a card represents a recurring event (e.g. weekly playgroup), we
// pre-stash the full occurrence list on the user's session under the
// representative event's id. Clicking the button just reads that back
// and emits a clean dated list — no DB hop, no agent round-trip.
//
// On cache miss (session TTL expired, bot restart) we rebuild the same
// list from the DB using the stable series fingerprint
// (name + location_key + min/max_months — see lib/eventSeries.js).
// Telegram cards live forever in chat history, so we can't rely on the
// in-memory cache being warm when the user finally taps the button.
//
// The detail-page URL of the WHOLE series uses the representative id
// (Smarticket itself routes by series). For per-occurrence ticket
// purchase the user taps the date item, which links to the same
// `/event/<occurrence_id>` URL — Smarticket handles the date selection
// inside the page.
async function rebuildSeriesPayloadFromDb(seriesId) {
  const supabase = require("../lib/supabase");
  const { seriesKey, venueIdentity } = require("../lib/eventSeries");

  // 1. Load the representative event to capture the series fingerprint.
  //    location_key joins through to the human-readable address for the
  //    output header. lat/lng come along so the multi-venue bucketing
  //    below can compare by physical place identity, not text label
  //    (see venueIdentity for why).
  const { data: rep, error: repErr } = await supabase
    .from("events")
    .select(
      "id, source, external_slug, name, location_key, min_months, max_months, " +
        "locations:location_key(raw_address, lat, lng, found)"
    )
    .eq("id", seriesId)
    .maybeSingle();
  if (repErr) {
    console.warn(`[Bot] seq fallback: representative lookup failed: ${repErr.message}`);
    return null;
  }
  if (!rep) return null;

  // 2. Pull every NON-archived event that shares the fingerprint.
  //    We deliberately do NOT filter by future-date — past occurrences
  //    of an active recurring series still answer the user's "show me
  //    all dates" question honestly, and they're harmless (the URL just
  //    won't sell tickets). Filtering would risk showing an empty list
  //    when the representative is today's only entry.
  const today = DateTime.now().setZone("Asia/Jerusalem").toISODate();
  const { data: rows, error: occErr } = await supabase
    .from("events")
    .select(
      "id, source, external_slug, name, date, start_time, end_time, " +
        "tickets_left, location_key, min_months, max_months, " +
        // Per-occurrence venue join. lat/lng/found feed `venueIdentity`
        // so two rows that resolved the same physical place from
        // different `raw_address` strings still collapse into one
        // bucket — without this the seq handler would say "מתקיים
        // במספר מיקומים" for what is actually one venue (event 3489).
        "locations:location_key(raw_address, lat, lng, found)"
    )
    .eq("name", rep.name)
    .eq("archived", false)
    .gte("date", today)
    .order("date", { ascending: true });
  if (occErr) {
    console.warn(`[Bot] seq fallback: occurrence lookup failed: ${occErr.message}`);
    return null;
  }

  // 3. Tighten the match with the full fingerprint. We can't push
  //    `seriesKey` into the SQL filter cleanly (it's a JS-side
  //    concatenation), so we filter in-process. The candidate set is
  //    already narrowed by `name` so this scans at most a handful of
  //    rows.
  const targetKey = seriesKey(rep);
  const occurrences = (rows || [])
    .filter((r) => seriesKey(r) === targetKey)
    .map((r) => ({
      id: r.id,
      source: r.source,
      external_slug: r.external_slug ?? null,
      date: r.date,
      start_time: r.start_time,
      end_time: r.end_time,
      tickets_left: r.tickets_left,
      location_key: r.location_key ?? null,
      location: r.locations?.raw_address || null,
      // Flat lat/lng so `venueIdentity` below (which probes both
      // `_coords` and bare lat/lng) can do its job without each call
      // site reaching back into the nested `locations` join.
      lat: r.locations?.lat ?? null,
      lng: r.locations?.lng ?? null,
      _locationFound: r.locations?.found ?? null,
    }));

  // Physical-venue bucketing. See lib/eventSeries.js#venueIdentity for
  // the geocode-first / text-fallback strategy that fixes the "same
  // place, different label" false positive.
  const venueBuckets = new Set();
  for (const o of occurrences) venueBuckets.add(venueIdentity(o));
  const multiVenue = venueBuckets.size > 1;

  return {
    name: rep.name,
    location: rep.locations?.raw_address || null,
    location_key: rep.location_key,
    multiVenue,
    occurrences,
  };
}

bot.action(/^seq:(\d+)$/, async (ctx) => {
  const seriesId = parseInt(ctx.match[1], 10);
  try {
    let payload = sessionStore.getShownSeries(ctx.from.id, seriesId);
    if (!payload || !Array.isArray(payload.occurrences) || payload.occurrences.length === 0) {
      // In-memory series cache miss. This is the COMMON case once a
      // card has lived in the chat for >30min (TTL) or across a bot
      // restart — Telegram keeps the card visible forever, but our
      // session store is in-process and ephemeral.
      //
      // Rather than dead-ending the user with "המופעים פגו", rebuild
      // the series from the DB. The series fingerprint is stable
      // (name + min/max_months — see lib/eventSeries.js#seriesKey),
      // so we can reconstruct the exact same set the original card
      // would have shown, including multi-venue runs where the same
      // workshop happens at several community centres.
      payload = await rebuildSeriesPayloadFromDb(seriesId);
      if (!payload || payload.occurrences.length === 0) {
        // Truly nothing to show — series long-since archived, or the
        // representative id is gone. Now the "expired" message is
        // honest. Alert the operator: this combination (cache miss
        // AND db rebuild empty) is unusual — usually it means the
        // series was archived OR the user hit a bot bug. Either way
        // we want eyes on it before the user complains.
        alertAdmin({
          severity: "warning",
          code: "series_unrecoverable",
          message: "כל המופעים tapped, cache miss AND db rebuild returned 0",
          context: {
            telegramId: ctx.from.id,
            seriesId,
            cachePresent: false,
          },
        }).catch(() => {});
        await safeAck(ctx, "המופעים פגו, חיפשי שוב 🙏", { show_alert: true });
        return;
      }
    }
    // Toast on the callback — without this the button taps silently
    // and the user (who's still looking at the card above) doesn't
    // realise anything happened, because the occurrences list arrives
    // at the BOTTOM of the chat off-screen. The toast is a non-blocking
    // banner Telegram shows for ~3s at the top, just enough to say
    // "something landed, look down".
    //
    // safeAck: cache miss + rebuildSeriesPayloadFromDb can take a few
    // seconds, and if the user was already queued behind an agent
    // turn the ack window may have closed. We still want the
    // occurrences list to land (it's the actual feature) — the toast
    // is just a "look down" hint.
    await safeAck(ctx, "📋 שלחתי לך את כל המופעים למטה ⬇️");

    // Multi-venue: occurrences span >1 venue (e.g. a workshop run
    // at 6 different community centres). We surface the venue
    // per-occurrence and skip the top-level location header —
    // showing one venue at the top would be a lie. Single-venue:
    // keep the old shape (location once at the top, dates only
    // per-occurrence) so the common case isn't noisier.
    //
    // Older cached payloads (pre 2026-05) may not have the
    // `multiVenue` flag — fall back to "false" so they keep
    // rendering the original way.
    const multiVenue = Boolean(payload.multiVenue);

    const lines = [`📋 כל המופעים — ${payload.name}`];
    if (!multiVenue && payload.location) lines.push(`📍 ${payload.location}`);
    lines.push("");

    for (const occ of payload.occurrences) {
      const dateStr = occ.date ? formatHebrewDate(occ.date) : "";
      const timeStr = formatTimeRange(occ.start_time, occ.end_time);
      const ticketsStr =
        occ.tickets_left === 0
          ? "🚫 אזל"
          : occ.tickets_left != null
          ? `🎫 ${occ.tickets_left}`
          : "";
      // Each occurrence gets its own Smarticket detail link via inline
      // markdown. Telegram renders "📅 שני 4.5 — 09:00" as a clickable
      // text link. Falling back to plain text if URL lib breaks is
      // overkill here — the link format is well-tested.
      const url = getBookingUrl(occ);
      const meta = [dateStr, timeStr].filter(Boolean).join(" — ");
      const trailing = ticketsStr ? `  ${ticketsStr}` : "";
      // When the series spans venues, every line carries its own
      // venue so the user can pick by location. Two lines per
      // occurrence reads cleanly enough at the typical N=2-8 series
      // size — and it's the actionable piece they're looking for
      // ("which one is near me?").
      lines.push(`• <a href="${url}">${meta}</a>${trailing}`);
      if (multiVenue && occ.location) {
        lines.push(`   📍 ${occ.location}`);
      }
    }

    // Reply TO the card — see replyAsCallbackResult above for why.
    // This is the original motivating case for the helper: a tapped
    // "כל המופעים" button produces a long off-screen list, and users
    // were missing it.
    //
    // RTL anchoring per-line: each occurrence row starts with `•` (a
    // neutral) followed by an `<a href>` whose body starts with a
    // Hebrew weekday — most lines resolve RTL on their own. BUT the
    // trailing time + ticket-count runs are pure LTR and bidi will
    // group them, so applying RLM at the start of every line keeps
    // every line's paragraph direction explicitly RTL.
    await replyAsCallbackResult(ctx, lines.map(rtlLine).join("\n"), {
      parse_mode: "HTML",
      // Suppress Telegram's automatic link previews so the message
      // stays compact even with many occurrences.
      link_preview_options: { is_disabled: true },
    });
  } catch (err) {
    if (isStaleCallbackQuery(err)) {
      // Benign: ack window closed while we were rendering. The
      // occurrences message may or may not have landed depending on
      // where in the flow we threw — either way nothing actionable.
      console.warn(`[Bot] seq stale ack (user ${ctx.from?.id || "?"}): ${err.message}`);
      return;
    }
    console.error("[Bot] seq error:", err.message);
    // Best-effort error toast. Use safeAck so we don't loop on a
    // stale ack failure inside the catch.
    try { await safeAck(ctx, "⚠️ שגיאה"); } catch {}
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Pagination — "👀 כן, להראות עוד" button after present_event_results
// ──────────────────────────────────────────────────────────────────────────
//
// Deterministic continuation of the LAST search. Instead of routing a
// typed "כן" through Gemini (which has historically wandered into a
// fresh search on a related saved-search topic), this handler reads
// `session.lastSearchHits` + `session.shownEventIds` directly and
// renders the next batch via the same `sendEventCard` path as the
// agent tool. No LLM round-trip — that's the whole point.
//
// Cache-miss is benign: if the session expired (TTL or process restart)
// the user gets a friendly "החיפוש הזה לא בתוקף עוד" and a hint to ask
// again. The button itself stays on the old card forever (Telegram
// retention), so a stale tap is normal at long intervals.
bot.action(/^pgn:next$/, async (ctx) => {
  const telegramId = ctx.from.id;
  try {
    const hits = sessionStore.getLastSearchHits(telegramId);
    if (!hits.length) {
      await safeAck(ctx, "החיפוש הזה כבר לא בתוקף — תגידי לי מה תרצי לחפש 🙏", { show_alert: true });
      return;
    }
    const { selectSeriesForRender, venueIdentity } = require("../lib/eventSeries");

    const shownIds = new Set(sessionStore.getShownEventIds(telegramId));
    // Order matters: pass ids in the same order they appear in `hits`
    // so the "next batch" is the next 5 distinct series the user
    // hasn't seen, in the original relevance order from search_events.
    const candidateIds = hits
      .map((e) => e?.id)
      .filter((id) => id != null && !shownIds.has(id));

    if (!candidateIds.length) {
      await safeAck(ctx, "זה הכל בחיפוש הזה ✨", { show_alert: true });
      // Remove the button so a second tap doesn't keep firing.
      try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch {}
      sessionStore.clearLastSearchHits(telegramId);
      return;
    }

    await safeAck(ctx, "👀 רגע, מציגה לך עוד...");

    const MAX_PER_BATCH = 5;
    const { series } = selectSeriesForRender(candidateIds, hits, MAX_PER_BATCH);
    const renderedIds = [];
    for (const s of series) {
      const event = s.representative;
      if (!event) continue;
      try {
        const venueBuckets = new Set();
        for (const o of s.occurrences) venueBuckets.add(venueIdentity(o));
        const multiVenue = venueBuckets.size > 1;

        if (s.occurrences.length > 1) {
          sessionStore.rememberShownSeries(telegramId, event.id, {
            name: event.name,
            location: event.location,
            location_key: event.location_key,
            multiVenue,
            occurrences: s.occurrences.map((o) => ({
              id: o.id,
              source: o.source,
              external_slug: o.external_slug ?? null,
              date: o.date,
              start_time: o.start_time,
              end_time: o.end_time,
              tickets_left: o.tickets_left,
              location: o.location ?? null,
              location_key: o.location_key ?? null,
              lat: o._coords?.lat ?? null,
              lng: o._coords?.lng ?? null,
            })),
          });
        }
        await sendEventCard(ctx, event, {
          seriesOccurrenceCount: s.occurrences.length,
          seriesMultiVenue: multiVenue,
        });
        for (const o of s.occurrences) {
          if (o?.id != null) renderedIds.push(o.id);
        }
      } catch (err) {
        console.error("[Bot] pgn:next card error:", err.message);
      }
    }

    if (renderedIds.length) {
      sessionStore.rememberShownEvents(telegramId, renderedIds);
    }

    // Remove the button on the original card — we just consumed it.
    try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch {}

    // Count remaining AFTER this batch. If any, offer another button.
    const newShownIds = new Set(sessionStore.getShownEventIds(telegramId));
    const { groupIntoSeries } = require("../lib/eventSeries");
    const remainingSeriesCount = groupIntoSeries(hits).filter(
      (s) => !s.occurrences.some((o) => newShownIds.has(o.id)),
    ).length;

    if (remainingSeriesCount > 0) {
      const label = remainingSeriesCount === 1
        ? "👀 כן, להראות עוד 1"
        : `👀 כן, להראות עוד ${remainingSeriesCount}`;
      const text = remainingSeriesCount === 1
        ? "יש עוד סדרת אירועים אחת — להראות?"
        : `יש עוד ${remainingSeriesCount} סדרות — להראות?`;
      await ctx.reply(text, Markup.inlineKeyboard([
        [Markup.button.callback(label, "pgn:next")],
      ]));
    } else {
      await ctx.reply("זה הכל בחיפוש הזה ✨");
      sessionStore.clearLastSearchHits(telegramId);
    }
  } catch (err) {
    if (isStaleCallbackQuery(err)) {
      console.warn(`[Bot] pgn stale ack (user ${ctx.from?.id || "?"}): ${err.message}`);
      return;
    }
    console.error("[Bot] pgn:next error:", err.message);
    try { await safeAck(ctx, "⚠️ שגיאה"); } catch {}
  }
});

bot.action(/^unw:(\d+)$/, async (ctx) => {
  const eventId = ctx.match[1];
  try {
    await removeWatcher(ctx.from.id, eventId);
    await ctx.answerCbQuery("🔕 הוסרת מהמעקב");
    await ctx.editMessageReplyMarkup({
      inline_keyboard: [[{ text: "🔔 עדכן אותי אם מתפנה", callback_data: `wt:${eventId}` }]],
    });
  } catch (err) {
    console.error("[Bot] unw error:", err.message);
    await ctx.answerCbQuery("⚠️ שגיאה");
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Second-hand ticket flow (WhatsApp groups)
// ──────────────────────────────────────────────────────────────────────────
bot.action(/^ct:(.+)$/, async (ctx) => {
  const ticketId = ctx.match[1];
  try {
    if (!(await isStillActive(ticketId))) {
      await ctx.answerCbQuery("❌ הכרטיס נמכר!");
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
      return;
    }
    await logClick(String(ctx.from.id), ticketId);
    const ticket = await getTicket(ticketId);

    if (ticket?.seller_phone) {
      const phone = ticket.seller_phone.replace(/^0/, "972");
      const text = encodeURIComponent(`היי, ראיתי את ההודעה לגבי ${ticket.event_title}. עדיין זמין?`);

      await ctx.answerCbQuery();
      await replyAsCallbackResult(ctx, "📞 לחצי לפניה למוכר:", Markup.inlineKeyboard([
        Markup.button.url("💬 WhatsApp", `https://wa.me/${phone}?text=${text}`),
      ]));

      if (ticket.quantity > 1) {
        const btns = Array.from({ length: Math.min(ticket.quantity, 5) }, (_, i) =>
          Markup.button.callback(`${i + 1}`, `tk:${ticketId}:${i + 1}`),
        );
        btns.push(Markup.button.callback("הכל", `tk:${ticketId}:${ticket.quantity}`));
        await replyAsCallbackResult(ctx, `כמה לקחת?`, Markup.inlineKeyboard(btns));
      }
      await notifySeller(ticket, ctx.from.first_name);
    } else {
      await ctx.answerCbQuery("מספר המוכר לא זמין.");
    }
  } catch (err) {
    console.error("[Bot] ct error:", err.message);
    await ctx.answerCbQuery("⚠️");
  }
});

bot.action(/^tk:(.+):(\d+)$/, async (ctx) => {
  try {
    const [, ticketId, takenStr] = ctx.match;
    const taken = parseInt(takenStr, 10);
    const ticket = await getTicket(ticketId);
    if (!ticket) { await ctx.answerCbQuery("לא נמצא"); return; }

    const remaining = ticket.quantity - taken;
    await updateQuantity(ticketId, remaining);
    if (remaining <= 0) {
      await ctx.answerCbQuery("✅ נמכר לחלוטין");
      await ctx.editMessageText(`✅ כל ${ticket.quantity} הכרטיסים נלקחו.`);
    } else {
      await ctx.answerCbQuery(`✅ נותרו ${remaining}`);
      await ctx.editMessageText(`✅ לקחת ${taken}. נותרו ${remaining}.`);
    }
  } catch (err) {
    console.error("[Bot] tk error:", err.message);
    await ctx.answerCbQuery("⚠️");
  }
});

bot.action(/^sd:(.+)$/, async (ctx) => {
  try {
    await markSoldById(ctx.match[1]);
    await ctx.answerCbQuery("✅ נמכר");
    await ctx.editMessageText("✅ סומן כנמכר. תודה!");
  } catch (err) {
    console.error("[Bot] sd error:", err.message);
    await ctx.answerCbQuery("⚠️");
  }
});

bot.action(/^sa:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery("👍");
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
});

// ──────────────────────────────────────────────────────────────────────────
// Event-feedback flow ("❌ לא מתאים" → reason picker → save)
// ──────────────────────────────────────────────────────────────────────────
//
// IMPORTANT: only the `wrong_audience` reason ever gets aggregated into
// audience tags, and even then with high evidence thresholds (handled in
// feedbackService later). All other reasons are pure data — we collect
// them so we can analyse usage, but they do NOT influence what events
// the user sees in subsequent searches. This is on purpose: someone
// flagging "too far" tells us about THEIR proximity preference, not about
// the event itself, and we already have explicit proximity filters.
const REASON_KEYS = ["wrong_audience", "too_far", "wrong_time", "not_interested", "already_seen", "other"];

bot.action(/^fb:reasons:(\d+)$/, async (ctx) => {
  const eventId = ctx.match[1];
  // safeAck: if the user tapped while the bot was busy or just
  // restarted, the ack TTL (~15s) may have passed by the time we
  // run. We still want to render the reasons keyboard — the ack is
  // cosmetic, the keyboard is the feature.
  await safeAck(ctx);
  const rows = REASON_KEYS.map((k) => [
    Markup.button.callback(REASON_LABELS[k], `fb:save:${eventId}:${k}`),
  ]);
  rows.push([Markup.button.callback("↩️ חזרה", `fb:cancel:${eventId}`)]);
  await replyAsCallbackResult(ctx, "מה הסיבה? (זה עוזר לי ללמוד)", Markup.inlineKeyboard(rows));
});

bot.action(/^fb:cancel:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery("👍");
  await ctx.deleteMessage().catch(() => {});
});

bot.action(/^fb:save:(\d+):([a-z_]+)$/, async (ctx) => {
  const [, eventId, reason] = ctx.match;
  if (!REASON_KEYS.includes(reason)) {
    await ctx.answerCbQuery("⚠️");
    return;
  }
  // Save first, surface UI update separately. Otherwise an edit-message
  // failure (Telegram rate-limit, message-too-old, "message is not
  // modified", schema-cache transient, …) would surface as the misleading
  // "⚠️ לא הצלחתי לשמור" toast even though the feedback row DID land in
  // Postgres. Keeping the two failure modes distinct also keeps Sentry
  // signal clean.
  let saved = false;
  try {
    await recordFeedback({
      eventId,
      telegramId: ctx.from.id,
      reason,
    });
    saved = true;
  } catch (err) {
    console.error("[Bot] fb:save error:", err.message);
    alertAdmin({
      severity: "error",
      code: "feedback_save_failed",
      message: "Failed to persist event feedback",
      context: {
        eventId,
        reason,
        telegramId: ctx.from?.id,
        error: err.message,
      },
    }).catch(() => {});
    await ctx.answerCbQuery("⚠️ לא הצלחתי לשמור");
    return;
  }
  const ack = ACK_LABELS[reason] || "✅ תודה";
  await ctx.answerCbQuery(ack);
  // Best-effort UI cleanup. If the edit fails we already toasted the
  // user, so swallow the error rather than re-surfacing it as a save
  // failure.
  try {
    await ctx.editMessageText(ack);
  } catch (err) {
    // "message is not modified" / "message to edit not found" / 429s
    // are benign here — the data is saved and the user has the toast.
    if (!/not modified|message to edit not found|too many requests/i.test(err.message || "")) {
      console.warn("[Bot] fb:save edit-ui failed (data saved):", err.message);
    }
  }
});

async function notifySeller(ticket, buyerName) {
  try {
    const sellerProfile = await getProfile(ticket.seller_phone);
    if (!sellerProfile) return;
    await bot.telegram.sendMessage(
      sellerProfile.telegram_id,
      `👋 מישהו${buyerName ? ` (${buyerName})` : ""} מתעניין ב-${ticket.event_title}.\nעדיין זמין?`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: "✅ זמין", callback_data: `sa:${ticket.id}` },
            { text: "❌ נמכר", callback_data: `sd:${ticket.id}` },
          ]],
        },
      },
    );
  } catch {}
}

// ────────────────────────────────────────────────────────────────────────
// Secondary-market: Telegram-user ticket offer flow
// ────────────────────────────────────────────────────────────────────────

// Renders a "ticket available" card to a watcher when a fresh user-
// offered ticket lands on an event they were watching. Mirrors
// sendTicketCard's shape but uses `tint:<ticket_id>` so the contact
// flow can introduce buyer ↔ seller via Telegram (instead of the
// WhatsApp deep-link the regular ct: flow uses).
async function sendUserOfferToWatcher(chatId, ticket) {
  const icon = getEventIcon({ name: ticket.event_title });
  const lines = [
    `${icon} *כרטיס חדש לאירוע שאת/ה עוקב/ת אחריו*`,
    "",
    ticket.event_title,
  ];
  if (ticket.event_date) lines.push(`📅 ${formatHebrewDate(ticket.event_date)}`);
  const timeStr = formatTimeRange(ticket.event_time, null);
  if (timeStr) lines.push(rtlLine(`🕐 ${timeStr}`));
  if (ticket.quantity != null) lines.push(rtlLine(`🎟️ כמות: ${ticket.quantity}`));
  if (ticket.price) lines.push(rtlLine(`💰 ${ticket.price}`));

  // The interested-button always goes through `tint:` for offer-flow
  // tickets — that handler reaches the seller via their Telegram id,
  // not phone. WhatsApp-sourced tickets keep using `ct:` from
  // sendTicketCard.
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("💬 מתעניין/ת", `tint:${ticket.id}`)],
  ]);

  try {
    await bot.telegram.sendMessage(chatId, lines.join("\n"), {
      ...keyboard,
      parse_mode: "Markdown",
    });
  } catch (err) {
    // Watchers may have blocked the bot — that's not an error worth
    // alerting on (the recap still surfaces the active ticket).
    console.warn(
      `[Bot] sendUserOfferToWatcher to chat ${chatId} failed: ${err.message}`,
    );
  }
}

// Look up the seller's public Telegram identity (username if set,
// else first_name). Uses telegram.getChat which works for any user
// that's ever talked to the bot — true for sellers (they just used
// the offer wizard). Returns { handle, display } where:
//   - handle is "@username" when available, else null
//   - display is the most user-friendly identifier we have
//     ("@username", "First L.", or fallback to "user").
async function sellerContactView(sellerTelegramId) {
  try {
    const chat = await bot.telegram.getChat(sellerTelegramId);
    const handle = chat.username ? `@${chat.username}` : null;
    const display = handle || chat.first_name || "המוכר/ת";
    return { handle, display };
  } catch (err) {
    console.warn(
      `[Bot] sellerContactView lookup failed for ${sellerTelegramId}: ${err.message}`,
    );
    return { handle: null, display: "המוכר/ת" };
  }
}

// `tof:save:<offerId>` — seller tapped 💾 שמירה on the preview card.
// Pulls the validated offer payload from session, persists the row,
// fans out to event watchers, and ACKs with a watcher count.
bot.action(/^tof:save:(.+)$/, async (ctx) => {
  const offerId = ctx.match[1];
  const session = sessionStore.getSession(String(ctx.from.id));
  const pending = session?.pendingTicketOffers?.[offerId];
  if (!pending) {
    // Session expired or the user already saved/cancelled this card.
    // Either way it's a no-op from our side — silently disable the
    // buttons so they don't keep tapping.
    await ctx.answerCbQuery("✖️ פג תוקף");
    try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch {}
    return;
  }

  let result;
  try {
    result = await saveTicketOfferToDb({
      event_id: pending.event_id,
      quantity: pending.quantity,
      price: pending.price,
      phone: pending.phone,
      seller_telegram_id: pending.seller_telegram_id,
    });
  } catch (err) {
    console.error("[Bot] tof:save persist error:", err.message);
    await ctx.answerCbQuery("⚠️ שמירה נכשלה");
    alertAdmin({
      severity: "error",
      code: "ticket_offer_save_failed",
      message: "Failed to persist user-offered ticket",
      context: {
        offerId,
        telegramId: ctx.from?.id,
        eventId: pending.event_id,
        error: err.message,
      },
    }).catch(() => {});
    return;
  }
  if (result?.error) {
    console.warn("[Bot] tof:save returned error:", result.error);
    await ctx.answerCbQuery("⚠️ לא הצלחתי לשמור");
    return;
  }

  // Clear the pending slot — preview is now a saved row. Sessions
  // are returned by reference from sessionStore.getSession, so the
  // mutation persists without an explicit save call.
  if (session?.pendingTicketOffers) delete session.pendingTicketOffers[offerId];

  const notified = result.notified_count || 0;
  const ack = notified > 0
    ? `✅ נשמר. הודעתי ל-${notified} ${notified === 1 ? "אדם" : "אנשים"} שממתינים לכרטיס.`
    : `✅ נשמר. כרגע אין מי שממתין לכרטיס לאירוע הזה, אבל אם מישהו ירשם נעדכן.`;
  await ctx.answerCbQuery("✅ נשמר");
  try {
    await ctx.editMessageText(ack);
  } catch (err) {
    if (!/not modified|message to edit not found/i.test(err.message || "")) {
      console.warn("[Bot] tof:save edit-ui failed:", err.message);
    }
  }

  // Fan out to watchers. fanOutToWatchers already returned them in
  // the save result AND stamped notified_at — we just send the
  // cards. Re-build a ticket-shaped object for the renderer.
  const ticketView = {
    id: result.ticket_id,
    event_title: pending.event_name,
    event_date: pending.event_date,
    event_time: pending.event_time,
    quantity: pending.quantity,
    price: pending.price,
  };
  for (const w of result.watchers || []) {
    if (String(w.telegram_id) === String(ctx.from.id)) continue; // don't notify the seller about their own ticket
    await sendUserOfferToWatcher(w.telegram_id, ticketView);
  }
});

// `tof:cancel:<offerId>` — seller chose ✖️ ביטול on the preview.
bot.action(/^tof:cancel:(.+)$/, async (ctx) => {
  const offerId = ctx.match[1];
  const session = sessionStore.getSession(String(ctx.from.id));
  if (session?.pendingTicketOffers?.[offerId]) {
    delete session.pendingTicketOffers[offerId];
  }
  await ctx.answerCbQuery("✖️ בוטל");
  try {
    await ctx.editMessageText("✖️ ביטלתי את ההצעה.");
  } catch {}
});

// `tint:<ticket_id>` — watcher tapped 💬 מתעניין/ת on a user-offered
// ticket card. Introduces buyer ↔ seller: each gets the other's
// Telegram handle (@username or first_name) so they can DM directly.
// Falls back gracefully when @username isn't set on either side.
bot.action(/^tint:(.+)$/, async (ctx) => {
  const ticketId = ctx.match[1];
  try {
    const ticket = await getTicket(ticketId);
    if (!ticket) {
      await ctx.answerCbQuery("הכרטיס לא נמצא");
      return;
    }
    if (ticket.status !== "active") {
      await ctx.answerCbQuery("הכרטיס כבר לא זמין");
      try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch {}
      return;
    }
    // tint: is specifically the telegram-introduction flow. WhatsApp
    // tickets without a seller_telegram_id should never reach this
    // handler (their card uses ct: instead), but be defensive: if
    // we somehow got here, fall back to a generic notification.
    if (!ticket.seller_telegram_id) {
      await ctx.answerCbQuery("⚠️ פרטי קשר חסרים");
      return;
    }

    await logClick(String(ctx.from.id), ticketId);

    const seller = await sellerContactView(ticket.seller_telegram_id);
    const buyerHandle = ctx.from.username ? `@${ctx.from.username}` : null;
    const buyerDisplay = buyerHandle || ctx.from.first_name || "מתעניין/ת";

    // Notify the buyer (the tapper): give them the seller's handle.
    const buyerLines = [
      `📨 *${ticket.event_title}*`,
      "",
      `המוכר/ת: ${seller.display}`,
    ];
    if (seller.handle) {
      buyerLines.push("", `ניתן לפנות ישירות בטלגרם: ${seller.handle}`);
    } else if (ticket.seller_phone) {
      buyerLines.push("", `טלפון: ${ticket.seller_phone}`);
    } else {
      buyerLines.push("", "יידעתי את המוכר/ת שאתם מתעניינים, הם יחזרו אליכם בקרוב.");
    }
    await ctx.answerCbQuery("✅ יידעתי את המוכר/ת");
    try {
      await replyAsCallbackResult(ctx, buyerLines.join("\n"), undefined);
    } catch (err) {
      console.warn("[Bot] tint buyer reply failed:", err.message);
    }

    // Notify the seller: someone is interested. Surface buyer's
    // handle (or first_name) + a sold/still-available button pair
    // so they can confirm or close the offer in one tap.
    const sellerLines = [
      `👋 *${buyerDisplay} מתעניין/ת בכרטיס שלך*`,
      "",
      ticket.event_title,
    ];
    if (ticket.event_date) sellerLines.push(`📅 ${formatHebrewDate(ticket.event_date)}`);
    if (buyerHandle) {
      sellerLines.push("", `אפשר לפנות ישירות: ${buyerHandle}`);
    } else {
      sellerLines.push("", "(הקונה לא חשפ/ה @username — חכ/י שיפנו אליך)");
    }
    try {
      await bot.telegram.sendMessage(ticket.seller_telegram_id, sellerLines.join("\n"), {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[
            { text: "✅ זמין", callback_data: `sa:${ticket.id}` },
            { text: "❌ נמכר", callback_data: `sd:${ticket.id}` },
          ]],
        },
      });
    } catch (err) {
      console.warn(`[Bot] tint seller DM failed (id=${ticket.seller_telegram_id}): ${err.message}`);
    }
  } catch (err) {
    console.error("[Bot] tint error:", err.message);
    await ctx.answerCbQuery("⚠️");
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Boot
// ──────────────────────────────────────────────────────────────────────────
console.log("[Bot] Starting...");
runCleanup()
  .then(({ deleted, archived }) => {
    console.log(`[Bot] Boot cleanup: deleted=${deleted}, archived=${archived}`);
  })
  .catch((err) => console.warn("[Bot] Boot cleanup warning:", err.message))
  .finally(() => {
    bot.launch()
      .then(() => console.log("[Bot] Running"))
      .catch((err) => {
        console.error("[Bot] Failed to start:", err.message);
        process.exit(1);
      });
  });

process.once("SIGINT", () => { gracefulShutdown("SIGINT").catch(() => process.exit(1)); });
process.once("SIGTERM", () => { gracefulShutdown("SIGTERM").catch(() => process.exit(1)); });

module.exports = bot;
