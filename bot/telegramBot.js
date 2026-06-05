// Local dev override: .env.local explicitly OVERRIDES anything already
// in process.env (shell exports from .zshrc, parent processes, etc.).
// Without `override: true` a `TELEGRAM_TOKEN` already set in your shell
// would win over .env.local and your local bot would race the
// production polling. Then load .env as a fallback for everything
// .env.local didn't cover. Railway has neither file and injects vars
// directly, so this is a no-op there.
require("dotenv").config({
  path: require("path").resolve(__dirname, "..", ".env.local"),
  override: true,
});
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
  addInterest,
  removeInterest,
  isInterested,
  recordInterestSignal,
  recordPositiveSignal,
  recordNotInterestedSignal,
  recordTooFarSignal,
} = require("../lib/interestService");
const {
  registerFeedbackHandlers,
  handlePendingFeedbackText,
  handlePendingFeedbackKidWizardText,
} = require("../lib/feedbackFlow");
const {
  startKidsCapture,
  handlePendingKidsCaptureText,
  PROMPT: KIDS_AGE_PROMPT,
} = require("../lib/kidsProfileCapture");
const {
  formatProfileLines,
  formatFavoriteLocationsLines,
  buildLearnedPreferencesLines,
} = require("../lib/profileDisplay");
const {
  openFavoriteLocationsPicker,
  editFavoriteLocationsPicker,
  saveFavoriteLocationsPicker,
} = require("../lib/favoriteLocationsPicker");
const {
  buildMainMenuKeyboard,
  buildProfileViewKeyboard,
  buildProfileEditKeyboard,
  buildGenderEditKeyboard,
  buildDisplayNameEditKeyboard,
  buildAddressEditKeyboard,
  buildAgeEditKeyboard,
  resolveReplyAction,
  shouldShowTypingMenu,
  MENU,
} = require("../lib/typingActionsMenu");
const {
  showMainMenu,
  showFullMenu,
  showSearchHub,
  buildProfileViewKeyboardExtra,
} = require("../lib/botNavigation");
const {
  listSavedSearches,
  archiveSavedSearch,
  promoteToRecurring: promoteSavedSearchToRecurring,
  decrementTicketsRemaining: decrementSavedSearchRemaining,
  getSavedSearch,
  updateSavedSearch,
  createSavedSearch,
} = require("../lib/savedSearchService");
const {
  getTicket, logClick, isStillActive, updateQuantity, markSoldById,
} = require("../lib/ticketService");
const { _saveOffer: saveTicketOfferToDb } = require("../lib/agent/tools/ticketOffer");
const referralService = require("../lib/referralService");
const { flushDueNotifications } = require("../lib/scheduleService");
const {
  formatHebrewDate,
  formatTimeRange,
  formatTagLine,
  formatAdultAgeGate,
  formatAudienceLineForOccurrence,
  getEventIcon,
  formatEventCardTitleLines,
  resolveEventTitleParts,
  rtlLine,
  chunkRtlHtmlLines,
} = require("../lib/eventFormat");
const { describeWindowHe } = require("../lib/timeContext");
const {
  formatTicketsLine,
  formatLowStockBadge,
  buildNavButtons,
  buildMapsNavUrl,
  navOptsFromProfile,
  formatDescriptionForCard,
  buildReadMoreDeepLink,
  buildMiniAppReadMoreLink,
  buildEventCardDeepLink,
  parseReadMoreStartPayload,
  parseEventCardStartPayload,
} = require("../lib/eventCard");
const { getEventById, flattenEvent, expandLabels } = require("./matchingService");
const {
  filterAndRankForProfile,
  countProfileMatches,
  annotateProximity,
} = require("../lib/profileEventFilter");
const { normalizeImageUrl } = require("../lib/imageUrl");
const { isCityWideLocation } = require("../lib/locationStore");
const { fetchUmbrellaSiblingRows } = require("../lib/umbrellaSiblings");
const { getBookingUrl } = require("../lib/sourceUrls");
const { runCleanup } = require("../lib/archiveService");
const { getStaticReply } = require("../lib/staticReplies");
const { runAgent } = require("../lib/agent/orchestrator");
const { isAgentEnabled } = require("../lib/agentConfig");
const {
  runRouterTextTurn,
  runRouterPreset,
  runSearchWithFilters,
  startSaveFromLastSearch,
  searchMenuKeyboard,
} = require("../lib/searchRouterRunner");
const sessionStore = require("../lib/agent/sessionStore");
const supabase = require("../lib/supabase");
const { audienceLabel, AUDIENCE_LABELS } = require("../lib/categories");
const {
  TOPIC_CATEGORIES,
  AUDIENCE_CATEGORIES,
  LOCATION_OPTIONS,
  getTopicById,
  getTopicByLabel,
  getAudienceById,
  getLocationById,
  getChipByLabel,
} = require("../lib/interestCategories");
const {
  fetchTopLabelsPage,
  countAvailableLabels,
  PAGE_SIZE: TOP_LABELS_PAGE_SIZE,
} = require("../lib/topLabelsService");

// Hard cap on how many top-label chips can be loaded into the
// onboarding picker before the "🔁 הצג עוד" button hides itself.
// Telegram's inline_keyboard practically tops out around 100 rows;
// with one chip per row (the toplabels step uses single-column
// layout) + nav row + show-more row we cap at 60 chips so the
// keyboard stays comfortably under the limit (62 rows total).
// Without this cap, a user who rapidly paginates through a 363-
// label catalog hits the limit and the trailing rows (including
// "💾 שמרי") get silently truncated by Telegram — exactly the
// bug the user reported. Niche labels past the top-60 by
// popularity can still be added via free-text chat with the agent.
const MAX_LOADED_TOP_LABELS = 60;

// Chip rendering for the toplabels picker. We tried `\n` to wrap to
// two lines but Telegram inline buttons DON'T honor newlines —
// they're rendered as a stripped space (or nothing), making the
// single source line longer than before and pushing the trailing
// count off-screen with the truncation ellipsis. So instead we put
// the COUNT FIRST in the source string: when Telegram clips the
// end of a too-long chip, the popularity number survives and the
// (still-recognisable) leading chars of the label name take the
// hit. Hebrew compound names read fine from their prefix, e.g.
// "ר"געים משחקייה התפ…" still parses as the playgroup chip.
const { enrichPendingEvents } = require("../lib/eventEnricher");
const { recordFeedback } = require("../lib/feedbackService");
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
  // Telegram's "Markdown" (v1) treats * _ ` [ as control chars.
  // Escape them so user-supplied text (event names, location strings)
  // can never accidentally open a formatting span.
  return String(s)
    .replace(/\\/g, "\\\\") // backslash first
    .replace(/\*/g, "\\*")
    .replace(/_/g, "\\_")
    .replace(/`/g, "\\`")
    .replace(/\[/g, "\\[");
}

// Escape user-supplied strings for Telegram HTML parse mode.
// Only & < > need escaping; all other characters pass through.
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function readMoreHrefFor(telegram, eventId) {
  if (eventId == null || !telegram) return null;
  try {
    const username = await referralService.getBotUsername(telegram);
    return buildReadMoreDeepLink(username, eventId);
  } catch {
    return null;
  }
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
// We use a TWO-PRONGED approach because a single technique isn't
// enough across all Telegram clients:
//
//   1. Per-line `\u200F` (RLM) — a strong-RTL "mark" that satisfies the
//      bidi algorithm's first-strong-character rule. Works in most
//      desktop+mobile clients for plain message bubbles.
//
//   2. Whole-block `\u202B`…`\u202C` (RLE / Right-to-Left Embedding +
//      PDF / Pop Directional Formatting) wrap — an explicit Unicode
//      DIRECTIONAL FORMATTING control that forces the entire block
//      to render as an RTL embedding. RLM is a "hint" the bidi
//      algorithm can override; RLE is a "command". Telegram Desktop
//      (and a couple of older mobile builds) have been observed
//      stripping or ignoring the leading RLM in PHOTO CAPTIONS
//      specifically, while still honouring RLE+PDF. Belt and
//      suspenders here is the difference between "almost always
//      RTL" and "definitely RTL".
//
// Idempotent on both layers:
//   - `rtlLine` no-ops when a line already starts with U+200F.
//   - The RLE wrap checks for an existing leading U+202B before
//     adding another pair, so the call-sites that hand-wrapped text
//     before reaching this layer don't accumulate extra control chars.
//
// All five outgoing-text methods on `bot.telegram` are patched once
// at boot — `ctx.reply` / `ctx.replyWithPhoto` caption / `ctx.editMessageText`
// / `bot.telegram.sendMessage` direct admin broadcasts / etc. all
// flow through one of them, so no caller needs to remember the
// wrapper.
const RLE = "\u202B";
const PDF = "\u202C";

(() => {
  const wrapText = (s) => {
    if (typeof s !== "string" || !s) return s;
    // Idempotency check happens on the RAW input BEFORE the per-line
    // RLM pass. Otherwise rtlLine would prepend a U+200F in front of
    // the existing U+202B, the perLine.startsWith(RLE) check below
    // would fail, and we'd nest another RLE/PDF pair on every
    // re-entrant wrap. Catching it here keeps the output stable
    // through any number of re-wraps and keeps the caption length
    // under the 1024-char Telegram limit predictable.
    if (s.startsWith(RLE)) return s;
    const perLine = s.split("\n").map(rtlLine).join("\n");
    return `${RLE}${perLine}${PDF}`;
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
  // Refresh the labelStore name→id cache at the top of every scrape.
  // Postgres auto-prunes labels whose events_count drops to 0 (sql/050),
  // and an in-memory cache that outlives that delete would hand back a
  // dangling id on the next setEventLabels, writing a dead reference
  // into events.tag_ids. Scrape order (upsert → cleanup → city scrape)
  // keeps things consistent WITHIN a cycle; this clear closes the gap
  // BETWEEN cycles. Cheap — the cache rebuilds on first lookup.
  try {
    const labelStore = require("../lib/labelStore");
    labelStore._clearCache();
  } catch (err) {
    console.warn("[Scrape] labelStore cache clear failed:", err.message);
  }

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
    // Alert about events that timed out and were left with audience=null.
    // Deduped by event ID so the same event doesn't spam on every scrape cycle.
    if (stats?.fallbackEvents?.length) {
      for (const ev of stats.fallbackEvents) {
        alertAdmin({
          severity: "warning",
          code: "enricher_timeout_fallback",
          message: `אירוע #${ev.id} "${(ev.name || "").slice(0, 60)}" — Gemini timed out. audience ו-category נשארו null. בדקי ידנית.`,
          dedupe_key: `enricher_timeout:${ev.id}`,
        }).catch(() => {});
      }
    }
  } catch (err) {
    if (err.message.includes("Daily Gemini limit reached")) {
      const today = new Date().toLocaleDateString("en-CA");
      alertAdmin({
        severity: "warning",
        code: "enricher_daily_limit",
        message: err.message,
        dedupe_key: `enricher_daily_limit:${today}`,
      }).catch(() => {});
    } else {
      console.error("[Enricher] enrichPendingEvents failed:", err.message);
    }
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
// Replace a single button inside a Telegram reply_markup by callback_data.
// Returns a new reply_markup object. Used by interest toggle handlers to
// flip the button text without re-rendering the whole card.
function replaceInlineButton(replyMarkup, oldCallbackData, newButton) {
  if (!replyMarkup?.inline_keyboard) return replyMarkup;
  return {
    inline_keyboard: replyMarkup.inline_keyboard.map((row) =>
      row.map((btn) =>
        btn.callback_data === oldCallbackData ? newButton : btn,
      ),
    ),
  };
}

function buildDetailsButton(event) {
  const url = getBookingUrl(event);
  if (!url) return null;
  return Markup.button.url("🔗 לאתר", url);
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
  const soldOut = event.tickets_left === 0 || event._is_sold_out;
  // Two-tier title (May-2026 user request, sql/056 cleanup).
  //   Primary   = umbrella_title — the "branding" line. For a non-
  //               umbrella event there's no umbrella, so the event's
  //               own name is the primary.
  //   Secondary = name — the date-specific child title, but ONLY
  //               when this row is under an umbrella AND `name` is
  //               distinct from `umbrella_title`. For singles (no
  //               umbrella) and active-garden-style children (name
  //               echoes the umbrella) the secondary line is
  //               omitted and we render a single title line.
  // Parent events under an umbrella: emoji on the secondary (session)
  // title, not the umbrella branding line — see formatEventCardTitleLines.
  const lines = formatEventCardTitleLines(event, escapeHtml);
  if (event.date) lines.push(`📅 ${formatHebrewDate(event.date)}`);
  const timeStr = formatTimeRange(event.start_time, event.end_time);
  if (timeStr) lines.push(rtlLine(`🕐 ${timeStr}`));
  const profile = await getCachedUserProfile(ctx);
  const { enrichProximityForCard } = require("../lib/locationPrefs");
  await enrichProximityForCard(event, profile);
  const { formatAudienceLineWithHints } = require("../lib/audienceDisplay");
  const audienceLine = formatAudienceLineWithHints(event, { profile });
  if (audienceLine) lines.push(escapeHtml(audienceLine));
  if (isCityWideLocation(event.location_key)) {
    lines.push(`🗺️ ברחבי העיר`);
  } else {
    // Show THIS card's actual venue, even for a multi-venue series —
    // hiding it behind a bare "מתקיים במספר מיקומים" was more confusing
    // than helpful. When the series runs elsewhere too, add a positive
    // note below pointing at «כל המופעים».
    if (event.location) {
      // Link the venue straight to Google Maps (same as the newsletter
      // card / series list), unless it's an online event.
      const navUrl = event.online_url
        ? null
        : buildLocationNavUrl(event, navOptsFromProfile(profile, event));
      lines.push(
        navUrl
          ? `📍 <a href="${escapeHtml(navUrl)}">${escapeHtml(event.location)}</a>`
          : `📍 ${escapeHtml(event.location)}`,
      );
    }
  }
  // Tickets line — the helper handles all branches:
  //   sold out         → "🚫 אזלו הכרטיסים"
  //   low stock (≤9)   → "🎫 N כרטיסים אחרונים ❗️"  (merged, single line)
  //   has tickets      → "🎫 N כרטיסים"
  //   free / null      → null (omit the line — printing "🎫 null
  //                      כרטיסים" was a real bug pre-May-2026)
  // Note: `soldOut` here also captures `event._is_sold_out` (the
  // search-time mark for series with at least one open slot
  // elsewhere), which the helper alone wouldn't catch. We honour it
  // explicitly so the line still says "אזלו" in that case.
  const ticketsLine = soldOut
    ? "🚫 אזלו הכרטיסים"
    : formatTicketsLine(event.tickets_left);
  if (ticketsLine) lines.push(ticketsLine);
  if (additionalOccurrences > 0) {
    let moadStr;
    if (additionalOccurrences === 1) {
      moadStr = "מופע נוסף";
    } else if (additionalOccurrences > SERIES_CARD_COUNT_CAP) {
      moadStr = `${SERIES_CARD_COUNT_CAP}+ מופעים נוספים`;
    } else {
      moadStr = `${additionalOccurrences} מופעים נוספים`;
    }
    lines.push(`🔁 ${moadStr}`);
  }
  if (event._proximity?.label) lines.push(escapeHtml(event._proximity.label));

  // Minimal-bot model: when the Mini App is configured the card is a
  // TEASER and a single "📖 לפרטים והרשמה" button opens the full event
  // page in the Web App (startapp deep link → fresh launch, robust on
  // stale messages; web_app fallback when we can't resolve the username).
  // Without a Mini App URL the bot is the only UI → richer buttons below.
  const catalogConfigured = Boolean(getMiniAppCatalogUrl());
  const botUsername = catalogConfigured
    ? await referralService.getBotUsername(ctx.telegram).catch(() => null)
    : null;
  const miniEventLink =
    catalogConfigured && botUsername
      ? buildMiniAppReadMoreLink(botUsername, event.id)
      : null;
  const miniEventWebUrl = catalogConfigured ? getMiniAppEventUrl(event.id) : null;

  // Description (sql/053) — excerpt + inline "קרא עוד" link when truncated.
  // Points at the Web App event page when configured, else the in-bot
  // deep-link re-send.
  const readMoreHref = opts.fullDescription
    ? null
    : miniEventLink || (await readMoreHrefFor(ctx.telegram, event.id));
  const descLine = formatDescriptionForCard(event.description, {
    fullDescription: Boolean(opts.fullDescription),
    readMoreHref,
    escapeHtml,
  });
  if (descLine) lines.push(`📝 ${descLine}`);

  // Teaser caption: just the essentials (title / date / time / audience /
  // location / tickets / series-count / proximity / short description).
  // Topical tags, the match-reason line, low-confidence verdicts and the
  // profile-fit line were dropped — the full context is one tap away in
  // the Web App. `navOpts` is still needed by the no-Mini-App fallback.
  const navOpts = navOptsFromProfile(profile, event);

  // ── Buttons ──────────────────────────────────────────────────────────
  const rows = [];

  // Quick bot-native actions shared by both layouts: watch-when-available
  // (sold-out events) and "אל תראה לי יותר". Built once, appended last so
  // they sit on a single compact row beneath the primary CTA.
  const quickRow = [];
  if (soldOut) {
    const watching = await isWatching(ctx.from.id, event.id).catch(() => false);
    const watchCb = event._ticketsNeeded
      ? `wt:${event.id}:${event._ticketsNeeded}`
      : `wt:${event.id}`;
    quickRow.push(
      watching
        ? Markup.button.callback("🔕 בטל מעקב", `unw:${event.id}`)
        : Markup.button.callback("🔔 עדכן אם מתפנה", watchCb),
    );
  }
  if (!opts.hideNotRelevant) {
    // "אל תראה לי יותר" → reason picker (fb:reasons:<id>). Suppressed when
    // `hideNotRelevant` is set (e.g. a «כללי» result already outside the
    // profile — opting out is meaningless there).
    quickRow.push(
      Markup.button.callback("🚫 אל תראה לי יותר", `fb:reasons:${event.id}`),
    );
  }

  if (miniEventLink || miniEventWebUrl) {
    // TEASER (Mini App configured): ONE primary CTA → the full event page
    // in the Web App. Booking link, navigation, every occurrence/series and
    // the online-join link all live there, so the card itself stays clean.
    rows.push([
      miniEventLink
        ? Markup.button.url("📖 לפרטים והרשמה", miniEventLink)
        : Markup.button.webApp("📖 לפרטים והרשמה", miniEventWebUrl),
    ]);
    if (quickRow.length) rows.push(quickRow);
  } else {
    // FALLBACK (no Mini App URL — the bot is the only UI). "🧭 ניווט" +
    // "🔗 פרטים" share a row; Hebrew RTL puts the primary ("פרטים") on the
    // right by placing it SECOND in the array.
    const detailsBtn = buildDetailsButton(event);
    const navBtns = buildNavButtons(event, navOpts);
    const topRow = [...navBtns, detailsBtn].filter(Boolean);
    if (topRow.length) rows.push(topRow);

    if (readMoreHref && event.description) {
      rows.push([Markup.button.url("📖 קרא עוד", readMoreHref)]);
    }
    if (event.online_url) {
      rows.push([Markup.button.url("📹 הצטרף למפגש", event.online_url)]);
    }

  // Series / umbrella button — TWO possible behaviours, mutually
  // exclusive (the user picked one button max for visual restraint):
  //
  //   1. UMBRELLA child (sql/054 set umbrella_slug on the row): the
  //      button shows ALL siblings of the umbrella — different
  //      titles, venues, times. Example: a Shavuot child card shows
  //      "📋 כל אירועי שבועות ברמת גן". This matches the user's
  //      mental model — "show me everything happening as part of
  //      this Shavuot programme", not "show me other dates of this
  //      specific puppet show". The seq grouping (same name, age
  //      range) is genuinely the WRONG view for umbrella children
  //      whose name is unique per occurrence.
  //
  //   2. Recurring SERIES (no umbrella, but ≥2 same-name occurrences):
  //      the classic "📋 כל המופעים (N)" button. Useful for things
  //      like "משחקיית רגעים לידה עד שנה" that runs 8× this week.
  //
  // Why not both: cards already carry 3-4 buttons; a fifth would
  // overflow on narrow screens. The umbrella relationship is more
  // informative when present (it explains "this is part of a larger
  // programme"), so it wins. For umbrella children that ALSO happen
  // to have multiple same-name occurrences (rare in practice), the
  // seq button is silently dropped — users who want that view can
  // still tap the parent umbrella and find the duplicate dates
  // surfaced per child anyway.
  if (event.umbrella_slug) {
    const rawTitle = event.umbrella_title || "האירועים מתחת לכותרת המלאה";
    // Telegram inline buttons render comfortably up to ~30 chars
    // before they wrap on small phones; truncate longer titles with
    // a Hebrew-friendly ellipsis ("…"). 22 chars body + the 10-char
    // "📋 כל אירועי " prefix = 32, within budget for typical screens.
    const truncated =
      rawTitle.length > 22 ? rawTitle.slice(0, 21) + "…" : rawTitle;
    let umbTotal = Number.isFinite(opts.seriesOccurrenceCount)
      ? opts.seriesOccurrenceCount
      : 0;
    if (umbTotal < 2) {
      const { data: umbRows } = await fetchUmbrellaSiblingRows(event.umbrella_slug);
      umbTotal = umbRows?.length || umbTotal || 1;
    }
    const umbCountLabel =
      umbTotal > SERIES_CARD_COUNT_CAP
        ? `${SERIES_CARD_COUNT_CAP}+`
        : String(Math.max(umbTotal, 1));
    const meCount = await resolveUmbrellaProfileMatchCountForCard(
      ctx,
      event.umbrella_slug,
    );
    const meCountLabel = formatSeriesListCountLabel(meCount);
    rows.push([
      Markup.button.callback(
        `📋 כל אירועי ${truncated} (${umbCountLabel})`,
        `umb:${event.umbrella_slug}`,
      ),
    ]);
    // "בשבילי" stays VISIBLE even when 0 match the profile — but a
    // tap can't open an empty list, so we route it to a no-op that
    // just explains why (effectively a disabled button; Telegram has
    // no native disabled state for inline buttons).
    rows.push([
      Markup.button.callback(
        `✨ בשבילי מהסדרה (${meCountLabel})`,
        meCount > 0 ? `umb:me:${event.umbrella_slug}` : "noop:nomine",
      ),
    ]);
  } else if (additionalOccurrences > 0) {
    const btnCount =
      seriesCount > SERIES_CARD_COUNT_CAP ? `${SERIES_CARD_COUNT_CAP}+` : String(seriesCount);
    rows.push([
      Markup.button.callback(`📋 כל המופעים (${btnCount})`, `seq:${event.id}`),
    ]);
    const meCount = await resolveSeriesProfileMatchCountForCard(ctx, event.id);
    const meSuffix = ` (${formatSeriesListCountLabel(meCount)})`;
    // Visible-but-disabled when nothing in the series fits the profile.
    rows.push([
      Markup.button.callback(
        `✨ מופעים בשבילי${meSuffix}`,
        meCount > 0 ? `seq:me:${event.id}` : "noop:nomine",
      ),
    ]);
  }

    if (quickRow.length) rows.push(quickRow);
  }

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
  const replyToId = opts.replyToMessageId || null;
  const msgOpts = withReplyToMessageId({ parse_mode: "HTML" }, replyToId);
  const photoOpts = { caption: text, ...msgOpts, ...keyboard };
  if (photoUrl && text.length <= 1024) {
    try {
      await ctx.replyWithPhoto(photoUrl, photoOpts);
      return;
    } catch (err) {
      // "wrong type of the web page content" means Telegram's servers
      // couldn't download the image — common for geo-restricted CDNs
      // (e.g. cms-media.ramat-gan.muni.il only serves images to IL IPs).
      // Download the image on our server and re-upload as a Buffer so
      // Telegram never needs to reach the CDN directly.
      if (/wrong type|wrong_type/i.test(err.message)) {
        try {
          const imgRes = await fetch(photoUrl, { signal: AbortSignal.timeout(8000) });
          if (imgRes.ok && (imgRes.headers.get("content-type") || "").startsWith("image/")) {
            const buf = Buffer.from(await imgRes.arrayBuffer());
            await ctx.replyWithPhoto({ source: buf, filename: "event.jpg" }, photoOpts);
            return;
          }
        } catch (proxyErr) {
          console.warn(`[Bot] sendEventCard proxy-upload failed for event ${event.id}: ${proxyErr.message}`);
        }
      }
      // Any other rejection (404, GIF placeholder, etc.) — fall through to text.
      console.warn(`[Bot] sendEventCard photo fallback for event ${event.id}: ${err.message}`);
    }
  }
  await ctx.reply(text, { ...msgOpts, ...keyboard });
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
  // Single "🧭 ניווט" button per May-2026 spec — see sendEventCard
  // for the rationale on collapsing Waze + Maps into one entry.
  const profile = await getCachedUserProfile(ctx);
  const navOpts = navOptsFromProfile(profile, ticket);
  for (const btn of buildNavButtons(ticket, navOpts)) row.push(btn);

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
    const audienceLine = formatAdultAgeGate(event);
    if (audienceLine) lines.push(audienceLine);
    if (event.location) lines.push(`📍 ${event.location}`);
    // Same NULL-aware rule as the search card above: free/unmetered
    // events (city source, sql/039 → tickets_left = NULL) omit the
    // line entirely instead of printing "אזלו" or a literal "null".
    // Watchlist uses the shared helper so the low-stock urgency
    // signal stays consistent ("🎫 N כרטיסים אחרונים ❗️").
    const watchTicketsLine = formatTicketsLine(event.tickets_left);
    if (watchTicketsLine) lines.push(watchTicketsLine);
    if (event.tickets_needed != null) lines.push(`📋 מחפשת ${event.tickets_needed} כרטיסים`);

    // RTL anchoring on every line — see sendEventCard for the rationale.
    const text = lines.map(rtlLine).join("\n");
    const rows = [];
    const detailsBtn = buildDetailsButton(event);
    // Top row: nav + details. Same single-button layout as
    // sendEventCard so the bot's UI stays consistent across surfaces.
    const profile = await getCachedUserProfile(ctx);
    const navOpts = navOptsFromProfile(profile, event);
    const navBtns = buildNavButtons(event, navOpts);
    const topRow = [...navBtns, detailsBtn].filter(Boolean);
    if (topRow.length) rows.push(topRow);
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
      // Used by `present_interest_picker`. Topics-only chip picker for
      // self; partner uses the same picker with a different header.
      // Communities / location are separate profile flows.
      renderInterestPicker: async ({ target = "self" } = {}) => {
        mark();
        if (target === "self") {
          return openInterestsPicker(ctx, { target: "self" });
        }
        let partnerName = null;
        try {
          const profile = await getProfile(ctx.from.id);
          partnerName = profile?.user_context?.partner?.name || null;
        } catch {
          // Defensive: if the profile fetch fails we still let the
          // picker open with a generic header. The save handler will
          // refuse to commit without a partner name in profile.
        }
        return openInterestsPicker(ctx, { target: "partner", partnerName });
      },
      describeSnapshot: describeSnapshotDetailed,
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Gender-aware phrasing helper
// ──────────────────────────────────────────────────────────────────────────
//
// Hardcoded Hebrew UI strings (welcome, onboarding headers, etc.) need to
// match the user's chosen gender form. `profile.user_context.gender` is
// the source of truth — set early in /start via the gender-pick prompt,
// editable later via /profile. Until it's set we fall back to NEUTRAL
// phrasing ("אפשר לבחור") rather than guessing — guessing-wrong on a
// stranger's first impression is exactly the bug this helper exists to
// prevent.
//
// `f` = feminine, `m` = masculine, `n` = neutral fallback. Accepts the
// full profile object, a bare gender string, or null — so call sites
// can pass whichever shape is in hand without an extra hop.
const {
  genderForm,
  searchGoLabel,
  searchMarkVerb,
  tryAgainVerb,
  pickActionVerb,
} = require("../lib/genderForm");

// Card flags that reproduce the original search-result card's profile
// treatment on a RE-render (קרא עוד / deep-link card). In a «חיפוש כללי»,
// an event marked out-of-profile hides "אל תראה לי יותר" and skips the
// "מתאים" badge; a fitting one shows both. Reuses the verdict stored at
// first render so re-renders stay consistent. Returns {} outside general
// search (normal cards unchanged).
function generalSearchCardFlags(telegramId, eventId) {
  if (!sessionStore.getLastSearchFilters(telegramId)?.ignore_profile) return {};
  const outOfProfile = sessionStore.isOutOfProfileEvent(telegramId, eventId);
  return { hideNotRelevant: outOfProfile, profileFit: !outOfProfile };
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

  const readMoreEventId = parseReadMoreStartPayload(payload);
  if (readMoreEventId != null) {
    try {
      let event =
        sessionStore.getLastSearchHits(ctx.from.id).find((e) => e.id === readMoreEventId) ||
        null;
      if (!event) event = await getEventById(readMoreEventId);
      if (event) {
        await sendEventCard(ctx, event, {
          fullDescription: true,
          ...generalSearchCardFlags(ctx.from.id, readMoreEventId),
        });
        return;
      }
    } catch (err) {
      console.error("[Bot] evmore start error:", err.message);
    }
  }

  const cardEventId = parseEventCardStartPayload(payload);
  if (cardEventId != null) {
    try {
      let event =
        sessionStore.getLastSearchHits(ctx.from.id).find((e) => e.id === cardEventId) ||
        null;
      if (!event) event = await getEventById(cardEventId);
      if (event) {
        const seriesOpts = await cardSendOptsForEvent(ctx.from.id, event);
        await sendEventCard(ctx, event, {
          ...seriesOpts,
          ...generalSearchCardFlags(ctx.from.id, cardEventId),
        });
        return;
      }
    } catch (err) {
      console.error("[Bot] ev start error:", err.message);
    }
  }

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
    // Returning user. Show the same welcome/explainer as עזרה (the only
    // place this longer message appears now — NOT on תפריט ראשי), then the
    // (clean) menu. Keeps the keyboard fresh too.
    await ctx.reply("שיחה חדשה התחילה 🔄", catalogReplyKeyboardMarkup());
    await sendWelcome(ctx);
    await showMainMenu(ctx);
    return;
  }

  // First-timer. Ask which Hebrew gender form to use BEFORE the long
  // welcome. The welcome + first-touch onboarding picker are hardcoded
  // with verb forms ("בחרי" / "תוכלי" / "כתבי") and we don't want a
  // stranger's first impression to be feminine-by-default. Once the
  // user picks (or skips by typing free text), the `gnd:*` handler
  // below chains into sendWelcome + openOnboarding with the right
  // form. Returning users skip this entirely — they already have a
  // profile and gender resolution is whatever they picked before.
  await ctx.reply(
    "👋 שלום! לפני שמתחילים — איך הכי נוח לפנות אליך?",
    {
      reply_markup: {
        inline_keyboard: [[
          { text: "👩 בלשון נקבה", callback_data: "gnd:female" },
          { text: "👨 בלשון זכר", callback_data: "gnd:male" },
          { text: "🧑 ניטרלי", callback_data: "gnd:neutral" },
        ]],
      },
    },
  );
  // Do NOT call sendWelcome / openOnboarding here — they fire from
  // the gnd:* handler after the user picks. If the user ignores the
  // prompt and types free text, the agent handles it; the unanswered
  // gender keyboard sits harmlessly above and they can still tap it
  // later (it's just a regular inline keyboard).
});

const {
  getMiniAppCatalogUrl,
  getMiniAppProfileUrl,
  getMiniAppEventUrl,
  catalogLaunchInlineKeyboard,
} = require("../lib/miniAppUrl");

/** Persistent reply keyboard — quick actions + optional Mini App catalog. */
function catalogReplyKeyboardMarkup() {
  // Single persistent button. Tapping it sends the text "📋 תפריט ראשי",
  // which routes to the full inline button menu (sent fresh, so its
  // web_app buttons reliably carry initData).
  return {
    reply_markup: {
      keyboard: [[{ text: "📋 תפריט ראשי" }]],
      resize_keyboard: true,
      is_persistent: true,
    },
  };
}

// /catalog — opens the personalized Mini App event catalog.
// Works as a fallback entry point for users who dismissed the menu button
// or are browsing from desktop Telegram where the menu button isn't prominent.
bot.command("catalog", async (ctx) => {
  const url = getMiniAppCatalogUrl();
  if (!url) {
    await ctx.reply("הקטלוג עדיין לא מוגדר. פנה למפעיל הבוט.");
    return;
  }
  await ctx.reply("לחצי לפתיחת הקטלוג המותאם אליך 👇", {
    reply_markup: catalogLaunchInlineKeyboard(url),
  });
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
  await showMainMenu(ctx);
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

  // Pull the user's chosen gender form so the direct-address lines
  // below pick the right verb. Defaults to null (→ neutral) when the
  // profile fetch fails or the user hasn't been through the /start
  // gender prompt — better than guessing and getting it wrong.
  const profile = await getProfile(ctx.from.id).catch(() => null);
  const gender = profile?.user_context?.gender || null;
  const youCan = genderForm(gender, {
    f: "תוכלי",
    m: "תוכל",
    n: "אפשר",
  });
  const mark = searchMarkVerb(gender);
  const go = searchGoLabel(gender);

  const lines = [
    `שלום${firstName}! 🎟️ אני הבוט של Event Scout — עוזרת למצוא אירועים, חוגים וכרטיסים ברמת גן.`,
    "",
    "*🎯 למה דרכי:*",
    "🧭 *כל האירועים במקום אחד* — אני מאחדת מקורות שונים, כדי לא לפספס כלום",
    "🎫 *זמינות כרטיסים מראש* — מראה כאן אם נשארו כרטיסים, בלי לגלות באמצע הדרך שהכל אזל",
    "",
    "*✨ מה אפשר לעשות בכפתורים:*",
    `🔍 *חיפוש* — כפתור «חיפוש אירוע» או /search (${mark} מסננים, ואז «${go}»)`,
    "📋 *פרופיל* — ילדים, קהילות, כתובת, תחומי עניין",
    "🔔 *מעקבים שמורים* · 👀 *אירועים במעקב*",
    "⭐ *תחומי עניין* — /interests",
    "",
    "*📋 פקודות:*",
    "/menu — תפריט ראשי",
    "/profile — הפרופיל שלך",
    "/search — חיפוש בכפתורים",
    "/saved · /watching",
    // Underscores in command names must be escaped in Markdown v1, or
    // Telegram parses "_off — להשבית..." as the start of an italic
    // span that never closes → "can't parse entities: ... byte 1437".
    "/newsletter\\_preview — תצוגה מקדימה של הניוזלטר \\(מה היית מקבלת ביום חמישי\\)",
    "/newsletter\\_off — להשבית את הניוזלטר השבועי (/newsletter\\_on להפעיל בחזרה)",
    "/connect\\_calendar — חיבור Google Calendar (להוספת אירועים מהניוזלטר)",
    "/invite — קישור להזמנת חברים",
    "/catalog — קטלוג אירועים מותאם",
    "/help — להציג את התפריט הזה שוב",
    "",
    "📅 *קטלוג* — כפתור «קטלוג אירועים» למטה, או בתפריט ליד שדה ההקלדה",
    "",
    `*נתחיל מתחומי העניין שלך* — אפתח לך כעת את הפיקר. בסיומו ${youCan} לספר לי על המשפחה (גילאי ילדים, בן/בת זוג) כדי שאתאים את האירועים.`,
  ];
  // Persistent reply keyboard for the catalog; onboarding picker follows
  // in a separate message. /help and first-touch /start both route here.
  await ctx.reply(lines.join("\n"), {
    parse_mode: "Markdown",
    ...catalogReplyKeyboardMarkup(),
  });
}

// Button on /start welcome — routes into the multi-step onboarding
// flow (topics → audiences → location). The callback name still says
// "ip:" for backwards-compat with older messages that pre-date the
// onboarding refactor; we don't want to leave dead buttons in user
// chat histories.
bot.action("prof:kids", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await openOnboardingAtStep(ctx, "kids", { editReturn: "profile" });
});

bot.action("ip:start_from_welcome", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  try {
    await openOnboarding(ctx, { triggeredBy: "manual" });
  } catch (err) {
    console.error("[Bot] ip:start_from_welcome error:", err.message);
  }
});

// /start first-touch: gender-form picker.
//
// Persists the user's chosen Hebrew gender form to the profile and
// THEN runs the welcome + first-touch onboarding picker (which we
// deferred until now precisely so they render in the right form).
//
// "neutral" is stored as NULL in profile.user_context.gender —
// VALID_GENDERS in profileService.js only accepts 'female' / 'male',
// and a missing value naturally routes the rendering helpers to the
// neutral fallback. No new ENUM value required.
//
// Best-effort: if the profile save fails (DB hiccup, geocoder
// unrelated path that shouldn't trigger but might), we still proceed
// to the welcome — the worst case is a feminine welcome the user will
// re-correct later via /profile. Better than dead-ending /start.
bot.action(/^gnd:(female|male|neutral)$/, async (ctx) => {
  const choice = ctx.match[1];
  const genderValue = choice === "neutral" ? null : choice;
  await ctx.answerCbQuery().catch(() => {});
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});

  const existingProfile = await getProfile(ctx.from.id).catch(() => null);

  const gndPayload = { gender: genderValue };
  if (!existingProfile) {
    gndPayload.first_name = ctx.from?.first_name || undefined;
  }

  try {
    await saveProfile(ctx.from.id, gndPayload, existingProfile);
  } catch (err) {
    console.error(
      `[Bot] gnd:${choice} persist failed for ${ctx.from?.id}: ${err.message}`,
    );
    // Continue anyway — fall through to the age prompt.
  }

  const menuSession = sessionStore.getSession(ctx.from.id);
  if (menuSession?.menuReturnTo === "profile:edit") {
    delete menuSession.menuReturnTo;
    await ctx.reply("✅ עודכן המגדר");
    await showProfileEditMenu(ctx);
    return;
  }

  // Chain into the age-range prompt — the second pre-welcome
  // question (May-2026). Audience defaults branch on TWO independent
  // dimensions (`kids[]` + `age_range`), and we want both signals
  // captured before the welcome+onboarding flow asks about kids /
  // partner / interests. Buttons:
  //   18-35 → young_adult     (sees young-adult-tagged events)
  //   35-60 → mid_adult       (broad mid-adults, no subtype bias)
  //   60+   → senior          (sees senior-tagged events, hides young)
  //   skip  → leave NULL      (legacy "no signal" fallback)
  await ctx.reply(
    "מצוין. ועוד שאלה קצרה — באיזה טווח גיל?",
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🧒 18-35", callback_data: "age:young_adult" },
            { text: "🧑 35-60", callback_data: "age:mid_adult" },
            { text: "👴 60+", callback_data: "age:senior" },
          ],
          [
            { text: "⏭️ דלגי / מעדיף לא לציין", callback_data: "age:skip" },
          ],
        ],
      },
    },
  );
});

// Second pre-welcome step (May-2026). The `age_range` field powers
// `deriveDefaultAudienceSet` together with `kids[]`. Like the gender
// step above, this runs once on first /start; later changes are made
// via the profile editor (or, for now, by re-running /start after
// clearing the profile).
//
// "skip" stores NULL — legitimately neutral, not a special sentinel.
// The audience derivation treats unset age_range as "fall back to
// kids-only logic" (current behaviour pre-May-2026). Users who skip
// retain the legacy default.
bot.action(/^age:(young_adult|mid_adult|senior|skip)$/, async (ctx) => {
  const choice = ctx.match[1];
  const ageRangeValue = choice === "skip" ? null : choice;
  await ctx.answerCbQuery().catch(() => {});
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});

  const existingProfile = await getProfile(ctx.from.id).catch(() => null);
  const agePayload = { age_range: ageRangeValue };
  if (!existingProfile) {
    agePayload.first_name = ctx.from?.first_name || undefined;
  }

  try {
    await saveProfile(ctx.from.id, agePayload, existingProfile);
  } catch (err) {
    console.error(
      `[Bot] age:${choice} persist failed for ${ctx.from?.id}: ${err.message}`,
    );
    // Continue anyway — fall through to the welcome.
  }

  const menuSession = sessionStore.getSession(ctx.from.id);
  if (menuSession?.menuReturnTo === "profile:edit") {
    delete menuSession.menuReturnTo;
    await ctx.reply("✅ עודכן טווח הגיל");
    await showProfileEditMenu(ctx);
    return;
  }

  try {
    await sendWelcome(ctx);
  } catch (err) {
    console.error("[Bot] age: sendWelcome failed:", err.message);
  }

  // First-touch onboarding — auto-open the multi-step picker right
  // after the welcome so the user lands in a guided flow instead of
  // having to discover the "⭐ ערכי תחומי עניין" button. Triggered
  // by "auto" so the summary card opens with the celebratory
  // "✅ הכל מוכן!" header instead of the edit-mode header. A short
  // delay lets Telegram render the welcome card before the picker
  // arrives — otherwise both messages stack in the same screen tick
  // and the user can miss the welcome's content entirely.
  setTimeout(() => {
    openOnboarding(ctx, { triggeredBy: "auto" }).catch((err) =>
      console.error("[Bot] age: auto-onboarding failed:", err.message),
    );
  }, 1200);
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

// (/saved command removed — saved searches live in the Web App.)

bot.command("menu", async (ctx) => {
  await showMainMenu(ctx);
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

async function showProfileView(ctx) {
  // Profile now lives in the Mini App. If configured, point the user there
  // with a one-tap web_app button instead of the old text dump.
  const profileUrl = getMiniAppProfileUrl();
  if (profileUrl) {
    // Simple message + a web_app button (same pattern as the catalog). The
    // button sits on a FRESH message, so Telegram reliably attaches initData
    // when tapped — unlike a web_app button baked into a stale menu message.
    await ctx.reply("👤 הפרופיל שלך — לחצו לפתיחה ועריכה:", {
      reply_markup: {
        inline_keyboard: [[{ text: "📋 פתחו את הפרופיל", web_app: { url: profileUrl } }]],
      },
    });
    return;
  }
  const profile = await getProfile(ctx.from.id).catch(() => null);
  let watched = [];
  try {
    watched = await getWatchedEvents(ctx.from.id);
  } catch {
    /* ok */
  }
  const lines = [...formatProfileLines(profile)];
  if (profile?.user_context) {
    const learned = await buildLearnedPreferencesLines(profile.user_context);
    if (learned.length) {
      lines.push("");
      lines.push("*מה שלא להציג (לפי המשוב שלך):*");
      lines.push(...learned);
    }
    lines.push(...(await formatFavoriteLocationsLines(profile.user_context)));
  }
  if (watched.length) {
    lines.push("");
    lines.push(`🔔 אירועים במעקב (${watched.length}):`);
  }
  await ctx.reply(lines.join("\n"), {
    parse_mode: "Markdown",
    ...buildProfileViewKeyboard(),
  });
  const setupKb = buildProfileViewKeyboardExtra(profile);
  if (setupKb) {
    await ctx.reply("💡 כדי להתאים טוב יותר — אפשר להשלים:", setupKb);
  }
  if (watched.length) await sendWatchListCards(ctx, watched);
}

async function showProfileEditMenu(ctx) {
  const profile = await getProfile(ctx.from.id).catch(() => null);
  await ctx.reply("✏️ *מה לערוך?*", {
    parse_mode: "Markdown",
    ...buildProfileEditKeyboard(profile),
  });
}

async function showTypingActionsMenu(ctx, { draftText = null } = {}) {
  await showMainMenu(ctx, { draftText });
}

async function openOnboardingAtStep(ctx, step, { editReturn = null } = {}) {
  const telegramId = ctx.from.id;
  sessionStore.clearInterestsPicker(telegramId);
  const state = await loadOnboardingInitialState(telegramId, "manual");
  state.step = step;
  if (editReturn) state.editReturn = editReturn;
  if (step === "communities") {
    const profile = await getProfile(telegramId).catch(() => null);
    const comm = profile?.user_context?.communities || {};
    const { memberKeysForCommunityPicker } = require("../lib/communityAccess");
    state.communityMember = new Set(memberKeysForCommunityPicker(comm));
  }
  if (step === "kids" && editReturn === "profile" && (state.kids || []).length > 0) {
    state.step = "kids_manage";
  }
  sessionStore.setOnboarding(telegramId, state);
  await renderOnboardingStep(ctx, state);
}

async function dispatchMenuAction(ctx, action) {
  const telegramId = ctx.from.id;
  const session = sessionStore.ensureSession(telegramId);
  const draft = session.typingMenuDraft || null;

  switch (action) {
    case "main":
      // Bottom-keyboard "📋 תפריט ראשי" → full inline button menu (fresh).
      await showFullMenu(ctx, { draftText: draft });
      return;
    case "search": {
      await showSearchHub(ctx, { draftText: draft });
      if (draft) {
        const { routeMessage } = require("../lib/searchRouter");
        const lastFilters = sessionStore.getLastSearchFilters(telegramId);
        const hasExtensionHint = !!sessionStore.getLastExtensionHint(telegramId);
        const routed = routeMessage(draft, { lastFilters, hasExtensionHint });
        if (routed.kind === "search" || routed.kind === "refine" || routed.kind === "extend") {
          await withLiveness(ctx, async ({ markResponded }) => {
            const agentCtx = buildAgentCtx(ctx, { markResponded });
            await runRouterTextTurn(telegramId, agentCtx, ctx, draft);
          });
        }
      }
      return;
    }
    case "profile":
      await showProfileView(ctx);
      return;
    case "saved": {
      const items = await listSavedSearches(telegramId);
      if (!items.length) {
        const profile = await getProfile(telegramId).catch(() => null);
        const go = searchGoLabel(profile?.user_context?.gender);
        await ctx.reply(
          `עדיין לא שמרת חיפושים.\n${go} קודם (🔍 חיפוש אירוע), ואז «שמור מעקב» בתוצאות.`,
        );
        return;
      }
      await ctx.reply(`📂 ${items.length} חיפושים שמורים:`);
      for (const item of items.slice(0, 8)) {
        const summary = describeSnapshot({
          query: item.query,
          tokens: item.tokens,
          tickets_needed: item.tickets_needed,
          filters: item.filters || {},
        });
        const modeLabel = item.mode === "one_time" ? "🎯 פעם אחת" : "♾️ קבוע";
        const lines = [`🔍 ${item.query} — ${modeLabel}`];
        if (summary) lines.push(rtlLine(`📋 ${summary}`));
        await ctx.reply(lines.join("\n"));
      }
      if (items.length > 8) {
        await ctx.reply(`… ועוד ${items.length - 8}. לרשימה מלאה: /saved`);
      }
      return;
    }
    case "watching": {
      const watched = await getWatchedEvents(telegramId);
      if (!watched.length) {
        await ctx.reply("אין אירועים במעקב כרגע.");
        return;
      }
      await ctx.reply(`👀 ${watched.length} אירועים במעקב:`);
      await sendWatchListCards(ctx, watched);
      return;
    }
    case "interests":
      await openInterestsPicker(ctx, { target: "self" });
      return;
    case "catalog": {
      const url = getMiniAppCatalogUrl();
      if (!url) {
        await ctx.reply("הקטלוג עדיין לא מוגדר.");
        return;
      }
      await ctx.reply("לחצי לפתיחת הקטלוג 👇", {
        reply_markup: catalogLaunchInlineKeyboard(url),
      });
      return;
    }
    case "help":
      await sendWelcome(ctx);
      return;
    case "agent": {
      if (!isAgentEnabled()) {
        await ctx.reply("הסוכן כבוי — השתמשי בחיפוש מהתפריט או ב-/search.");
        return;
      }
      const text = draft || "";
      if (!text) {
        await ctx.reply("כתבי הודעה קודם, ואז בחרי «שלחי לבוט».");
        return;
      }
      delete session.typingMenuDraft;
      sessionStore.appendUserMessage(telegramId, text);
      await withLiveness(ctx, async ({ markResponded }) => {
        const traceId = await tracing.startTrace({
          telegramId,
          inputText: text,
          kind: "text",
        }).catch(() => null);
        try {
          await runAgent(telegramId, buildAgentCtx(ctx, { traceId, markResponded }));
        } finally {
          if (traceId) tracing.finishTrace(traceId).catch(() => {});
        }
      });
      return;
    }
    case "close":
      delete session.typingMenuDraft;
      await ctx.reply("👍 סגרתי את התפריט. אפשר לכתוב שוב מתי שרוצים.");
      return;
    default:
      await ctx.reply("לא מוכר — נסי שוב מהתפריט.");
  }
}

bot.command("profile", async (ctx) => {
  try {
    await showProfileView(ctx);
  } catch (err) {
    console.error("[Bot] /profile error:", err.message);
    await ctx.reply("⚠️ שגיאה.");
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Typing menu (`menu:*`) — shown when the user sends free text
// ──────────────────────────────────────────────────────────────────────────
bot.action(`${MENU}:main`, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const session = sessionStore.getSession(ctx.from.id);
  // Send the FULL button menu as a fresh message (web_app buttons get initData).
  await showFullMenu(ctx, { draftText: session?.typingMenuDraft });
});

bot.action(`${MENU}:close`, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await dispatchMenuAction(ctx, "close");
});

bot.action(`${MENU}:search`, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await dispatchMenuAction(ctx, "search");
});

bot.action(`${MENU}:profile`, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await dispatchMenuAction(ctx, "profile");
});

bot.action(`${MENU}:saved`, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await dispatchMenuAction(ctx, "saved");
});

bot.action(`${MENU}:watching`, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await dispatchMenuAction(ctx, "watching");
});

bot.action(`${MENU}:interests`, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await dispatchMenuAction(ctx, "interests");
});

bot.action(`${MENU}:catalog`, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await dispatchMenuAction(ctx, "catalog");
});

bot.action(`${MENU}:help`, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await dispatchMenuAction(ctx, "help");
});

bot.action(`${MENU}:agent`, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await dispatchMenuAction(ctx, "agent");
});

bot.action(`${MENU}:profile:edit`, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await showProfileEditMenu(ctx);
});

bot.action(`${MENU}:edit:kids`, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await openOnboardingAtStep(ctx, "kids", { editReturn: "profile" });
});

bot.action(`${MENU}:edit:interests`, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await openInterestsPicker(ctx, { target: "self" });
});

bot.action(`${MENU}:edit:communities`, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await openOnboardingAtStep(ctx, "communities", { editReturn: "profile" });
});

bot.action(`${MENU}:edit:location`, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await openOnboardingAtStep(ctx, "location", { editReturn: "profile" });
});

bot.action(`${MENU}:edit:favorites`, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await openFavoriteLocationsPicker(ctx, sessionStore, { returnTo: "profile:edit" });
});

bot.action(/^floc:tog:(\d+)$/, async (ctx) => {
  const idx = parseInt(ctx.match[1], 10);
  try {
    await ctx.answerCbQuery().catch(() => {});
    const state = sessionStore.getFavoriteLocationsPicker(ctx.from.id);
    if (!state) {
      await ctx.answerCbQuery("הבחירה פגה — פתחי שוב מפרופיל", { show_alert: true }).catch(() => {});
      return;
    }
    const loc = state.loaded.find((l) => l.index === idx);
    if (!loc) return;
    const selectedKeys = new Set(state.selectedKeys);
    if (selectedKeys.has(loc.key)) selectedKeys.delete(loc.key);
    else selectedKeys.add(loc.key);
    sessionStore.updateFavoriteLocationsPicker(ctx.from.id, { selectedKeys });
    await editFavoriteLocationsPicker(ctx, sessionStore);
  } catch (err) {
    console.error("[Bot] floc:tog error:", err.message);
  }
});

bot.action("floc:more", async (ctx) => {
  try {
    await ctx.answerCbQuery().catch(() => {});
    const telegramId = ctx.from.id;
    let state = sessionStore.getFavoriteLocationsPicker(telegramId);
    if (!state) return;
    const { appendLocationsPage, MAX_LOADED } = require("../lib/favoriteLocationsPicker");
    if (state.loaded.length >= MAX_LOADED) {
      await ctx.answerCbQuery("הגעת למקסימום — שמרי או נקי הכל", { show_alert: true }).catch(() => {});
      return;
    }
    state = await appendLocationsPage(state);
    sessionStore.updateFavoriteLocationsPicker(telegramId, state);
    await editFavoriteLocationsPicker(ctx, sessionStore);
  } catch (err) {
    console.error("[Bot] floc:more error:", err.message);
  }
});

bot.action("floc:save", async (ctx) => {
  try {
    await ctx.answerCbQuery("נשמר ✓").catch(() => {});
    const keys = await saveFavoriteLocationsPicker(ctx, sessionStore);
    const n = keys.length;
    await ctx.reply(
      n
        ? `📍 נשמרו ${n} מקומות — מעכשיו תקבלי אירועים *רק* מהם (בנוסף לשאר מסנני הפרופיל).`
        : "📍 נוקו המקומות — חזרת לקבל אירועים מכל מקום (לפי מרחק ושאר ההגדרות).",
      { parse_mode: "Markdown" },
    );
    await showProfileView(ctx);
  } catch (err) {
    console.error("[Bot] floc:save error:", err.message);
    await ctx.reply("⚠️ לא הצלחתי לשמור — נסי שוב.").catch(() => {});
  }
});

bot.action("floc:clear", async (ctx) => {
  try {
    await ctx.answerCbQuery().catch(() => {});
    sessionStore.updateFavoriteLocationsPicker(ctx.from.id, { selectedKeys: new Set() });
    await editFavoriteLocationsPicker(ctx, sessionStore);
  } catch (err) {
    console.error("[Bot] floc:clear error:", err.message);
  }
});

bot.action("floc:cancel", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  sessionStore.clearFavoriteLocationsPicker(ctx.from.id);
});

bot.action(`${MENU}:edit:name`, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from.id;
  const profile = await getProfile(telegramId).catch(() => null);
  const current = profile?.first_name || ctx.from.first_name || "—";
  const tgName = String(ctx.from.first_name || "").trim();
  sessionStore.ensureSession(telegramId).pendingProfileField = "display_name";
  await ctx.reply(
    `👤 שם בתצוגה\n\nכרגע: ${current}\n\nכתבי שם חדש (2–40 תווים).`,
    buildDisplayNameEditKeyboard({ telegramName: tgName || null }),
  );
});

bot.action(`${MENU}:edit:name:telegram`, async (ctx) => {
  const telegramId = ctx.from.id;
  await ctx.answerCbQuery("עודכן").catch(() => {});
  const tgName = String(ctx.from.first_name || "").trim();
  if (!tgName) {
    await ctx.reply("אין שם בחשבון הטלגרם שלך — כתבי שם ידנית.");
    return;
  }
  const session = sessionStore.getSession(telegramId);
  if (session) delete session.pendingProfileField;
  try {
    const existing = await getProfile(telegramId);
    await saveProfile(telegramId, { first_name: tgName }, existing);
    await ctx.reply(`✅ השם חזר לשם מטלגרם: ${tgName}`);
    await showProfileView(ctx);
  } catch (err) {
    console.error("[Bot] name telegram reset:", err.message);
    await ctx.reply("⚠️ לא הצלחתי לשמור. נסי שוב.");
  }
});

bot.action(`${MENU}:edit:address`, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  sessionStore.ensureSession(ctx.from.id).pendingProfileField = "home_address";
  await ctx.reply(
    "🏠 *כתובת בית*\n\nכתבי כתובת מלאה (רחוב, עיר), או מחקי את הכתובת השמורה.",
    { parse_mode: "Markdown", ...buildAddressEditKeyboard() },
  );
});

bot.action(`${MENU}:edit:address:clear`, async (ctx) => {
  const telegramId = ctx.from.id;
  await ctx.answerCbQuery("נמחק").catch(() => {});
  const session = sessionStore.getSession(telegramId);
  if (session) delete session.pendingProfileField;
  try {
    const existing = await getProfile(telegramId);
    const shape = profileToBrainShape(existing);
    const constraints = { ...(shape.constraints || {}) };
    delete constraints.home_address;
    delete constraints.home_coordinates;
    await saveProfile(telegramId, { constraints }, existing);
    await ctx.reply("✅ מחקתי את כתובת הבית");
    await showProfileView(ctx);
  } catch (err) {
    console.error("[Bot] address clear:", err.message);
    await ctx.reply("⚠️ לא הצלחתי למחוק. נסי שוב.");
  }
});

bot.action(`${MENU}:edit:gender`, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  sessionStore.ensureSession(ctx.from.id).menuReturnTo = "profile:edit";
  await ctx.reply("⚧ בחרי מגדר לניסוח בעברית:", buildGenderEditKeyboard());
});

bot.action(`${MENU}:edit:age`, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  sessionStore.ensureSession(ctx.from.id).menuReturnTo = "profile:edit";
  await ctx.reply("🎂 בחרי טווח גיל:", buildAgeEditKeyboard());
});

bot.action(`${MENU}:edit:audiences`, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await openOnboardingAtStep(ctx, "audiences", { editReturn: "profile" });
});

bot.action(`${MENU}:edit:suppressed`, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const profile = await getProfile(ctx.from.id).catch(() => null);
  const {
    listSuppressedLabelsForProfile,
  } = require("../lib/tagSuppressPrefs");
  const labels = listSuppressedLabelsForProfile(profile);
  if (!labels.length) {
    await ctx.reply(
      "אין תגיות מושתקות — מה שלא מעוניינת מופיע אחרי «אל תראה לי יותר» על אירוע.",
      buildProfileEditKeyboard(profile),
    );
    return;
  }
  sessionStore.ensureSession(ctx.from.id).pendingSuppressedEdit = { labels };
  const rows = labels.map((name, i) => {
    const short = name.length > 36 ? `${name.slice(0, 34)}…` : name;
    return [Markup.button.callback(`🗑️ ${short}`, `${MENU}:sup:rm:${i}`)];
  });
  rows.push([Markup.button.callback("↩️ חזרה", `${MENU}:profile:edit`)]);
  await ctx.reply(
    "🏷️ *תגיות מושתקות*\n\nלחצי להסיר מהרשימה (האירועים יחזרו להופיע בחיפוש):",
    { parse_mode: "Markdown", ...Markup.inlineKeyboard(rows) },
  );
});

bot.action(new RegExp(`^${MENU}:sup:rm:(\\d+)$`), async (ctx) => {
  const idx = parseInt(ctx.match[1], 10);
  const session = sessionStore.ensureSession(ctx.from.id);
  const labels = session.pendingSuppressedEdit?.labels;
  const name = Array.isArray(labels) ? labels[idx] : null;
  if (!name) {
    await ctx.answerCbQuery("⚠️", { show_alert: true });
    return;
  }
  try {
    const { removeSuppressedLabel } = require("../lib/tagSuppressPrefs");
    await removeSuppressedLabel(ctx.from.id, name);
    const next = labels.filter((_, i) => i !== idx);
    session.pendingSuppressedEdit = next.length ? { labels: next } : null;
    await ctx.answerCbQuery(`הוסר: ${name}`);
    if (!next.length) {
      await ctx.reply("✅ אין עוד תגיות מושתקות.", buildProfileEditKeyboard());
      return;
    }
    const rows = next.map((n, i) => {
      const short = n.length > 36 ? `${n.slice(0, 34)}…` : n;
      return [Markup.button.callback(`🗑️ ${short}`, `${MENU}:sup:rm:${i}`)];
    });
    rows.push([Markup.button.callback("↩️ חזרה", `${MENU}:profile:edit`)]);
    try {
      await ctx.editMessageReplyMarkup({ inline_keyboard: rows });
    } catch {
      await ctx.reply("עודכן. נשארו:", Markup.inlineKeyboard(rows));
    }
  } catch (err) {
    console.error("[Bot] sup:rm:", err.message);
    await ctx.answerCbQuery("⚠️");
  }
});

bot.action(`${MENU}:edit:partner`, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const profile = await getProfile(ctx.from.id).catch(() => null);
  const partnerName = profile?.user_context?.partner?.name || null;
  if (!partnerName) {
    await ctx.reply("אין בן/בת זוג בפרופיל — אפשר להוסיף בשיחה עם הבוט.");
    return;
  }
  await openInterestsPicker(ctx, { target: "partner", partnerName });
});

bot.action(`${MENU}:edit:wizard`, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await openOnboarding(ctx, { triggeredBy: "manual" });
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
  for (let i = 0; i < TOPIC_CATEGORIES.length; i += 2) {
    const row = TOPIC_CATEGORIES.slice(i, i + 2).map((cat) => {
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

function buildInterestsHeader({ target, partnerName, extraLabels, gender }) {
  const pick = genderForm(gender, { f: "בחרי", m: "בחר", n: "אפשר לבחור" });
  const youWant = genderForm(gender, {
    f: "שתרצי",
    m: "שתרצה",
    n: "שמעניינים אותך",
  });
  const lines = [];
  if (target === "partner") {
    lines.push(`⭐ *מה ${partnerName || "בן/בת הזוג"} אוהב/ת?*`);
    lines.push(`${pick} תחומי עניין כדי שאוכל להציע אירועים שמתאימים גם לו/ה.`);
  } else {
    lines.push("⭐ *מה מעניין אותך?*");
    lines.push(`${pick} כמה תחומים ${youWant} — אשתמש בהם כדי להציע לך אירועים רלוונטיים.`);
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
    const chip = getTopicByLabel(raw);
    if (chip) selected.push(chip.label);
    else extraLabels.push(raw.trim());
  }

  const header = buildInterestsHeader({
    target,
    partnerName,
    extraLabels,
    gender: profile?.user_context?.gender || null,
  });
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

// (/interests command removed — interests are edited in the Web App profile.)

// Toggle a single chip. Edits the keyboard in place on the SAME message
// so the user sees the ✓ flip without the chat scrolling. Telegram
// silently no-ops `editMessageReplyMarkup` if the markup is byte-
// identical, so the "no change" case (race where the user tapped twice
// fast) is harmless.
bot.action(/^ip:tog:(.+)$/, async (ctx) => {
  const telegramId = ctx.from.id;
  const chipId = ctx.match[1];
  const state = sessionStore.getInterestsPicker(telegramId);
  const chip = getTopicById(chipId);
  if (!state || !chip) {
    await ctx.answerCbQuery("⏰ פג תוקף — שלחו /interests מחדש");
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
    await ctx.answerCbQuery("⏰ פג תוקף — שלחו /interests מחדש");
    return;
  }
  sessionStore.updateInterestsPicker(telegramId, { freeTextMode: true });
  await ctx.answerCbQuery("✏️");
  await replyAsCallbackResult(
    ctx,
    "כתבו תחומי עניין נוספים, מופרדים בפסיק (לדוגמה: יין, ריצה, ג׳אז). לאחר השליחה אוסיף אותם לרשימה.",
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
  await replyAsCallbackResult(ctx, "👍 לא שיניתי כלום. אפשר לחזור מתי שרוצים עם /interests.");
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

// ──────────────────────────────────────────────────────────────────────────
// Onboarding flow — multi-step picker (topics → audiences → location → ✓)
// ──────────────────────────────────────────────────────────────────────────
//
// Replaces the single-shot `openInterestsPicker` for the SELF target. The
// partner sub-flow (`target: "partner"`) still goes through the legacy
// picker because it's a one-question interaction by design.
//
// State lives on `session.onboarding` (see sessionStore for the shape).
// Each step is rendered into the SAME Telegram message via
// editMessageText, so the chat stays clean as the user walks through.
//
// Callback prefix is `onb:*`:
//   onb:tog:toplabels:<id> multi-select toggle on step 1 (popularity-paginated
//                          tags from the labels dictionary; <id> is numeric)
//   onb:more:toplabels     load the next page of top labels (appended to
//                          the already-shown set so previous selections stay
//                          visible)
//   onb:tog:topics:<id>    multi-select toggle on step 2 (curated TOPIC list)
//   onb:tog:audiences:<id> multi-select toggle on step 3 (curated AUDIENCE list)
//   onb:loc:<id>           single-choice pick on step 4
//                          (advances automatically; "other" routes to
//                           free-text capture before advancing)
//   onb:next               commit current step + advance ("💾 שמרי")
//   onb:back               return to previous step (selections preserved)
//   onb:done               final commit from the summary card
//   onb:cancel             abort the whole flow (saves NOTHING this turn)
//
// Legacy: onb:skip and onb:dismiss_toplabels handlers are kept for
// in-flight messages that still surface those buttons, but neither
// is generated by the current keyboard builders.

const ONBOARDING_STEPS = ["toplabels", "topics", "audiences", "kids", "communities", "location"];
const {
  buildOnboardingKidsBody,
  buildOnboardingKidsKeyboard,
  registerOnboardingKidsHandlers,
  handleOnboardingKidsText,
} = require("../lib/onboardingKidsFlow");

function onboardingProgressLabel(step) {
  const idx = ONBOARDING_STEPS.indexOf(step);
  if (idx < 0) return "";
  return `(${idx + 1}/${ONBOARDING_STEPS.length})`;
}

// Header text for each step. Markdown is fine — the central RTL wrapper
// runs BEFORE Telegram parses the markdown, and `*bold*` survives a
// leading RLM (the parser scans for emphasis markers, ignoring leading
// neutrals/marks).
function buildOnboardingHeader(step, { extraLabels, triggeredBy, gender } = {}) {
  const progress = onboardingProgressLabel(step);
  // Gendered tokens used across the steps — defined once so the per-
  // step lines below stay readable. Neutral fallbacks lean on "אפשר"
  // / passive forms so a stranger never sees a gendered verb until
  // they've explicitly picked one (see /start gender prompt).
  const pick = genderForm(gender, { f: "בחרי", m: "בחר", n: "אפשר לבחור" });
  const mark = genderForm(gender, { f: "סמני", m: "סמן", n: "אפשר לסמן" });
  const write = genderForm(gender, { f: "כתבי", m: "כתוב", n: "אפשר לכתוב" });
  const youWant = genderForm(gender, {
    f: "שתרצי",
    m: "שתרצה",
    n: "שמעניינים אותך",
  });
  const youCan = genderForm(gender, {
    f: "תוכלי",
    m: "תוכל",
    n: "אפשר",
  });
  const youAreReady = genderForm(gender, {
    f: "את מוכנה",
    m: "אתה מוכן",
    n: "מוכנים",
  });
  const youOrFamily = genderForm(gender, {
    f: "שאת או המשפחה שלך משויכות",
    m: "שאתה או המשפחה שלך משויכים",
    n: "שאתם משויכים",
  });
  const lines = [];
  if (step === "toplabels") {
    lines.push(`🏷 *תחומי עניין פופולריים* ${progress}`);
    lines.push("");
    lines.push(`הנה התגיות הכי נפוצות בקטלוג. ${mark} את מה שמעניין אותך — אפשר "להציג עוד" כדי לראות עוד תגיות, וגם אפשר לחזור לפיקר הזה אחר כך מ‑/interests.`);
  } else if (step === "topics") {
    lines.push(`⭐ *מה מעניין אותך?* ${progress}`);
    lines.push("");
    lines.push(`${pick} תחומים ${youWant} להתעדכן בהם — אשתמש בהם כדי להציע אירועים רלוונטיים.`);
  } else if (step === "audiences") {
    lines.push(`👥 *למי האירועים מתאימים?* ${progress}`);
    lines.push("");
    lines.push(`${mark} את הקבוצות ${youOrFamily} אליהן.`);
    lines.push("");
    lines.push("_בשלב הבא: גילאי ילדים וקהילות._");
  } else if (step === "location") {
    lines.push(`📍 *כמה רחוק מהבית ${youAreReady} ללכת?* ${progress}`);
    lines.push("");
    lines.push(`${pick} אחת או יותר (הליכה ו/או נסיעה קצרה). ${youCan} תמיד לשנות אחר כך מ‑/profile.`);
  } else if (step === "location_other") {
    lines.push(`📍 *מרחק מותאם אישית* ${progress}`);
    lines.push("");
    lines.push(`${write} כמה דקות הליכה זה רחוק מדי בשבילך (לדוגמה: 20).`);
  } else if (step === "summary") {
    lines.push(triggeredBy === "auto" ? "✅ *הכל מוכן!*" : "✅ *עודכן בהצלחה!*");
  }
  if (Array.isArray(extraLabels) && extraLabels.length) {
    lines.push("");
    lines.push(`_תחומים נוספים שכבר רשומים: ${extraLabels.join(", ")}_`);
  }
  return lines.join("\n");
}

// Shared nav row at the bottom of each step. Step-specific:
//   - "toplabels" → no back (it's the first); has save.
//   - "topics" / "audiences" → back + save.
//   - "location" → back + save.
// The advance button is labeled "💾 שמרי" on every step — it persists
// whatever is currently selected (even nothing) and moves on. There's
// no separate skip affordance; the user can advance with zero
// selections if they want.
function buildOnboardingNavRow(step) {
  const buttons = [];
  if (prevStepBefore(step)) {
    // Encode the current step in callback_data so a handler that lands
    // here AFTER the in-memory session was evicted can rehydrate to
    // the right step rather than dropping the user at the start of
    // the flow. Old messages with the bare `onb:back` / `onb:next`
    // payload still route through the same handlers (regex match) —
    // they just don't get the precise-step hint.
    buttons.push({ text: "← הקודם", callback_data: `onb:back:${step}` });
  }
  buttons.push({ text: "💾 שמרי", callback_data: `onb:next:${step}` });
  return buttons;
}

function buildChipsKeyboard(categories, selectedSet, togglePrefix) {
  const rows = [];
  for (let i = 0; i < categories.length; i += 2) {
    const row = categories.slice(i, i + 2).map((cat) => {
      const checked = selectedSet.has(cat.label);
      const prefix = checked ? "✅ " : "";
      return {
        text: `${prefix}${cat.emoji} ${cat.label}`,
        callback_data: `${togglePrefix}:${cat.id}`,
      };
    });
    rows.push(row);
  }
  return rows;
}

// Chips for the top-labels step. Render one chip per loaded label,
// ONE PER ROW (full message width) so long Hebrew names + popularity
// counts always fit on mobile without truncation. Labels in
// `topLabelsLoaded` are sorted by events_count DESC (the order we
// fetched them in) — we keep that order so the most-popular tags
// sit at the top of the keyboard. Selected labels keep their
// position so a re-render after toggling doesn't jump the chip
// around under the user's finger.
//
// The "🔁 הצג עוד N/M" button sits on its own row, between the chip
// stack and the standard nav row. Hidden once `hasMore` is false OR
// the loaded-chips count reaches MAX_LOADED_TOP_LABELS — at that
// point the standard "💾 שמרי" in the nav row is the only forward
// affordance.
// Format the visible text of a single chip. Combines selection
// indicator, popularity count, and label name in a single line:
//
//   "✅ (67) קהילה גאה"   ← selected, popular chip
//   "(67) קהילה גאה"      ← unselected
//
// The count is intentionally PLACED BEFORE the name so it remains
// visible when Telegram clips an overflowing chip with "…". The
// name's leading characters survive too (Hebrew labels are
// recognisable from their first few chars), while the tail —
// which would have included a tail-positioned count and dropped
// it — gets the ellipsis.
function formatChipText(label, checked) {
  const rawName = String(label?.name || "");
  const count = Number(label?.events_count || 0);
  const prefix = checked ? "✅ " : "";
  if (count > 0) {
    return `${prefix}(${count}) ${rawName}`;
  }
  return `${prefix}${rawName}`;
}

function buildTopLabelsKeyboard(state) {
  const selected = state.topLabelNames || new Set();
  const loaded = Array.isArray(state.topLabelsLoaded) ? state.topLabelsLoaded : [];
  // Single column so each chip gets the full message width — long
  // Hebrew names plus the popularity counter (e.g. "ר״געים משחקייה
  // התפתחותית (201)") simply don't fit in a 2-col grid on mobile
  // without truncation. The trade-off is more vertical scrolling,
  // but the loaded-rows cap (MAX_LOADED_TOP_LABELS) keeps things
  // tight enough to stay well under Telegram's 100-row keyboard
  // limit even at the maximum.
  const rows = loaded.map((lbl) => [{
    text: formatChipText(lbl, selected.has(lbl.name)),
    callback_data: `onb:tog:toplabels:${lbl.id}`,
  }]);
  // Compute "remaining" relative to the total catalog. When the
  // total is unknown (cache miss / DB hiccup during state hydration)
  // we fall back to the un-counted label so the user still sees a
  // meaningful chip; if there's also no `topLabelsHasMore` signal,
  // the row is hidden entirely.
  const total = Number(state.topLabelsTotal || 0);
  const remaining = total > loaded.length ? total - loaded.length : 0;
  // Hide "show more" once we hit the loaded-rows safety cap — past
  // this point adding more chips can push the keyboard over
  // Telegram's row limit and clip our "💾 שמרי" button. The user
  // can still type missing interests to the agent in chat.
  const atCap = loaded.length >= MAX_LOADED_TOP_LABELS;
  if (state.topLabelsHasMore && !atCap) {
    const batchSize = remaining > 0 && remaining < TOP_LABELS_PAGE_SIZE
      ? remaining
      : TOP_LABELS_PAGE_SIZE;
    const suffix = total > 0 ? `/${remaining}` : "";
    rows.push([{
      text: `🔁 הצג עוד ${batchSize}${suffix}`,
      callback_data: "onb:more:toplabels",
    }]);
  }
  return rows;
}

function buildLocationChipsRows(state) {
  const modes = state.locationModes instanceof Set ? state.locationModes : new Set();
  const customOther = state.location?.id === "other";
  // One chip per row — these labels are longer and look better stacked
  // on narrow phones than crammed into 2 columns.
  return LOCATION_OPTIONS.map((opt) => {
    const selected =
      opt.id === "other"
        ? customOther
        : modes.has(opt.id);
    const callback =
      opt.id === "other" || opt.id === "any"
        ? `onb:loc:${opt.id}`
        : `onb:tog:loc:${opt.id}`;
    return [{
      text: `${selected ? "✅ " : ""}${opt.emoji} ${opt.label}`,
      callback_data: callback,
    }];
  });
}

function buildOnboardingKeyboard(state) {
  const step = state.step;
  const kidsKb = buildOnboardingKidsKeyboard(state);
  if (kidsKb) return kidsKb;

  let rows;
  if (step === "toplabels") {
    rows = buildTopLabelsKeyboard(state);
  } else if (step === "topics") {
    rows = buildChipsKeyboard(TOPIC_CATEGORIES, state.topics, "onb:tog:topics");
  } else if (step === "audiences") {
    rows = buildChipsKeyboard(AUDIENCE_CATEGORIES, state.audiences, "onb:tog:audiences");
  } else if (step === "location") {
    rows = buildLocationChipsRows(state);
    if (state.editReturn === "profile") {
      rows.push([{ text: "🗑️ הסר העדפת מרחק", callback_data: "onb:loc:clear" }]);
    }
  } else if (step === "location_other") {
    // Free-text capture — only a back/cancel option, no chips.
    return {
      inline_keyboard: [
        [{ text: "← הקודם", callback_data: "onb:back" }],
        [{ text: "❌ ביטול", callback_data: "onb:cancel" }],
      ],
    };
  } else if (step === "summary") {
    return {
      inline_keyboard: [
        [{ text: "🎯 התחילי לחפש אירועים", callback_data: "onb:done" }],
        [{ text: "✏️ עריכה מהתחלה", callback_data: "onb:restart" }],
      ],
    };
  }
  rows.push(buildOnboardingNavRow(step));
  return { inline_keyboard: rows };
}

// Build the summary-card text shown on the final step. Mirrors the
// content of describeSnapshotDetailed in tone — bullets, short lines,
// emoji column for visual scanning.
function buildOnboardingSummaryText(state) {
  const lines = [];
  lines.push(buildOnboardingHeader("summary", { triggeredBy: state.triggeredBy, gender: state.gender }));
  lines.push("");
  const topLabelsList = Array.from(state.topLabelNames || []);
  const topicsList = Array.from(state.topics);
  const audiencesList = Array.from(state.audiences);
  if (topLabelsList.length) {
    // Truncate at 8 names so the summary stays scannable when the user
    // toggled an unusually large set; the full list is still in
    // profile.interests and surfaces on /profile.
    const head = topLabelsList.slice(0, 8).join(" • ");
    const more = topLabelsList.length > 8
      ? ` +${topLabelsList.length - 8} נוספים`
      : "";
    lines.push(`🏷 *תגיות:* ${head}${more}`);
  } else {
    lines.push("🏷 *תגיות:* _לא נבחרו_");
  }
  if (topicsList.length) {
    lines.push(`🎭 *תחומים:* ${topicsList.join(" • ")}`);
  } else {
    lines.push("🎭 *תחומים:* _ללא סינון_");
  }
  if (audiencesList.length) {
    lines.push(`👥 *קהלים:* ${audiencesList.join(" • ")}`);
  } else {
    lines.push("👥 *קהלים:* _ללא סינון_");
  }
  if (Array.isArray(state.kids) && state.kids.length) {
    const { formatKidProfileSuffix } = require("../lib/kidAge");
    const kidStr = state.kids
      .map((k) => {
        const st = k.stages?.length ? ` (${k.stages.join("/")})` : "";
        const meta = formatKidProfileSuffix(k) || "";
        return `${k.name}${meta ? ` — ${meta}` : ""}${st}`;
      })
      .join(" • ");
    lines.push(`👧 *ילדים:* ${kidStr}`);
  } else {
    lines.push("👧 *ילדים:* _לא הוזנו_");
  }
  const commKeys = state.communityMember instanceof Set
    ? [...state.communityMember]
    : state.communityMember || [];
  if (commKeys.length) {
    const { COMMUNITY_CHIPS } = require("../lib/kidsWizardUi");
    const labels = commKeys
      .map((k) => COMMUNITY_CHIPS.find((c) => c.key === k)?.label)
      .filter(Boolean);
    if (labels.length) lines.push(`🏳️ *קהילות:* ${labels.join(" • ")}`);
  }
  const { formatProximityPreference } = require("../lib/locationPrefs");
  const locLabel =
    state.location?.id === "other"
      ? state.location.preference
      : formatProximityPreference(state.locationModes);
  if (locLabel) {
    lines.push(`📍 *מיקום:* ${locLabel}`);
  } else {
    lines.push("📍 *מיקום:* _ללא העדפה_");
  }
  if (Array.isArray(state.extraLabels) && state.extraLabels.length) {
    lines.push("");
    lines.push(`_תחומים נוספים מההיסטוריה שלך נשארו: ${state.extraLabels.join(", ")}_`);
  }
  return lines.join("\n");
}

// First-time render uses ctx.reply; subsequent renders editMessageText
// the SAME message so the chat doesn't accumulate step messages. If
// edit fails (e.g., message too old, or content unchanged), fall back
// to a fresh reply so the user always sees an actionable card.
async function renderOnboardingStep(ctx, state) {
  const isKidsStep =
    state.step === "communities" || state.step === "kids" || String(state.step).startsWith("kids_");
  const text = state.step === "summary"
    ? buildOnboardingSummaryText(state)
    : isKidsStep
      ? buildOnboardingKidsBody(state, state.gender)
      : buildOnboardingHeader(state.step, { extraLabels: state.extraLabels, gender: state.gender });
  const keyboard = buildOnboardingKeyboard(state);
  const opts = { parse_mode: "Markdown", reply_markup: keyboard };

  if (state.messageId && state.chatId) {
    try {
      await ctx.telegram.editMessageText(
        state.chatId,
        state.messageId,
        undefined,
        text,
        opts,
      );
      return;
    } catch (err) {
      // editMessageText throws "message is not modified" when text +
      // markup are byte-identical to the previous render — that's a
      // benign no-op (means the user tapped the same toggle twice
      // fast and nothing actually changed); swallow it. Anything else
      // (too old / deleted) falls through to a fresh reply.
      const msg = err?.message || String(err || "");
      if (!msg.includes("message is not modified")) {
        console.warn(`[Bot] onb editMessageText fallback: ${msg}`);
      } else {
        return;
      }
    }
  }
  const sent = await ctx.reply(text, opts);
  sessionStore.updateOnboarding(ctx.from.id, {
    messageId: sent?.message_id || null,
    chatId: sent?.chat?.id || null,
  });
}

// Hydrate the picker state from the user's existing profile so a
// re-open pre-selects everything we've already learned about them.
// Topic / audience labels that match a chip go into the selected sets;
// everything else (free-text learned from chat, "יין", "ג'אז" etc.)
// goes into extraLabels so we don't silently drop them on save.
//
// Communities: the picker is the canonical source of consent. A
// COMMUNITY chip is pre-selected when the corresponding flag is
// 'member' OR when its label appears in interests — covering both
// pre-existing access flags AND legacy interest entries.
async function loadOnboardingInitialState(telegramId, triggeredBy) {
  const profile = await getProfile(telegramId).catch(() => null);
  const existingInterests = Array.isArray(profile?.user_context?.interests)
    ? profile.user_context.interests
    : [];
  const existingCommunities = profile?.user_context?.communities || {};

  // Pre-load the first page of popular labels — the toplabels step is
  // the entry point and needs chips to render immediately. Failure is
  // soft: an empty page makes the step a no-op, the user just hits
  // "המשך" and moves on to the curated topics step.
  //
  // We also fetch the total label count (cached for 60s) so the
  // "🔁 הצג עוד 12/N" button can show the user how many tags are
  // left to surface. Running both in parallel — the count is a HEAD
  // request with no rows transferred, so the extra round-trip is
  // free vs the labels SELECT.
  let topLabelsLoaded = [];
  let topLabelsHasMore = false;
  let topLabelsTotal = 0;
  try {
    const [firstPage, total] = await Promise.all([
      fetchTopLabelsPage(0),
      countAvailableLabels().catch(() => 0),
    ]);
    topLabelsLoaded = firstPage.labels;
    topLabelsHasMore = firstPage.hasMore;
    topLabelsTotal = total;
  } catch (err) {
    console.warn("[Bot] onboarding fetchTopLabelsPage failed:", err.message);
  }

  // Walk existing interests and route each string into one of three
  // buckets:
  //   - curated topic chip   → topics
  //   - curated audience chip → audiences
  //   - everything else      → topLabelNames (the new toplabels step
  //                            absorbs both DB-backed tags AND the
  //                            free-text labels the agent learned from
  //                            chat; they all round-trip through
  //                            interests[] identically on save).
  // A selected top-label name that isn't in `topLabelsLoaded` yet just
  // stays in `topLabelNames` — it won't render as a chip until the
  // user paginates to it via "🔁 הצג עוד", but it survives the save
  // either way because persistOnboardingState reads from the Set.
  const topLabelNames = new Set();
  const topics = new Set();
  const audiences = new Set();
  const extraLabels = [];  // intentionally unused now; kept on state
                            // shape for any downstream consumer that
                            // still references it.
  for (const raw of existingInterests) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const chip = getChipByLabel(trimmed);
    if (chip) {
      if (getTopicById(chip.id)) topics.add(chip.label);
      else if (getAudienceById(chip.id)) audiences.add(chip.label);
      continue;
    }
    topLabelNames.add(trimmed);
  }
  // Backfill audience picks from access flags — a user who set
  // community-lgbtq:'member' via the agent in a previous turn should
  // see "קהילה גאה" already checked when re-opening the picker.
  const { isCommunityMember } = require("../lib/communityAccess");
  for (const aud of AUDIENCE_CATEGORIES.filter((a) => a.community)) {
    if (isCommunityMember(existingCommunities, aud.community)) {
      audiences.add(aud.label);
    }
  }

  const constraints = profile?.user_context?.constraints || {};
  const { locationModesFromConstraints } = require("../lib/locationPrefs");
  let locationModes = locationModesFromConstraints(constraints);
  let location = null;
  const pref = String(constraints.proximity_preference || "").trim();
  if (pref && !locationModes.size) {
    const matched = LOCATION_OPTIONS.find((o) => o.preference === pref);
    if (matched && matched.id !== "other") {
      locationModes = new Set([matched.id]);
    } else if (pref.startsWith("מותאם")) {
      location = {
        id: "other",
        label: pref,
        max_walking_minutes: constraints.max_walking_minutes,
        preference: pref,
      };
    }
  }

  const existingKids = Array.isArray(profile?.user_context?.kids)
    ? profile.user_context.kids
    : [];
  const { memberKeysForCommunityPicker } = require("../lib/communityAccess");
  const communityMember = new Set(memberKeysForCommunityPicker(existingCommunities));

  return {
    step: "toplabels",
    topLabelNames,
    topLabelsLoaded,
    topLabelsHasMore,
    topLabelsTotal,
    topics,
    audiences,
    kids: existingKids,
    kidsDraft: null,
    communityMember,
    locationModes,
    location,
    extraLabels,
    // Captured once at state-load so re-renders don't re-fetch the
    // profile. The picker doesn't outlive a /start gender change in
    // any natural flow (gender is set once, then the picker opens
    // immediately) — and even if it did, the user can re-pick gender
    // from /profile and re-open the picker if they want gendered
    // rendering to refresh.
    gender: profile?.user_context?.gender || null,
    messageId: null,
    chatId: null,
    startedAt: Date.now(),
    triggeredBy: triggeredBy || "manual",
  };
}

// Restore onboarding state from the user's profile when the in-memory
// session was evicted. The picker is mostly stateless — every chip
// can be reconstructed from profile.user_context + a fresh fetch of
// popular labels — so a missing state isn't a real "expired"
// condition, just an opportunity to re-hydrate silently. Two ways
// state goes missing:
//   1. The 30-min sessionStore TTL passed since the user last tapped.
//   2. The bot restarted (deploy / crash) — in-memory Map wipes.
//
// Either way, the user's tap should "just work" rather than show
// "⏰ פג תוקף". Callers pass the step they're confident the user was
// on (e.g. a toplabels-toggle tap → "toplabels"); a missing
// inferredStep falls back to the first step ("toplabels"), which is
// the safest default — the user lands at the top of the flow with
// their previous picks pre-checked.
//
// The picker's message id is captured from `ctx.callbackQuery.message`
// so subsequent re-renders edit the SAME bubble the user just tapped
// on, rather than spawning a new card.
async function ensureOnboardingState(ctx, inferredStep) {
  const telegramId = ctx.from.id;
  let state = sessionStore.getOnboarding(telegramId);
  if (state) return state;
  state = await loadOnboardingInitialState(telegramId, "manual");
  if (inferredStep) state.step = inferredStep;
  const msg = ctx.callbackQuery?.message;
  if (msg) {
    state.messageId = msg.message_id;
    state.chatId = msg.chat?.id;
  }
  sessionStore.setOnboarding(telegramId, state);
  return state;
}

async function openOnboarding(ctx, { triggeredBy = "manual" } = {}) {
  const telegramId = ctx.from.id;
  // Wipe any stale picker state from a previous abandoned open. Same
  // for the legacy single-list picker — we don't want both keyboards
  // racing for the same message id slot.
  sessionStore.clearInterestsPicker(telegramId);
  sessionStore.clearOnboarding(telegramId);

  const state = await loadOnboardingInitialState(telegramId, triggeredBy);
  sessionStore.setOnboarding(telegramId, state);
  await renderOnboardingStep(ctx, state);
}

// Persist the current onboarding state to the profile. Called from
// "next" and "skip" (per-step incremental save, per user's 2א
// decision) and from the location step's auto-advance.
//
// Strategy: rebuild interests from the picker state (topics + audiences
// + preserved extraLabels) and only TOUCH community flags / constraints
// fields that are explicitly represented by the user's current
// selection — NEVER volunteer a 'not-member' just because the user
// skipped. The rule for communities is:
//   - community picker ✅                → `member` only (positive snapshot)
//   - all communities ✅                 → `{}` (default = all)
async function persistOnboardingState(
  telegramId,
  state,
  { touchCommunities, touchCommunitiesOnly, touchKids, touchLocation, touchTopLabels } = {},
) {
  const existingProfile = await getProfile(telegramId);
  const existingShape = existingProfile
    ? profileToBrainShape(existingProfile)
    : { kids: [], partner: null, constraints: null, interests: [] };

  // Interests = union of all picker selections + preserved free-text
  // labels, deduped while preserving order (toplabels first because
  // they're typically the most popular; then curated topics, then
  // audiences, then any extras carried over from old saves).
  const interests = Array.from(
    new Set([
      ...Array.from(state.topLabelNames || []),
      ...Array.from(state.topics || []),
      ...Array.from(state.audiences || []),
      ...(state.extraLabels || []),
    ]),
  );

  let communities;
  if (touchCommunities) {
    const memberKeys = [];
    for (const aud of AUDIENCE_CATEGORIES) {
      if (aud.community && state.audiences.has(aud.label)) {
        memberKeys.push(aud.community);
      }
    }
    const { communitiesFromPickerSelection } = require("../bot/profileService");
    communities = communitiesFromPickerSelection(memberKeys);
  } else if (touchCommunitiesOnly) {
    const { communitiesFromPickerSelection } = require("../bot/profileService");
    const member = state.communityMember instanceof Set
      ? [...state.communityMember]
      : state.communityMember || [];
    communities = communitiesFromPickerSelection(
      member,
      existingShape.communities,
    );
  }

  // Constraints: only touch location-related fields when the location
  // step has been engaged. Always preserve other constraint fields
  // (home_address, home_coords, etc.).
  const constraints = { ...(existingShape.constraints || {}) };
  if (touchLocation) {
    const {
      constraintsFromLocationModes,
      constraintsFromCustomWalkMinutes,
    } = require("../lib/locationPrefs");
    if (state.location?.id === "other") {
      Object.assign(constraints, constraintsFromCustomWalkMinutes(state.location.max_walking_minutes));
    } else if (state.locationModes instanceof Set && state.locationModes.size) {
      Object.assign(constraints, constraintsFromLocationModes(state.locationModes));
    } else {
      constraints.max_walking_minutes = null;
      constraints.proximity_preference = null;
      constraints.location_modes = null;
    }
  }

  const merged = {
    ...existingShape,
    interests,
    constraints,
    ...(touchKids && Array.isArray(state.kids)
      ? { kids: state.kids, suppress_child_audiences: false }
      : {}),
    ...(communities ? { communities } : {}),
  };

  await saveProfile(telegramId, merged, existingProfile);

  // Stamp the seen-toplabels flag once the user has actually engaged
  // with the new step (next OR skip on toplabels). Writing this
  // separately (after saveProfile commits) AND directly on user_context
  // means it survives even if a future code path goes through
  // saveProfile again — the preserve-unknown spread in saveProfile
  // carries it forward. Best-effort: failures don't block the picker.
  if (touchTopLabels) {
    try {
      const supabase = require("../lib/supabase");
      const fresh = await getProfile(telegramId);
      if (fresh) {
        const ctx = fresh.user_context || {};
        if (!ctx.seen_toplabels) {
          await supabase
            .from("profiles")
            .update({ user_context: { ...ctx, seen_toplabels: true } })
            .eq("telegram_id", String(telegramId));
        }
      }
    } catch (err) {
      console.warn("[Bot] mark seen_toplabels failed:", err.message);
    }
  }
}

// Advance to the next step in the linear flow. Final step ("location")
// transitions to "summary"; nothing past summary.
function nextStepAfter(step) {
  if (step === "toplabels") return "topics";
  if (step === "topics") return "audiences";
  if (step === "audiences") return "kids";
  if (step === "kids") return "communities";
  if (step === "communities") return "location";
  if (step === "location" || step === "location_other") return "summary";
  return null;
}

function prevStepBefore(step) {
  if (step === "topics") return "toplabels";
  if (step === "audiences") return "topics";
  if (step === "kids") return "audiences";
  if (step === "communities") return "kids";
  if (step === "location") return "communities";
  if (step === "location_other") return "location";
  if (step === "summary") return "location";
  return null;
}

// onb:open — entry point used by the one-time "✨ כן, בואי נראה"
// button on returning users' /start. Routes through openOnboarding so
// the full multi-step flow (toplabels → topics → audiences → location)
// fires, with the existing profile pre-hydrated.
registerOnboardingKidsHandlers(bot, {
  sessionStore,
  renderOnboardingStep,
  persistOnboardingState,
  getProfile,
  ensureOnboardingState,
  finishProfileEdit: showProfileView,
});

bot.action("onb:open", async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await openOnboarding(ctx, { triggeredBy: "manual" });
  } catch (err) {
    console.error("[Bot] onb:open error:", err.message);
    await ctx.answerCbQuery("⚠️");
  }
});

// onb:dismiss_toplabels — stamps `seen_toplabels = true` on the
// profile so the one-time nudge stops appearing, but DOES NOT open
// the picker. The user can still reach it manually via /interests.
bot.action("onb:dismiss_toplabels", async (ctx) => {
  const telegramId = ctx.from.id;
  try {
    const supabase = require("../lib/supabase");
    const profile = await getProfile(telegramId).catch(() => null);
    const ctxJson = profile?.user_context || {};
    if (!ctxJson.seen_toplabels) {
      await supabase
        .from("profiles")
        .update({ user_context: { ...ctxJson, seen_toplabels: true } })
        .eq("telegram_id", String(telegramId));
    }
    await ctx.answerCbQuery("בסדר, אפשר תמיד דרך /interests");
    // Remove the prompt's buttons so the chat reads cleanly afterward.
    try {
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
    } catch (_) {
      // ignore — message-not-modified / too-old paths are benign here.
    }
  } catch (err) {
    console.error("[Bot] onb:dismiss_toplabels error:", err.message);
    await ctx.answerCbQuery("⚠️");
  }
});

// onb:tog:toplabels:<id> — multi-select toggle on the popularity-paginated
// labels step. Unlike the curated topics/audiences chips this one keys
// off the numeric label id (Hebrew names are 2 bytes/char in
// callback_data and we hit the 64-byte cap fast). We persist the
// Hebrew NAME — not the id — into interests[], so each toggle
// looks up the name from the loaded set and adds/removes it from the
// `topLabelNames` Set.
bot.action(/^onb:tog:toplabels:(\d+)$/, async (ctx) => {
  const telegramId = ctx.from.id;
  try {
    const state = await ensureOnboardingState(ctx, "toplabels");
    const id = parseInt(ctx.match[1], 10);
    const loaded = Array.isArray(state.topLabelsLoaded) ? state.topLabelsLoaded : [];
    let label = loaded.find((l) => l.id === id);
    // If state was just rehydrated, `loaded` only carries the first
    // page of popular labels (12 items). The user may have tapped a
    // chip from a later page — pull that label's name in directly so
    // the toggle lands on the right entry. One round-trip on the cold
    // path; warm sessions skip this entirely.
    if (!label) {
      const labelStore = require("../lib/labelStore");
      const dict = await labelStore.fetchLabelDict([id]);
      const row = dict.get(id);
      if (!row) {
        await ctx.answerCbQuery();
        return;
      }
      label = { id, name: row.name, events_count: 0 };
      const merged = [...loaded, label];
      sessionStore.updateOnboarding(telegramId, { topLabelsLoaded: merged });
      state.topLabelsLoaded = merged;
    }
    if (!(state.topLabelNames instanceof Set)) {
      state.topLabelNames = new Set();
    }
    if (state.topLabelNames.has(label.name)) {
      state.topLabelNames.delete(label.name);
    } else {
      state.topLabelNames.add(label.name);
    }
    sessionStore.updateOnboarding(telegramId, { topLabelNames: state.topLabelNames });
    await ctx.answerCbQuery();
    await renderOnboardingStep(ctx, state);
  } catch (err) {
    console.error("[Bot] onb:tog:toplabels error:", err.message);
    await ctx.answerCbQuery("⚠️");
  }
});

// onb:more:toplabels — fetch and append the next page of popular
// labels to `topLabelsLoaded`. Re-render reuses the SAME message so
// the previously-shown labels and their checked state remain visible
// above the new ones. When `fetchTopLabelsPage` reports no more
// pages, `topLabelsHasMore` flips to false and the "🔁 הצג עוד"
// row vanishes on the next render.
bot.action("onb:more:toplabels", async (ctx) => {
  const telegramId = ctx.from.id;
  try {
    const state = await ensureOnboardingState(ctx, "toplabels");
    const loaded = Array.isArray(state.topLabelsLoaded) ? state.topLabelsLoaded : [];
    // Defensive: we should never get here because the keyboard hides
    // the show-more button at the cap, but a race (rapid double-tap
    // while the previous render hasn't landed) can still fire this
    // handler. Just answer the callback and bail.
    if (loaded.length >= MAX_LOADED_TOP_LABELS) {
      await ctx.answerCbQuery("הגעת לכמות המקסימלית");
      return;
    }
    const offset = loaded.length;
    const { labels, hasMore } = await fetchTopLabelsPage(offset);
    // Dedupe in case of a race — the DB might have just added a new
    // label that bumped one we already loaded onto a different page.
    const known = new Set(loaded.map((l) => l.id));
    const fresh = labels.filter((l) => !known.has(l.id));
    // Refresh the catalog total opportunistically. If a scrape ran
    // since the picker opened, the "/N" suffix on the button should
    // reflect the new total; the service caches this for ~60s so
    // the extra call is cheap.
    const total = await countAvailableLabels().catch(
      () => state.topLabelsTotal || 0,
    );
    sessionStore.updateOnboarding(telegramId, {
      topLabelsLoaded: [...loaded, ...fresh],
      topLabelsHasMore: hasMore,
      topLabelsTotal: total,
    });
    const next = sessionStore.getOnboarding(telegramId);
    await ctx.answerCbQuery(fresh.length ? `+${fresh.length}` : "אין עוד");
    await renderOnboardingStep(ctx, next);
  } catch (err) {
    console.error("[Bot] onb:more:toplabels error:", err.message);
    await ctx.answerCbQuery("⚠️");
  }
});

// onb:tog:<group>:<id> — multi-select toggle on topics OR audiences.
bot.action(/^onb:tog:(topics|audiences):(.+)$/, async (ctx) => {
  const telegramId = ctx.from.id;
  try {
    const [, group, id] = ctx.match;
    const state = await ensureOnboardingState(ctx, group);
    const cat = group === "topics" ? getTopicById(id) : getAudienceById(id);
    if (!cat) {
      await ctx.answerCbQuery();
      return;
    }
    const set = group === "topics" ? state.topics : state.audiences;
    if (set.has(cat.label)) set.delete(cat.label);
    else set.add(cat.label);
    sessionStore.updateOnboarding(telegramId, {
      topics: state.topics,
      audiences: state.audiences,
    });
    await ctx.answerCbQuery();
    await renderOnboardingStep(ctx, state);
  } catch (err) {
    console.error("[Bot] onb:tog error:", err.message);
    await ctx.answerCbQuery("⚠️");
  }
});

bot.action("onb:loc:clear", async (ctx) => {
  const telegramId = ctx.from.id;
  try {
    const state = await ensureOnboardingState(ctx, "location");
    await ctx.answerCbQuery("הוסר");
    state.location = null;
    state.locationModes = new Set();
    sessionStore.updateOnboarding(telegramId, { location: null, locationModes: state.locationModes });
    await persistOnboardingState(telegramId, state, { touchLocation: true });
    if (state.editReturn === "profile") {
      sessionStore.clearOnboarding(telegramId);
      await showProfileView(ctx);
      return;
    }
    sessionStore.updateOnboarding(telegramId, { step: "summary" });
    await renderOnboardingStep(ctx, sessionStore.getOnboarding(telegramId));
  } catch (err) {
    console.error("[Bot] onb:loc:clear error:", err.message);
    await ctx.answerCbQuery("⚠️");
  }
});

// onb:tog:loc:<id> — multi-select walk / drive (mutually exclusive with "any").
bot.action(/^onb:tog:loc:(walk|drive)$/, async (ctx) => {
  const telegramId = ctx.from.id;
  try {
    const state = await ensureOnboardingState(ctx, "location");
    const id = ctx.match[1];
    const opt = getLocationById(id);
    if (!opt) {
      await ctx.answerCbQuery();
      return;
    }
    if (!(state.locationModes instanceof Set)) state.locationModes = new Set();
    state.location = null;
    if (state.locationModes.has(id)) state.locationModes.delete(id);
    else {
      state.locationModes.add(id);
      state.locationModes.delete("any");
    }
    sessionStore.updateOnboarding(telegramId, {
      locationModes: state.locationModes,
      location: null,
    });
    await ctx.answerCbQuery(state.locationModes.has(id) ? `✅ ${opt.label}` : opt.label);
    await renderOnboardingStep(ctx, state);
  } catch (err) {
    console.error("[Bot] onb:tog:loc error:", err.message);
    await ctx.answerCbQuery("⚠️");
  }
});

// onb:loc:<id> — "כל מיקום" (exclusive) or "אחר..." (free-text minutes).
bot.action(/^onb:loc:(any|other)$/, async (ctx) => {
  const telegramId = ctx.from.id;
  try {
    const state = await ensureOnboardingState(ctx, "location");
    const id = ctx.match[1];
    const opt = getLocationById(id);
    if (!opt) {
      await ctx.answerCbQuery();
      return;
    }
    if (id === "other") {
      sessionStore.updateOnboarding(telegramId, { step: "location_other" });
      const refreshed = sessionStore.getOnboarding(telegramId);
      await ctx.answerCbQuery();
      await renderOnboardingStep(ctx, refreshed);
      return;
    }
    if (!(state.locationModes instanceof Set)) state.locationModes = new Set();
    state.location = null;
    if (state.locationModes.has("any")) state.locationModes.clear();
    else {
      state.locationModes.clear();
      state.locationModes.add("any");
    }
    sessionStore.updateOnboarding(telegramId, {
      locationModes: state.locationModes,
      location: null,
    });
    await ctx.answerCbQuery(state.locationModes.has("any") ? `✅ ${opt.label}` : opt.label);
    await renderOnboardingStep(ctx, state);
  } catch (err) {
    console.error("[Bot] onb:loc error:", err.message);
    await ctx.answerCbQuery("⚠️");
  }
});

// onb:next[:step] — advance + persist the current step's selections.
// The optional `:step` suffix carries the user's current step when the
// in-memory state has been evicted; without it we still serve (state
// gets rehydrated to step 1 → advance to step 2), but a precise hint
// keeps the navigation accurate. Old messages with the bare
// `onb:next` payload still route here.
bot.action(/^onb:next(?::([a-z_]+))?$/, async (ctx) => {
  const telegramId = ctx.from.id;
  try {
    const hintedStep = ctx.match?.[1] || null;
    const state = await ensureOnboardingState(ctx, hintedStep);
    const persistOpts = {
      touchCommunities: state.step === "audiences",
      touchLocation: state.step === "location" || state.step === "location_other",
      touchTopLabels: state.step === "toplabels",
    };
    await persistOnboardingState(telegramId, state, persistOpts);
    if (state.editReturn === "profile" && state.step === "audiences") {
      sessionStore.clearOnboarding(telegramId);
      await ctx.answerCbQuery("✅");
      await showProfileView(ctx);
      return;
    }
    const next = nextStepAfter(state.step);
    if (!next) {
      await ctx.answerCbQuery();
      return;
    }
    sessionStore.updateOnboarding(telegramId, { step: next });
    const updated = sessionStore.getOnboarding(telegramId);
    await ctx.answerCbQuery("✅");
    await renderOnboardingStep(ctx, updated);
  } catch (err) {
    console.error("[Bot] onb:next error:", err.message);
    await ctx.answerCbQuery("⚠️");
  }
});

// onb:skip[:step] — legacy. The picker no longer renders a skip
// button (per the UX revision that removed it), but inline buttons in
// older chat histories may still post this callback. Behavior matches
// onb:next: save whatever's currently checked + advance.
bot.action(/^onb:skip(?::([a-z_]+))?$/, async (ctx) => {
  const telegramId = ctx.from.id;
  try {
    const hintedStep = ctx.match?.[1] || null;
    const state = await ensureOnboardingState(ctx, hintedStep);
    // Saving on skip is intentional. For audiences step we still
    // touchCommunities so any chip the user explicitly checked before
    // tapping skip gets persisted. We DO NOT volunteer 'not-member'
    // for unchecked chips — that rule lives inside
    // persistOnboardingState. Skipping the toplabels step also stamps
    // seen_toplabels so we don't keep re-prompting returning users.
    const persistOpts = {
      touchCommunities: state.step === "audiences",
      touchLocation: state.step === "location" || state.step === "location_other",
      touchTopLabels: state.step === "toplabels",
    };
    await persistOnboardingState(telegramId, state, persistOpts);
    const next = nextStepAfter(state.step);
    if (!next) {
      await ctx.answerCbQuery();
      return;
    }
    sessionStore.updateOnboarding(telegramId, { step: next });
    const updated = sessionStore.getOnboarding(telegramId);
    await ctx.answerCbQuery("⏭ דילגתי");
    await renderOnboardingStep(ctx, updated);
  } catch (err) {
    console.error("[Bot] onb:skip error:", err.message);
    await ctx.answerCbQuery("⚠️");
  }
});

// onb:back[:step] — return to previous step. No save (selections stay
// in session memory so the user can re-engage with the previous
// step). Optional `:step` suffix mirrors onb:next for precise
// rehydration after session eviction.
bot.action(/^onb:back(?::([a-z_]+))?$/, async (ctx) => {
  const telegramId = ctx.from.id;
  try {
    const hintedStep = ctx.match?.[1] || null;
    const state = await ensureOnboardingState(ctx, hintedStep);
    const prev = prevStepBefore(state.step);
    if (!prev) {
      await ctx.answerCbQuery();
      return;
    }
    sessionStore.updateOnboarding(telegramId, { step: prev });
    const updated = sessionStore.getOnboarding(telegramId);
    await ctx.answerCbQuery();
    await renderOnboardingStep(ctx, updated);
  } catch (err) {
    console.error("[Bot] onb:back error:", err.message);
    await ctx.answerCbQuery("⚠️");
  }
});

// onb:cancel — abort the whole flow. NOTHING is saved; the user's
// profile is exactly as it was before they opened the picker.
bot.action("onb:cancel", async (ctx) => {
  const telegramId = ctx.from.id;
  sessionStore.clearOnboarding(telegramId);
  await ctx.answerCbQuery("👍 ביטלתי");
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  await replyAsCallbackResult(
    ctx,
    "👍 לא שיניתי כלום. אפשר לחזור מתי שרוצים עם /interests.",
  );
});

// onb:done — final dismiss from the summary card. State already
// persisted at the location step (or earlier skip/next); this just
// closes the picker and unlocks the chat for normal interaction.
bot.action("onb:done", async (ctx) => {
  const telegramId = ctx.from.id;
  sessionStore.clearOnboarding(telegramId);
  await ctx.answerCbQuery("🎯");
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  await replyAsCallbackResult(
    ctx,
    "מצוין! עכשיו אני מכירה אותך טוב יותר. נסי לכתוב לי מה מעניין אותך השבוע ואני אמצא לך אירועים מתאימים.",
  );
});

// onb:restart — re-enter onboarding from step 1 with the just-saved
// profile as seed. Useful when the user wants to re-do their picks
// without leaving the summary screen.
bot.action("onb:restart", async (ctx) => {
  const telegramId = ctx.from.id;
  try {
    await ctx.answerCbQuery();
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    await openOnboarding(ctx, { triggeredBy: "manual" });
  } catch (err) {
    console.error("[Bot] onb:restart error:", err.message);
    await ctx.answerCbQuery("⚠️");
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Newsletter — weekly digest delivery + opt-out commands
// ──────────────────────────────────────────────────────────────────────────
//
// The scheduler (lib/newsletterScheduler.js) fires on a 5-min tick and
// invokes `renderNewsletterDigest(bot, telegramId, events)` with the
// per-user filtered event list. We render each event via the same
// photo-card path search results use, so badge / nav buttons / RTL
// anchoring are consistent across surfaces.
//
// SELECT button + bulk-action footer are added by Phase D (multi-
// select). For now the cards are read-only; the per-event "❌ לא
// מתאים" button on each card already gives users a way to suppress
// individual events even without the bulk path.

/** Minimal Telegraf-shaped ctx for sendEventCard outside an update handler. */
function makeNewsletterCtx(botInstance, telegramId) {
  const chatId = String(telegramId);
  return {
    from: { id: Number(telegramId) },
    chat: { id: chatId },
    state: {},
    telegram: botInstance.telegram,
    reply(text, extra = {}) {
      return botInstance.telegram.sendMessage(chatId, text, extra);
    },
    replyWithPhoto(photo, extra = {}) {
      return botInstance.telegram.sendPhoto(chatId, photo, extra);
    },
  };
}

// One full search-style card per digest row (series collapse → representative).
async function renderNewsletterEventCards(botInstance, tg, events) {
  const { newEvents, recurringSeries } = partitionNewsletterEvents(events);
  const cards = [...newEvents, ...recurringSeries];
  if (!cards.length) return;

  const intro =
    cards.length === 1
      ? "🆕 אירוע חדש שיכול לעניין אותך"
      : "🆕 אירועים שיכולים לעניין אותך";
  try {
    await botInstance.telegram.sendMessage(tg, rtlLine(intro));
  } catch (err) {
    if (isUserBlockedError(err)) return;
    console.warn(`[Newsletter] intro failed for ${tg}: ${err.message}`);
  }

  const ctx = makeNewsletterCtx(botInstance, tg);
  for (const event of cards) {
    try {
      const seriesOpts = await cardSendOptsForEvent(tg, event);
      await sendEventCard(ctx, event, seriesOpts);
    } catch (err) {
      if (isUserBlockedError(err)) return;
      console.error(
        `[Newsletter] card failed event=${event?.id} user=${tg}: ${err.message}`,
      );
    }
  }
}

async function renderNewsletterDigest(botInstance, telegramId, events) {
  const { rememberShownEvents } = sessionStore;
  if (!Array.isArray(events) || !events.length) return;

  const tg = String(telegramId);

  // Every digest row is a full in-bot event card (same renderer as search),
  // not a consolidated HTML block with external booking links on titles.
  sessionStore.clearNewsletterState(tg);

  const renderedIds = events.map((e) => e?.id).filter((id) => id != null);
  try {
    await renderNewsletterEventCards(botInstance, tg, events);
  } catch (err) {
    if (isUserBlockedError(err)) {
      console.warn(`[Newsletter] user ${tg} blocked — skipping`);
      return;
    }
    console.error(
      `[Newsletter] consolidated send failed for user=${tg}: ${err.message}`,
    );
    return;
  }

  // Track rendered ids for pagination bookkeeping (not search dedupe).
  if (renderedIds.length) {
    try {
      rememberShownEvents(tg, renderedIds);
    } catch {
      /* best-effort */
    }
  }
}

// ── Consolidated multi-event newsletter ────────────────────────────
// Renders all events into a single HTML text message (or a small
// chain of chunks if the body overruns Telegram's 4096-char limit).
// Each event becomes a 6-9 line "mini-card" block (May-2026 user
// request — match the regular event card layout):
//   <icon> <primary_title>
//   <secondary_title>            (only for umbrella children)
//   📅 date
//   🕐 time
//   📍 <a href=nav>venue</a>     (location → maps deep-link)
//   🎫 tickets                   (whenever count is known)
//   🏷️ tag • tag • tag
//   <description>                (own line(s) when populated)
// Blocks are separated by blank lines.
//
// Why HTML and not Markdown V1 — event titles arrive from the
// scraper and frequently contain `_` (smarticket slugs), `*` (admin
// notes like "*הכרטיסים אזלו"), and `[`/`]`. Markdown V1 would
// either render those as formatting or trip the parser with
// "can't parse entities" errors. HTML's only reserved chars are
// `<`, `>`, `&`, which we escape inline.
const NEWSLETTER_CHUNK_LIMIT = 3800; // a bit under TG's 4096 to leave room for the RTL wrap

function escHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Inline 📍 links in umbrella lists / digests — same rules as 🧭 ניווט.
function buildLocationNavUrl(event, navOpts = {}) {
  return buildMapsNavUrl(event, navOpts);
}

function buildConsolidatedEventBlock(event, botUsername = null, profile = null) {
  const lines = [];
  const { primaryTitle, secondaryTitle, icon, iconOnSecondary } =
    resolveEventTitleParts(event);
  const primaryEsc = escHtml(primaryTitle || "ללא שם");
  const cardHref = buildEventCardDeepLink(botUsername, event.id);
  if (iconOnSecondary) {
    lines.push(
      cardHref
        ? `<b><a href="${escHtml(cardHref)}">${primaryEsc}</a></b>`
        : primaryEsc,
    );
    lines.push(`${icon} <b>${escHtml(secondaryTitle)}</b>`);
  } else if (secondaryTitle) {
    lines.push(
      cardHref
        ? `${icon} <b><a href="${escHtml(cardHref)}">${primaryEsc}</a></b>`
        : `${icon} <b>${primaryEsc}</b>`,
    );
    lines.push(`<b>${escHtml(secondaryTitle)}</b>`);
  } else {
    lines.push(
      cardHref
        ? `${icon} <b><a href="${escHtml(cardHref)}">${primaryEsc}</a></b>`
        : `${icon} <b>${primaryEsc}</b>`,
    );
  }

  // Date + time on their OWN lines (May-2026 request — match the
  // event card's vertical layout instead of the previously-compact
  // single meta line).
  if (event.date) lines.push(`📅 ${escHtml(formatHebrewDate(event.date))}`);
  const timeStr = formatTimeRange(event.start_time, event.end_time);
  if (timeStr) lines.push(`🕐 ${escHtml(timeStr)}`);

  const audienceLine = formatAdultAgeGate(event);
  if (audienceLine) lines.push(escHtml(audienceLine));

  // Location → maps deep-link. Use 📷 instead of 📍 for online events.
  const locIcon = event.online_url ? "📷" : "📍";
  if (event.location) {
    const navOpts = navOptsFromProfile(profile, event);
    const navUrl = event.online_url ? null : buildLocationNavUrl(event, navOpts);
    lines.push(
      navUrl
        ? `${locIcon} <a href="${escHtml(navUrl)}">${escHtml(event.location)}</a>`
        : `${locIcon} ${escHtml(event.location)}`,
    );
  } else if (event.online_url) {
    lines.push("📷 אונליין");
  }

  // Tickets — show the FULL line whenever count is known (not just
  // low-stock urgency). The consolidated digest is most users'
  // "what's worth registering" mailer, so seeing "🎫 11 כרטיסים"
  // is informative on its own. Sold-out events get the explicit
  // "🚫 אזלו" line.
  const ticketsLine =
    event.tickets_left === 0
      ? "🚫 אזלו הכרטיסים"
      : formatTicketsLine(event.tickets_left);
  if (ticketsLine) lines.push(escHtml(ticketsLine));

  // Description gets its OWN 📝 prefix (May-2026 user request) so
  // it visually parallels the date/time/location/tickets/tags
  // lines — a labeled facet, not an orphan paragraph. Normalised
  // whitespace + soft cap so a single verbose entry can't blow
  // past the chunking limit. The cap is per-event;
  // chunkConsolidatedBody enforces the overall message-size
  // guarantee.
  //
  // Order matters: description comes BEFORE the tag line so 🏷️
  // remains the final line of the block — the visual "footer"
  // that summarises the topic at a glance.
  const readMoreHref = getMiniAppCatalogUrl()
    ? buildMiniAppReadMoreLink(botUsername, event.id)
    : buildReadMoreDeepLink(botUsername, event.id);
  const descLine = formatDescriptionForCard(event.description, {
    readMoreHref,
    escapeHtml: escHtml,
  });
  if (descLine) lines.push(`📝 ${descLine}`);

  // Tag line — same formatter the event card uses. Without
  // per-user `highlight`/`searchHits` we just render the plain
  // sorted line. Falsy when the event has no tags. Always the
  // LAST line of the block per the May-2026 user request.
  if (Array.isArray(event.tags) && event.tags.length) {
    const { filterTagsForDisplay } = require("../lib/tagSuppressPrefs");
    const displayTags = filterTagsForDisplay(event.tags, profile);
    const tagLine = formatTagLine(displayTags, {
      highlight: [],
      searchHits: [],
    });
    if (tagLine) lines.push(escHtml(tagLine));
  }

  return lines.join("\n");
}

// Partition events into two newsletter sections:
//   - "new": one-time events. An umbrella with N distinct children
//     counts as N new events (each child has a unique `name` →
//     `groupIntoSeries` lands each in its own bucket of size 1).
//   - "recurring": same-name occurrences across dates (Rega'im
//     playgroup, weekly consultation, active-garden runs). The
//     series collapses to ONE entry per group — we pick the
//     soonest occurrence as the representative, so the digest
//     shows "this is happening, next on <date>" once per series
//     instead of repeating the same activity 4 times.
//
// Why not use `total_occurrences` already attached by search tools:
// the newsletter pipeline never goes through `searchEventsTool`
// (it has its own `generateUserNewsletter` filters), so we run the
// series collapse here. Keeping the grouping local also lets us
// pick a representative for the recurring section deterministically
// — newsletter wants the SOONEST date, not whatever Gemini's sort
// produced.
function partitionNewsletterEvents(events) {
  const { groupIntoSeries } = require("../lib/eventSeries");
  const buckets = groupIntoSeries(events);
  const newEvents = [];
  const recurringSeries = [];
  for (const bucket of buckets) {
    if (bucket.occurrences.length <= 1) {
      // One-time event (includes every umbrella child with a unique
      // chained name). Push the representative — for size-1 buckets
      // the representative IS the occurrence.
      newEvents.push(bucket.representative);
    } else {
      // Recurring series: pick the soonest occurrence as the row to
      // render, and stash the series size so the block can say
      // "🔁 ועוד N מופעים" without re-grouping downstream.
      const soonest = bucket.occurrences
        .slice()
        .sort((a, b) => {
          const aDate = a.date || "9999-12-31";
          const bDate = b.date || "9999-12-31";
          if (aDate !== bDate) return aDate < bDate ? -1 : 1;
          const aTime = a.start_time || "99:99";
          const bTime = b.start_time || "99:99";
          return aTime < bTime ? -1 : aTime > bTime ? 1 : 0;
        })[0];
      recurringSeries.push({
        ...soonest,
        _seriesSize: bucket.occurrences.length,
      });
    }
  }
  return { newEvents, recurringSeries };
}

function buildConsolidatedNewsletterBody(events, botUsername = null, profile = null) {
  const { newEvents, recurringSeries } = partitionNewsletterEvents(events);
  const block = (e) => buildConsolidatedEventBlock(e, botUsername, profile);
  const sections = [];
  if (newEvents.length) {
    sections.push(
      `🆕 <b>אירועים חדשים</b>\n\n` + newEvents.map(block).join("\n\n"),
    );
  }
  if (recurringSeries.length) {
    sections.push(
      `🔁 <b>אירועים חוזרים</b>\n\n` +
        recurringSeries.map(block).join("\n\n"),
    );
  }
  // Empty-payload fallback shouldn't normally happen (the scheduler
  // skips empty digests upstream), but guard so we don't ship a bare
  // header with nothing under it.
  if (!sections.length) {
    return `🆕 <b>אירועים שיכולים לעניין אותך</b>`;
  }
  return sections.join("\n\n");
}

// Telegram message bodies cap at 4096 chars. The consolidated body
// fits in one message for a "normal" digest (5-15 events), but we
// chunk defensively at event-block boundaries so a 20-event digest
// doesn't get truncated mid-event. Each chunk is sent as a separate
// `sendMessage` with HTML parse mode; the RTL wrapper is applied
// centrally by the bot.telegram patcher.
//
// Section-aware chunking: section headers ("🆕 אירועים חדשים" / "🔁
// אירועים חוזרים") stay with their first event block. If a section
// is so long that even its FIRST event tips us over the chunk limit,
// the header lives alone on the previous chunk — better than
// dropping the header to fit one extra block.
function chunkConsolidatedBody(events, botUsername = null, profile = null) {
  const { newEvents, recurringSeries } = partitionNewsletterEvents(events);
  const block = (e) => buildConsolidatedEventBlock(e, botUsername, profile);
  const segments = [];
  if (newEvents.length) {
    segments.push({
      header: `🆕 <b>אירועים חדשים</b>`,
      blocks: newEvents.map(block),
    });
  }
  if (recurringSeries.length) {
    segments.push({
      header: `🔁 <b>אירועים חוזרים</b>`,
      blocks: recurringSeries.map(block),
    });
  }
  if (!segments.length) {
    return [`🆕 <b>אירועים שיכולים לעניין אותך</b>`];
  }
  const chunks = [];
  let current = "";
  for (const seg of segments) {
    // Each section starts on a fresh "line group" — emit the header
    // first, attached to current if it fits, else flushed.
    const headerCandidate = current ? `${current}\n\n${seg.header}` : seg.header;
    if (headerCandidate.length > NEWSLETTER_CHUNK_LIMIT) {
      if (current) chunks.push(current);
      current = seg.header;
    } else {
      current = headerCandidate;
    }
    for (const block of seg.blocks) {
      const candidate = `${current}\n\n${block}`;
      if (candidate.length > NEWSLETTER_CHUNK_LIMIT) {
        chunks.push(current);
        current = block;
      } else {
        current = candidate;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function sendConsolidatedNewsletter(botInstance, tg, events) {
  let botUsername = null;
  try {
    botUsername = await referralService.getBotUsername(botInstance.telegram);
  } catch {
    /* inline read-more links omitted when username lookup fails */
  }
  const profile = await getProfile(tg).catch(() => null);
  const chunks = chunkConsolidatedBody(events, botUsername, profile);
  for (const chunk of chunks) {
    await botInstance.telegram.sendMessage(tg, chunk, {
      parse_mode: "HTML",
      // `disable_web_page_preview: true` would suppress the link
      // preview Telegram generates for the first http(s) URL it
      // finds in the body. We embed many event links per chunk; the
      // preview-of-the-first-one is usually unhelpful (often the
      // smarticket landing rather than the event itself) and adds
      // visual clutter that defeats the "compact digest" intent.
      disable_web_page_preview: true,
    });
  }
}

// Single-event flush — sends a small "🆕 אירוע חדש" lead-in
// followed by ONE card. No multi-select session state needed (the
// user can tap "❌ לא מתאים" / "🔁 מכירה" on the card itself, and
// nav / details buttons cover the immediate actions). When the user
// wants the bulk-select UX, a later cycle that aggregates 2+ events
// produces the multi-card path above.
async function renderSingleEventFlush(botInstance, tg, event) {
  try {
    const profile = await getProfile(tg).catch(() => null);
    const navOpts = navOptsFromProfile(profile, event);
    const reply_markup = buildSingleEventKeyboard(event, navOpts);
    // Fold the "🆕 אירוע חדש שיכול לעניין אותך" lead-in into the card
    // itself instead of sending it as a separate message — one event,
    // one message.
    const text = `${rtlLine("🆕 אירוע חדש שיכול לעניין אותך")}\n\n${buildNewsletterCardText(event)}`;
    const photoUrl = normalizeImageUrl(event.image, event);
    if (photoUrl && text.length <= 1024) {
      try {
        await botInstance.telegram.sendPhoto(tg, photoUrl, {
          caption: text,
          reply_markup,
        });
        return;
      } catch (err) {
        if (isUserBlockedError(err)) return;
        console.warn(`[Newsletter] single photo fallback: ${err.message}`);
      }
    }
    await botInstance.telegram.sendMessage(tg, text, { reply_markup });
  } catch (err) {
    if (!isUserBlockedError(err)) {
      console.error(`[Newsletter] single card failed for ${tg}: ${err.message}`);
    }
  }
}

// Keyboard for a SINGLE-event flush — drops the ☐ בחר button (no
// batch to select into) and keeps the high-value action set per
// spec §3: nav (single "🧭 ניווט") + details (acts as
// "🔗 Register") + ❌ לא מתאים.
function buildSingleEventKeyboard(event, navOpts = {}) {
  const navBtns = buildNavButtons(event, navOpts);
  const detailsBtn = buildDetailsButton(event);
  const topRow = [...navBtns, detailsBtn].filter(Boolean);
  const rows = [];
  if (topRow.length) rows.push(topRow);
  const semRow = buildSemanticMatchRow(event);
  if (semRow) rows.push(semRow);
  rows.push([{ text: "🚫 אל תראה לי יותר", callback_data: `fb:reasons:${event.id}` }]);
  return { inline_keyboard: rows };
}

// Footer text + keyboard helpers. The "(N)" counter on each button
// stays present even when N=0 so the affordance is visible — the
// callback handlers check N>0 and respond with a toast prompting the
// user to select at least one event.
function buildNewsletterFooterText(selectedCount) {
  if (selectedCount === 0) {
    return rtlLine("📋 בחרו אירועים בלחיצה על ☐ בחר, ואז בצעו פעולה:");
  }
  return rtlLine(`📋 נבחרו ${selectedCount} אירועים — בצעי פעולה:`);
}

function buildNewsletterFooterKeyboard(selectedCount) {
  // Three bulk actions: calendar / share / not-relevant. Stacked one
  // per row on narrow phones — the labels are too long to fit two
  // across without truncation.
  return {
    inline_keyboard: [
      [{ text: `📅 הוסיפי ליומן (${selectedCount})`, callback_data: "nl:cal" }],
      [{ text: `📤 שתפי (${selectedCount})`, callback_data: "nl:share" }],
      [{ text: `❌ סמני כלא רלוונטי (${selectedCount})`, callback_data: "nl:notrel" }],
    ],
  };
}

// Build the per-card select-button label based on whether the card's
// event id is currently selected on session.
function buildSelectButton(eventId, selectedSet) {
  const checked = selectedSet.has(eventId);
  return {
    text: checked ? "☑ נבחר" : "☐ בחר",
    callback_data: `nl:tog:${eventId}`,
  };
}

// `user blocked the bot` / `chat not found` errors — both mean we
// can't deliver to this user this cycle. They're not bugs; abort
// quietly. Telegraf surfaces them as `TelegramError` with codes 403
// (Forbidden) and 400 with specific descriptions.
function isUserBlockedError(err) {
  const code = err?.code || err?.response?.error_code;
  if (code === 403) return true;
  const desc = String(err?.description || err?.message || "").toLowerCase();
  if (desc.includes("bot was blocked")) return true;
  if (desc.includes("user is deactivated")) return true;
  if (desc.includes("chat not found")) return true;
  return false;
}

// Standalone card sender — mirrors sendEventCard's text/keyboard
// layout but takes a raw chatId and uses bot.telegram directly (the
// scheduler runs outside any Telegraf update context). Returns the
// Telegram message object so the caller can record message_id for
// in-place edits on toggle.
async function sendNewsletterCard(botInstance, chatId, event) {
  const profile = await getProfile(chatId).catch(() => null);
  const navOpts = navOptsFromProfile(profile, event);
  const reply_markup = buildNewsletterCardKeyboard(event, new Set(), navOpts);
  let botUsername = null;
  try {
    botUsername = await referralService.getBotUsername(botInstance.telegram);
  } catch {
    /* read-more links omitted */
  }
  const text = buildNewsletterCardText(event, botUsername);
  const msgOpts = { reply_markup, parse_mode: "HTML" };
  const photoUrl = normalizeImageUrl(event.image, event);
  if (photoUrl && text.length <= 1024) {
    try {
      return await botInstance.telegram.sendPhoto(chatId, photoUrl, {
        caption: text,
        ...msgOpts,
      });
    } catch (err) {
      if (isUserBlockedError(err)) throw err;
      console.warn(
        `[Newsletter] photo fallback for event ${event.id}: ${err.message}`,
      );
    }
  }
  return await botInstance.telegram.sendMessage(chatId, text, msgOpts);
}

// Text body for a newsletter card — same fields as the agent's
// sendEventCard but without the proximity/audience-verdict signals
// (those are search-time concerns).
//
// When `event._semanticMatch` is set (the annotator decided this
// event surfaces a novel label the user hasn't opted into yet), we
// prepend a "🆕 חדש בקטלוג: <label>" subtitle. The accompanying
// ➕/📭 buttons live in buildNewsletterCardKeyboard /
// buildSingleEventKeyboard so the user can opt-in or opt-out
// without leaving the card.
function buildNewsletterCardText(event, botUsername = null) {
  const lines = [`${getEventIcon(event)} ${escapeHtml(event.name)}`];
  if (event._semanticMatch?.label_name) {
    lines.push(`🆕 חדש בקטלוג: ${escapeHtml(event._semanticMatch.label_name)}`);
  }
  if (event.date) lines.push(`📅 ${escapeHtml(formatHebrewDate(event.date))}`);
  const timeStr = formatTimeRange(event.start_time, event.end_time);
  if (timeStr) lines.push(rtlLine(`🕐 ${escapeHtml(timeStr)}`));
  const audienceLine = formatAdultAgeGate(event);
  if (audienceLine) lines.push(escapeHtml(audienceLine));
  if (event.location) lines.push(`📍 ${escapeHtml(event.location)}`);
  const ticketsLine = formatTicketsLine(event.tickets_left);
  if (ticketsLine) lines.push(escapeHtml(ticketsLine));
  const readMoreHref = getMiniAppCatalogUrl()
    ? buildMiniAppReadMoreLink(botUsername, event.id)
    : buildReadMoreDeepLink(botUsername, event.id);
  const descLine = formatDescriptionForCard(event.description, {
    readMoreHref,
    escapeHtml,
  });
  if (descLine) lines.push(`📝 ${descLine}`);
  if (Array.isArray(event.tags) && event.tags.length) {
    const tagLine = formatTagLine(event.tags, { highlight: [], searchHits: [] });
    if (tagLine) lines.push(escapeHtml(tagLine));
  }
  return lines.map(rtlLine).join("\n");
}

// Inline-keyboard row for semantic-match events. Shared between the
// single-event flush and the multi-event newsletter card so both
// paths surface the same ➕ / 📭 affordance.
//
// We pack (event_id, label_id) into callback_data — neither is
// large enough to risk the 64-byte cap (10-digit each leaves plenty
// of headroom) and storing the id avoids the awkward Hebrew-in-
// callback case. The label name itself is resolved server-side
// from the id when the user taps either button.
function buildSemanticMatchRow(event) {
  if (!event?._semanticMatch?.label_id) return null;
  const { label_id, label_name } = event._semanticMatch;
  return [
    {
      text: `➕ עוד כמו זה (${label_name})`,
      callback_data: `sem:add:${event.id}:${label_id}`,
    },
    {
      text: "📭 לא רלוונטי",
      callback_data: `sem:supp:${event.id}:${label_id}`,
    },
  ];
}

// Build keyboard for a newsletter card. Three rows:
//   1. nav (single "🧭 ניווט") + details
//   2. ☐ בחר / ☑ נבחר  — selection toggle (Phase D multi-select)
//   3. ❌ לא מתאים     — per-card feedback opt-out (existing)
// Selection state lives on session; toggling re-renders just this
// keyboard via editMessageReplyMarkup so the visual state stays in
// sync.
function buildNewsletterCardKeyboard(event, selectedSet, navOpts = {}) {
  const navBtns = buildNavButtons(event, navOpts);
  const detailsBtn = buildDetailsButton(event);
  const topRow = [...navBtns, detailsBtn].filter(Boolean);
  const rows = [];
  if (topRow.length) rows.push(topRow);
  rows.push([buildSelectButton(event.id, selectedSet)]);
  const semRow = buildSemanticMatchRow(event);
  if (semRow) rows.push(semRow);
  rows.push([{ text: "🚫 אל תראה לי יותר", callback_data: `fb:reasons:${event.id}` }]);
  return { inline_keyboard: rows };
}

// ──────────────────────────────────────────────────────────────────────────
// Newsletter multi-select callback handlers — nl:tog, nl:share,
// nl:notrel, nl:cal (stub until Phase E lands the Calendar service).
// ──────────────────────────────────────────────────────────────────────────

// sem:add:<eventId>:<labelId>  — "➕ עוד כמו זה" on a semantic-match
//   card. Adds the surfaced label NAME to profile.user_context.
//   interests[] so future events tagged with it match strictly (no
//   Gemini round-trip needed).
//
// sem:supp:<eventId>:<labelId> — "📭 לא רלוונטי" on a semantic-match
//   card. Adds the label NAME to profile.user_context.suppressed_
//   labels[]. The annotator excludes any label that appears there
//   when picking the novel surface label — events whose ONLY novel
//   label is suppressed deliver as plain cards (no +/- row).
//
// Both handlers strip the sem-row off the message keyboard so the
// affordance doesn't reappear. Other rows (nav, details, ☐ בחר,
// ❌ לא מתאים) survive untouched.
async function applySemanticAction(ctx, action) {
  const telegramId = ctx.from.id;
  try {
    const eventId = parseInt(ctx.match[1], 10);
    const labelId = parseInt(ctx.match[2], 10);
    if (!Number.isFinite(eventId) || !Number.isFinite(labelId)) {
      await safeAck(ctx, "⚠️");
      return;
    }
    const labelStoreModule = require("../lib/labelStore");
    const dict = await labelStoreModule.fetchLabelDict([labelId]);
    const row = dict.get(labelId);
    if (!row?.name) {
      await safeAck(ctx, "⚠️ התגית כבר לא קיימת");
      return;
    }
    const labelName = row.name;
    const profile = await getProfile(telegramId).catch(() => null);
    const ctxJson = profile?.user_context || {};

    let toast;
    let nextCtxJson;
    if (action === "add") {
      const existing = Array.isArray(ctxJson.interests) ? ctxJson.interests : [];
      const set = new Set(existing);
      const wasPresent = set.has(labelName);
      set.add(labelName);
      // Also clear it from suppressed_labels — if the user is now
      // opting in, the earlier opt-out is moot. Easier to keep the
      // sets disjoint than to special-case the matcher later.
      const suppressed = Array.isArray(ctxJson.suppressed_labels)
        ? ctxJson.suppressed_labels.filter((s) => s !== labelName)
        : [];
      nextCtxJson = { ...ctxJson, interests: [...set], suppressed_labels: suppressed };
      toast = wasPresent ? "✓ כבר ברשימה" : `✓ נוסף: ${labelName}`;
    } else {
      const existing = Array.isArray(ctxJson.suppressed_labels)
        ? ctxJson.suppressed_labels
        : [];
      const set = new Set(existing);
      const wasPresent = set.has(labelName);
      set.add(labelName);
      // Mirror: drop from interests if present so the matcher won't
      // strict-match this label anymore. Aggressive but consistent
      // with the user's "📭 לא רלוונטי" intent.
      const interests = Array.isArray(ctxJson.interests)
        ? ctxJson.interests.filter((i) => i !== labelName)
        : [];
      nextCtxJson = { ...ctxJson, suppressed_labels: [...set], interests };
      toast = wasPresent ? "✓ כבר מודחק" : "✓ לא אטריד שוב";
    }

    const supabase = require("../lib/supabase");
    await supabase
      .from("profiles")
      .update({ user_context: nextCtxJson })
      .eq("telegram_id", String(telegramId));

    // Drop the annotation off the session-stored copy of this event
    // so a subsequent `nl:tog` re-render of the same card doesn't
    // resurrect the sem row from `_semanticMatch`. Best-effort —
    // single-event flushes don't carry a session at all.
    try {
      const nlState = sessionStore.getNewsletterState(telegramId);
      const ev = nlState?.events?.get?.(eventId);
      if (ev) delete ev._semanticMatch;
    } catch {
      // ignore: state may not exist (single-event flush path)
    }

    // Strip the sem row from the keyboard. We grab the existing
    // markup off the callback query rather than rebuilding from
    // scratch — that way nav/select/details/feedback buttons stay
    // exactly as they were, regardless of which card path
    // (single-event vs multi) we landed on.
    const existingMarkup = ctx.callbackQuery?.message?.reply_markup?.inline_keyboard || [];
    const filtered = existingMarkup.filter(
      (kbRow) => !kbRow.some((btn) => typeof btn.callback_data === "string" && btn.callback_data.startsWith("sem:")),
    );
    try {
      await ctx.editMessageReplyMarkup({ inline_keyboard: filtered });
    } catch (err) {
      const msg = err?.message || "";
      if (!msg.includes("message is not modified")) {
        console.warn(`[Bot] sem:${action} editMarkup failed: ${msg}`);
      }
    }
    await safeAck(ctx, toast);
  } catch (err) {
    console.error(`[Bot] sem:${action} error:`, err.message);
    await safeAck(ctx, "⚠️");
  }
}

bot.action(/^sem:add:(\d+):(\d+)$/, (ctx) => applySemanticAction(ctx, "add"));
bot.action(/^sem:supp:(\d+):(\d+)$/, (ctx) => applySemanticAction(ctx, "supp"));

// nl:tog:<eventId> — toggle selection. Edits the card's keyboard
// in-place (just the select button label flips) and edits the footer
// to update the counter and (eventually) enable/disable bulk buttons.
bot.action(/^nl:tog:(\d+)$/, async (ctx) => {
  const telegramId = ctx.from.id;
  try {
    const state = sessionStore.getNewsletterState(telegramId);
    if (!state) {
      await safeAck(ctx, "⏰ הניוזלטר הזה כבר לא בתוקף", { show_alert: false });
      return;
    }
    const eventId = parseInt(ctx.match[1], 10);
    if (!Number.isFinite(eventId) || !state.events.has(eventId)) {
      await safeAck(ctx, "⚠️ האירוע לא נמצא");
      return;
    }
    if (state.selectedEventIds.has(eventId)) {
      state.selectedEventIds.delete(eventId);
    } else {
      state.selectedEventIds.add(eventId);
    }
    // Edit THIS card's keyboard — just flip the select button label.
    const event = state.events.get(eventId);
    const profile = await getCachedUserProfile(ctx);
    const navOpts = navOptsFromProfile(profile, event);
    const cardMarkup = buildNewsletterCardKeyboard(
      event,
      state.selectedEventIds,
      navOpts,
    );
    try {
      // editMessageReplyMarkup works for both text + photo messages.
      await ctx.editMessageReplyMarkup(cardMarkup);
    } catch (err) {
      // Photo cards sometimes 400 with "message can't be edited" if
      // the message went stale — non-fatal, the next render will fix.
      const msg = err?.message || String(err || "");
      if (!msg.includes("message is not modified")) {
        console.warn(`[Bot] nl:tog editMarkup failed: ${msg}`);
      }
    }
    // Edit the footer to update the counter.
    const selectedCount = state.selectedEventIds.size;
    if (state.footerChatId && state.footerMessageId) {
      try {
        await ctx.telegram.editMessageText(
          state.footerChatId,
          state.footerMessageId,
          undefined,
          buildNewsletterFooterText(selectedCount),
          { reply_markup: buildNewsletterFooterKeyboard(selectedCount) },
        );
      } catch (err) {
        const msg = err?.message || "";
        if (!msg.includes("message is not modified")) {
          console.warn(`[Bot] nl:tog editFooter failed: ${msg}`);
        }
      }
    }
    await safeAck(ctx, state.selectedEventIds.has(eventId) ? "☑ נבחר" : "☐ הוסר");
  } catch (err) {
    console.error("[Bot] nl:tog error:", err.message);
    await safeAck(ctx, "⚠️");
  }
});

// nl:share — assemble a Markdown summary of all selected events and
// send it as a fresh message. The user forwards it to wherever they
// want (group chat, partner, etc.) — Telegram doesn't expose a
// programmatic "share" affordance for arbitrary text, the forward
// button on a regular message IS the share path.
bot.action("nl:share", async (ctx) => {
  const telegramId = ctx.from.id;
  try {
    const state = sessionStore.getNewsletterState(telegramId);
    if (!state) {
      await safeAck(ctx, "⏰ הניוזלטר הזה כבר לא בתוקף");
      return;
    }
    if (state.selectedEventIds.size === 0) {
      await safeAck(ctx, "יש לבחור לפחות אירוע אחד עם ☐ בחר", { show_alert: true });
      return;
    }
    const selected = [...state.selectedEventIds]
      .map((id) => state.events.get(id))
      .filter(Boolean);
    const text = buildShareText(selected);
    await safeAck(ctx, "📤 בונה הודעה");
    await ctx.reply(text, {
      parse_mode: "Markdown",
      // Disable preview — the message can contain multiple URLs
      // (one per event) and Telegram would otherwise render a card
      // for whichever URL it parses first.
      link_preview_options: { is_disabled: true },
    });
    // Reset selection after the action so the footer counter
    // immediately reflects "nothing selected" — that's the natural
    // post-action state.
    await resetNewsletterSelection(ctx, telegramId);
  } catch (err) {
    console.error("[Bot] nl:share error:", err.message);
    await safeAck(ctx, "⚠️");
  }
});

// nl:notrel — bulk "not relevant" mark for all selected events.
// Writes one `event_feedback` row per event (reason='not_interested')
// and adds the events' tags / venues to the profile's
// `disliked_tags` / `disliked_venues` JSONB arrays so the newsletter
// generator suppresses similar content next time.
bot.action("nl:notrel", async (ctx) => {
  const telegramId = ctx.from.id;
  try {
    const state = sessionStore.getNewsletterState(telegramId);
    if (!state) {
      await safeAck(ctx, "⏰ הניוזלטר הזה כבר לא בתוקף");
      return;
    }
    if (state.selectedEventIds.size === 0) {
      await safeAck(ctx, "יש לבחור לפחות אירוע אחד עם ☐ בחר", { show_alert: true });
      return;
    }
    const selected = [...state.selectedEventIds]
      .map((id) => state.events.get(id))
      .filter(Boolean);
    await safeAck(ctx, "מעדכנת...");

    // Persist feedback rows — best-effort per event, errors don't
    // abort the rest of the batch. recordFeedback dedupes a missing
    // table silently.
    const { recordFeedback } = require("../lib/feedbackService");
    for (const event of selected) {
      try {
        await recordFeedback({
          eventId: event.id,
          telegramId,
          reason: "not_interested",
          note: "bulk_newsletter_not_relevant",
        });
      } catch (err) {
        console.warn(`[Bot] nl:notrel feedback event=${event.id}: ${err.message}`);
      }
    }

    // Aggregate tags + venues from the selected events into the
    // profile's disliked_* arrays. FIFO cap of 50 each — beyond that
    // the signal is degraded ("user doesn't like our recommendations
    // in general") and we'd rather keep recent dislikes than ancient
    // ones.
    try {
      await learnDislikedSignalsFromEvents(telegramId, selected);
    } catch (err) {
      console.warn(`[Bot] nl:notrel learn failed: ${err.message}`);
    }

    await ctx.reply(
      rtlLine(
        `✅ סימנתי ${selected.length} אירועים כלא רלוונטיים. אזהר מתוכן דומה בניוזלטרים הבאים.`,
      ),
    );
    await resetNewsletterSelection(ctx, telegramId);
  } catch (err) {
    console.error("[Bot] nl:notrel error:", err.message);
    await safeAck(ctx, "⚠️");
  }
});

// nl:cal — Phase D stub. Without OAuth tokens we can't insert into
// the user's calendar; route them to /connect_calendar (Phase E).
bot.action("nl:cal", async (ctx) => {
  const telegramId = ctx.from.id;
  try {
    const state = sessionStore.getNewsletterState(telegramId);
    if (!state) {
      await safeAck(ctx, "⏰ הניוזלטר הזה כבר לא בתוקף");
      return;
    }
    if (state.selectedEventIds.size === 0) {
      await safeAck(ctx, "יש לבחור לפחות אירוע אחד עם ☐ בחר", { show_alert: true });
      return;
    }
    // Phase E replaces this branch with the real Calendar insert
    // path. Until tokens exist, the action ROUTES the user to the
    // OAuth flow — without that, every "add to calendar" tap is a
    // dead-end. The /connect_calendar command (Phase E) renders the
    // sign-in button.
    const tokens = await loadGoogleTokens(telegramId).catch(() => null);
    if (!tokens) {
      await safeAck(ctx, "🔌 קודם נתחבר ל-Google Calendar");
      await ctx.reply(
        rtlLine(
          "📅 כדי להוסיף אירועים ליומן Google, נתחבר פעם אחת:\n\n" +
            "השתמשי ב‑/connect_calendar להתחברות.",
        ),
      );
      return;
    }
    // Wired in Phase E.
    const selected = [...state.selectedEventIds]
      .map((id) => state.events.get(id))
      .filter(Boolean);
    await safeAck(ctx, "📅 מוסיפה ליומן...");
    const { insertEvents } = require("../lib/calendarService");
    const result = await insertEvents(telegramId, selected);
    await ctx.reply(
      rtlLine(
        result.inserted
          ? `✅ הוספתי ${result.inserted} אירועים ליומן שלך.`
          : "⚠️ לא הצלחתי להוסיף אירועים — נסי /connect_calendar שוב.",
      ),
    );
    await resetNewsletterSelection(ctx, telegramId);
  } catch (err) {
    console.error("[Bot] nl:cal error:", err.message);
    await safeAck(ctx, "⚠️");
  }
});

// Build the shareable Markdown summary message. Each event gets a
// compact block with name, date, time, venue, ticket count, and a
// link to the source. The header makes it clear this is a shared
// digest (not a personal recommendation) when the user forwards it.
function buildShareText(events) {
  const lines = ["*🎟️ אירועים מומלצים*", ""];
  for (const e of events) {
    lines.push(`*${e.name}*`);
    if (e.date) lines.push(`📅 ${formatHebrewDate(e.date)}`);
    const timeStr = formatTimeRange(e.start_time, e.end_time);
    if (timeStr) lines.push(`🕐 ${timeStr}`);
    if (e.location) lines.push(`📍 ${e.location}`);
    const sharedTicketsLine = formatTicketsLine(e.tickets_left);
    if (sharedTicketsLine) lines.push(sharedTicketsLine);
    const url = getBookingUrl(e);
    if (url) lines.push(url);
    lines.push("");
  }
  // Escape the user-visible body against Markdown control chars
  // (`_`, `*`, `[`, `]`, `` ` ``) so a venue name with an underscore
  // doesn't break the parse. We keep our own intentional formatting
  // (the leading `*` on each event title) by escaping AFTER we
  // composed the structure — i.e. we trust our own input but
  // sanitise the data fields. Simpler: just join and let Markdown
  // surface any oddity as plain text (telegraf falls back). For v1
  // the bare join is fine; we can tighten if it bites.
  return lines.join("\n");
}

// Aggregate tags + location_keys from a set of "not relevant" events
// into profile.user_context.disliked_tags / disliked_venues.
// FIFO-capped so the lists stay bounded.
const DISLIKE_CAP = 50;

async function learnDislikedSignalsFromEvents(telegramId, events) {
  const existing = await getProfile(telegramId);
  if (!existing) return;
  const ctx = existing.user_context || {};
  const dislikedTags = Array.isArray(ctx.disliked_tags) ? [...ctx.disliked_tags] : [];
  const dislikedVenues = Array.isArray(ctx.disliked_venues)
    ? [...ctx.disliked_venues]
    : [];

  // Bag of newly-introduced strings. We iterate the events oldest-to-
  // newest so the most recently disliked entries land at the END of
  // the FIFO (= last to be evicted), which matches user intuition.
  const newTags = [];
  const newVenues = [];
  for (const e of events) {
    if (Array.isArray(e?.tags)) {
      for (const t of e.tags) {
        const s = typeof t === "string" ? t.trim() : null;
        if (s && !dislikedTags.includes(s) && !newTags.includes(s)) newTags.push(s);
      }
    }
    const v = e?.location_key;
    if (v && !dislikedVenues.includes(v) && !newVenues.includes(v)) newVenues.push(v);
  }
  if (!newTags.length && !newVenues.length) return;

  // FIFO cap: keep the most recent DISLIKE_CAP entries.
  const mergedTags = [...dislikedTags, ...newTags].slice(-DISLIKE_CAP);
  const mergedVenues = [...dislikedVenues, ...newVenues].slice(-DISLIKE_CAP);

  // Touch user_context directly — saveProfile expects the brain
  // shape and we only need to bump two JSONB fields. Lazy require so
  // this module doesn't pull supabase at top level (matches the rest
  // of the file's lazy-require pattern for inline DB use).
  const supabase = require("../lib/supabase");
  const next_user_context = {
    ...ctx,
    disliked_tags: mergedTags,
    disliked_venues: mergedVenues,
  };
  const { data, error } = await supabase
    .from("profiles")
    .update({ user_context: next_user_context })
    .eq("telegram_id", String(telegramId));
  if (error) {
    throw new Error(`disliked-signals write failed: ${error.message}`);
  }
  return data;
}

// Persist a recurring-series suppressor for a single event_id. The
// "series" identity is intentionally simple: (name + location_key).
// That covers the canonical case ("משחקיית רגעים at מתנס X" — same
// name, same venue, different dates) without needing a stricter
// equality (e.g. trimming generation suffixes). False positives
// (two unrelated events that happen to share a name + venue) are
// unlikely AND recoverable: the user can ask the agent to "show me
// events" again and ask_clarification will resurface the affected
// series.
//
// Stored as profile.user_context.known_series as an array of
// strings (one per series) capped FIFO at KNOWN_SERIES_CAP. The
// match in newsletterService is string-equality, so the cap also
// keeps the per-event check cheap.
const KNOWN_SERIES_CAP = 100;

function seriesKeyFor(event) {
  // Lowercase + collapse whitespace so trivial formatting
  // differences ("משחקיית רגעים" vs "  משחקיית  רגעים") collapse to
  // the same identity. location_key is already canonical (FK into
  // locations), so we don't normalise it further.
  const name = String(event?.name || "").trim().replace(/\s+/g, " ").toLowerCase();
  const loc = event?.location_key || "";
  if (!name) return null;
  return `${name}::${loc}`;
}

async function rememberKnownSeries(telegramId, eventId) {
  const supabase = require("../lib/supabase");

  // Look up the event so we can derive its series identity. We pull
  // a narrow column set — name + location_key are the only fields
  // we need.
  const { data: event, error: evErr } = await supabase
    .from("events")
    .select("id, name, location_key")
    .eq("id", parseInt(eventId, 10))
    .maybeSingle();
  if (evErr || !event) {
    console.warn(
      `[Bot] rememberKnownSeries: event ${eventId} not found: ${evErr?.message || "no row"}`,
    );
    return;
  }
  const key = seriesKeyFor(event);
  if (!key) return;

  const existing = await getProfile(telegramId);
  if (!existing) return;
  const ctx = existing.user_context || {};
  const list = Array.isArray(ctx.known_series) ? [...ctx.known_series] : [];
  if (list.includes(key)) return; // already suppressed

  // FIFO cap — the most recent suppressions are at the END of the
  // list, the oldest at the FRONT. .slice(-CAP) keeps the recent
  // tail when we overflow.
  list.push(key);
  const next = list.slice(-KNOWN_SERIES_CAP);
  const next_user_context = { ...ctx, known_series: next };
  const { error: upErr } = await supabase
    .from("profiles")
    .update({ user_context: next_user_context })
    .eq("telegram_id", String(telegramId));
  if (upErr) {
    throw new Error(`known_series write failed: ${upErr.message}`);
  }
}

// Reset selection after a bulk action: clear the set, edit the footer
// counter back to 0, and (best-effort) flip every selected card's
// keyboard back to "☐ בחר". The cards' messages stay in chat so
// the user can re-select if they want to undo.
async function resetNewsletterSelection(ctx, telegramId) {
  const state = sessionStore.getNewsletterState(telegramId);
  if (!state) return;
  const profile = await getCachedUserProfile(ctx);
  const previouslySelected = [...state.selectedEventIds];
  state.selectedEventIds.clear();
  // Flip each previously-selected card's button back to "☐ בחר".
  for (const id of previouslySelected) {
    const event = state.events.get(id);
    const messageId = state.cardMessageIds.get(id);
    if (!event || !messageId) continue;
    const navOpts = navOptsFromProfile(profile, event);
    const cardMarkup = buildNewsletterCardKeyboard(
      event,
      state.selectedEventIds,
      navOpts,
    );
    try {
      await ctx.telegram.editMessageReplyMarkup(
        ctx.chat?.id || ctx.from.id,
        messageId,
        undefined,
        cardMarkup,
      );
    } catch (err) {
      const msg = err?.message || "";
      if (!msg.includes("message is not modified")) {
        // Non-fatal — the card might be too old to edit; we accept
        // the visual drift since the source-of-truth (session
        // state) is already correct.
      }
    }
  }
  // Reset footer counter.
  if (state.footerChatId && state.footerMessageId) {
    try {
      await ctx.telegram.editMessageText(
        state.footerChatId,
        state.footerMessageId,
        undefined,
        buildNewsletterFooterText(0),
        { reply_markup: buildNewsletterFooterKeyboard(0) },
      );
    } catch (err) {
      const msg = err?.message || "";
      if (!msg.includes("message is not modified")) {
        console.warn(`[Bot] resetNewsletterSelection footer: ${msg}`);
      }
    }
  }
}

// Lazy loader for Google OAuth tokens — wired by Phase E. Returns
// null when the table doesn't exist yet OR the user hasn't connected.
async function loadGoogleTokens(telegramId) {
  const supabase = require("../lib/supabase");
  const { data, error } = await supabase
    .from("google_oauth_tokens")
    .select("telegram_id, access_token, refresh_token, expires_at, scope")
    .eq("telegram_id", String(telegramId))
    .maybeSingle();
  if (error) {
    if (error.code === "42P01" || error.code === "PGRST205") return null;
    console.warn(`[Bot] loadGoogleTokens: ${error.message}`);
    return null;
  }
  return data || null;
}

// /newsletter_off — pause weekly delivery. Reversible via
// /newsletter_on. We do NOT delete the row so `last_sent_at` survives
// — a user who re-subscribes after a quiet month picks up where the
// schedule left off rather than getting flooded with backlog.
bot.command("newsletter_off", async (ctx) => {
  try {
    const { setNewsletterPaused } = require("../lib/newsletterService");
    await setNewsletterPaused(ctx.from.id, true);
    await ctx.reply(
      "👍 השבתתי את הניוזלטר השבועי. תוכלי להפעיל בחזרה עם /newsletter_on.",
    );
  } catch (err) {
    console.error("[Bot] /newsletter_off error:", err.message);
    await ctx.reply("⚠️ שגיאה בהשבתת הניוזלטר. אפשר לנסות שוב.");
  }
});

bot.command("newsletter_on", async (ctx) => {
  try {
    const { setNewsletterPaused } = require("../lib/newsletterService");
    await setNewsletterPaused(ctx.from.id, false);
    await ctx.reply(
      "👍 הפעלתי את הניוזלטר השבועי. תקבלי אותו ביום חמישי בערב.",
    );
  } catch (err) {
    console.error("[Bot] /newsletter_on error:", err.message);
    await ctx.reply("⚠️ שגיאה בהפעלת הניוזלטר. אפשר לנסות שוב.");
  }
});

// /newsletter_preview — user-facing manual trigger. Renders the
// CURRENT pending digest (everything since the user's last_sent_at)
// as if it were the Thursday delivery, but does NOT advance
// last_sent_at. Two outcomes the user might see:
//
//   - "ok" — N cards delivered, prefixed with a "👀 תצוגה מקדימה"
//            header so they know it's a preview, not the real
//            Thursday push.
//   - "empty" — nothing new since last delivery; we reply with a
//            friendly note instead of silently doing nothing.
//
// Unlike /newsletter_now (admin-only, advances state, used for
// QA-style "did the copy actually ship?" testing), this command
// is for any user who wants to see "what would arrive on Thursday".
// Safe to tap repeatedly.
bot.command("newsletter_preview", async (ctx) => {
  try {
    const { deliverPreview } = require("../lib/newsletterScheduler");
    // Prefix BEFORE the cards so the user understands the cards
    // below are a preview, not a "you missed Thursday" delivery.
    // We send this even when the digest turns out to be empty —
    // the follow-up "אין כרגע אירועים חדשים" message is enough
    // closure on its own, and the prefix sets the right
    // expectation immediately ("she heard me, working on it").
    await ctx.reply(
      "👀 תצוגה מקדימה של הניוזלטר — זה מה שהיית מקבלת ביום חמישי הקרוב:",
    );
    const result = await deliverPreview(bot, ctx.from.id);
    if (result.reason === "no_profile") {
      await ctx.reply(
        "⚠️ עוד אין לי פרופיל שלך — נסי /start כדי לפתוח את האשף.",
      );
      return;
    }
    if (result.reason === "renderer_unavailable") {
      // Shouldn't happen in practice — the scheduler boots at the
      // same time as the bot — but a clear error beats a silent
      // "she sent the header and nothing else" UX.
      await ctx.reply(
        "⚠️ שירות הניוזלטר עדיין מתעורר, נסי שוב בעוד רגע.",
      );
      return;
    }
    if (result.reason === "empty") {
      await ctx.reply(
        "📭 אין כרגע אירועים שמתאימים לפרופיל שלך בטווח הקרוב. " +
          "כשיתווספו חדשים — תקבלי אותם בניוזלטר או בתצוגה מקדימה.",
      );
      return;
    }
    // Success: cards already rendered by deliverPreview. Closing
    // toast confirms how many landed so the user can sanity-check
    // against the cards above (Telegram occasionally batches a
    // photo card and a text caption into the same screen tick
    // and the count anchors the meaning).
    await ctx.reply(
      `✅ זו תצוגה מקדימה בלבד — הניוזלטר האמיתי יישלח ביום חמישי כרגיל.`,
    );
  } catch (err) {
    console.error("[Bot] /newsletter_preview error:", err.stack || err.message);
    await ctx.reply("⚠️ שגיאה בהפעלת התצוגה. אפשר לנסות שוב.");
  }
});

// /connect_calendar — Phase E. Builds the Google OAuth URL with
// state=<telegram_id> and sends a one-button inline keyboard. The
// user taps the button → Google's consent screen → Google redirects
// to GOOGLE_OAUTH_REDIRECT_URI (handled by lib/oauthServer.js) → we
// persist the tokens and confirm back in this chat.
bot.command("connect_calendar", async (ctx) => {
  try {
    const { buildAuthUrl } = require("../lib/oauthServer");
    let url;
    try {
      url = buildAuthUrl(ctx.from.id);
    } catch (err) {
      // Missing env config — surface to user so they know the feature
      // isn't fully deployed yet, rather than failing silently.
      await ctx.reply(
        rtlLine(
          "⚠️ אינטגרציית Google Calendar עדיין לא הוגדרה בצד השרת.\n" +
            "צרי קשר עם המפתחת.",
        ),
      );
      console.warn(`[Bot] /connect_calendar config missing: ${err.message}`);
      return;
    }
    await ctx.reply(
      rtlLine(
        "📅 לחיבור Google Calendar — לחצי על הכפתור הבא, אשרי בחלון של Google, " +
          "ותחזרי לכאן בסיום.",
      ),
      {
        reply_markup: {
          inline_keyboard: [[{ text: "🔗 התחברות ל‑Google", url }]],
        },
      },
    );
  } catch (err) {
    console.error("[Bot] /connect_calendar error:", err.message);
    await ctx.reply("⚠️ שגיאה בהפעלת ההתחברות. אפשר לנסות שוב.");
  }
});

// /newsletter_now — admin-only manual trigger. Generates + delivers
// the digest to the caller immediately, bypassing the schedule. Used
// for testing copy + content quality without waiting for Thursday.
bot.command("newsletter_now", async (ctx) => {
  if (!ADMIN_CHAT_ID || String(ctx.from.id) !== String(ADMIN_CHAT_ID)) {
    return; // silent for non-admins
  }
  try {
    const { deliverOne } = require("../lib/newsletterScheduler");
    await ctx.reply("🛠 מפעילה ניוזלטר עכשיו...");
    await deliverOne(bot, ctx.from.id);
    await ctx.reply("✅ נשלח. ה‑last_sent_at עודכן בהתאם.");
  } catch (err) {
    console.error("[Bot] /newsletter_now error:", err.message);
    await ctx.reply(`⚠️ שגיאה: ${err.message}`);
  }
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

// (/watching command removed — watchlist lives in the Web App.)

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
        "1. כתבו קודם את ההודעה (טקסט, תמונה, כל מה שרוצים).\n" +
        "2. הגיבו לאותה הודעה עם הפקודה /broadcast.\n" +
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

    // Profile field capture (display name / home address).
    if (session?.pendingProfileField === "display_name") {
      const name = message.trim().slice(0, 40);
      if (name.length < 2) {
        await ctx.reply("נא שם של לפחות 2 תווים, או «↩️ חזרה» בכפתורים.");
        tracing.setOutput(traceId, "[profile_name_too_short]");
        return;
      }
      delete session.pendingProfileField;
      try {
        const existing = await getProfile(telegramId);
        await saveProfile(telegramId, { first_name: name }, existing);
        await ctx.reply(`✅ שמרתי: ${name}`);
        await showProfileView(ctx);
      } catch (err) {
        console.error("[Bot] profile name save:", err.message);
        await ctx.reply("⚠️ לא הצלחתי לשמור. נסי שוב.");
      }
      tracing.setOutput(traceId, "[profile_name_saved]");
      return;
    }

    if (session?.pendingProfileField === "home_address") {
      const addr = message.trim();
      if (!addr) {
        await ctx.reply("כתבי כתובת, או /profile לביטול.");
        tracing.setOutput(traceId, "[profile_address_empty]");
        return;
      }
      delete session.pendingProfileField;
      try {
        const existing = await getProfile(telegramId);
        const shape = existing ? profileToBrainShape(existing) : {};
        await saveProfile(
          telegramId,
          {
            constraints: {
              ...(shape.constraints || {}),
              home_address: addr,
            },
          },
          existing,
        );
        await ctx.reply("✅ שמרתי את כתובת הבית");
        await showProfileView(ctx);
      } catch (err) {
        console.error("[Bot] profile address save:", err.message);
        await ctx.reply("⚠️ לא הצלחתי לשמור. נסי שוב.");
      }
      tracing.setOutput(traceId, "[profile_address_saved]");
      return;
    }

    // Reply-keyboard quick actions (same as typing menu).
    const replyAction = resolveReplyAction(message);
    if (replyAction) {
      tracing.addStep(traceId, `reply_action:${replyAction}`);
      await dispatchMenuAction(ctx, replyAction);
      tracing.setOutput(traceId, `[reply_action:${replyAction}]`);
      return;
    }

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

    // ONBOARDING — when the user tapped "✏️ אחר..." on the location
    // step, the next text message is parsed as a number of minutes.
    // Handled BEFORE the agent path so it doesn't get interpreted as
    // a search query.
    const onbState = sessionStore.getOnboarding(telegramId);
    if (
      onbState &&
      (await handleOnboardingKidsText(ctx, message, sessionStore, {
        renderOnboardingStep,
        persistOnboardingState,
      }))
    ) {
      tracing.setOutput(traceId, "[onboarding_kids_text]");
      return;
    }

    if (onbState && onbState.step === "location_other") {
      const m = message.match(/(\d+)/); // first integer, anywhere
      const minutes = m ? parseInt(m[1], 10) : NaN;
      if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 240) {
        // Reject implausible input and re-ask. Cap at 240 (=4h walk)
        // because anything larger probably means the user wanted to
        // type a category name, not a number.
        await ctx.reply(
          "לא הצלחתי לפענח. יש לכתוב מספר בלבד — לדוגמה 20 (= עד 20 דקות הליכה).",
        );
        tracing.setOutput(traceId, "[onboarding_other_reject]");
        return;
      }
      onbState.location = {
        id: "other",
        label: `${minutes} דקות הליכה`,
        max_walking_minutes: minutes,
        preference: `מותאם — עד ${minutes} דק׳ הליכה`,
      };
      onbState.locationModes = new Set();
      sessionStore.updateOnboarding(telegramId, {
        location: onbState.location,
        locationModes: onbState.locationModes,
      });
      await persistOnboardingState(telegramId, onbState, { touchLocation: true });
      if (onbState.editReturn === "profile") {
        sessionStore.clearOnboarding(telegramId);
        await ctx.reply(`✅ ${onbState.location.preference}`);
        await showProfileView(ctx);
      } else {
        sessionStore.updateOnboarding(telegramId, { step: "summary" });
        const refreshed = sessionStore.getOnboarding(telegramId);
        await renderOnboardingStep(ctx, refreshed);
      }
      tracing.addStep(traceId, "onboarding_other_accepted");
      tracing.setOutput(traceId, "[onboarding_other_accepted]");
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
          const chip = getTopicByLabel(label);
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

    if (await handlePendingKidsCaptureText(ctx, message, sessionStore)) {
      tracing.setOutput(traceId, "[kids_capture]");
      return;
    }

    if (await handlePendingFeedbackKidWizardText(ctx, message, sessionStore)) {
      tracing.setOutput(traceId, "[fb_kid_wizard]");
      return;
    }

    if (await handlePendingFeedbackText(ctx, message, sessionStore)) {
      tracing.setOutput(traceId, "[feedback_other_db]");
      return;
    }

    if (!isAgentEnabled()) {
      const lastFilters = sessionStore.getLastSearchFilters(telegramId);
      const hasExtensionHint = !!sessionStore.getLastExtensionHint(telegramId);
      const { routeMessage } = require("../lib/searchRouter");
      const routed = routeMessage(message, { lastFilters, hasExtensionHint });
      if (routed.kind === "search" || routed.kind === "refine" || routed.kind === "extend") {
        tracing.addStep(traceId, `router_${routed.kind}`);
        await withLiveness(ctx, async ({ markResponded }) => {
          const agentCtx = buildAgentCtx(ctx, { traceId, markResponded });
          await runRouterTextTurn(telegramId, agentCtx, ctx, message);
        });
        tracing.setOutput(traceId, `[router_${routed.kind}]`);
        return;
      }
    }

    const onbForMenu = sessionStore.getOnboarding(telegramId);
    if (shouldShowTypingMenu({ session, message, onbState: onbForMenu })) {
      tracing.addStep(traceId, "typing_menu");
      await showMainMenu(ctx, { draftText: message });
      tracing.setOutput(traceId, "[typing_menu]");
      return;
    }

    if (!isAgentEnabled()) {
      await withLiveness(ctx, async ({ markResponded }) => {
        const agentCtx = buildAgentCtx(ctx, { traceId, markResponded });
        await runRouterTextTurn(telegramId, agentCtx, ctx, message);
      });
      tracing.setOutput(traceId, "[router_fallback]");
      return;
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
/** Message id of the inline-keyboard message the user tapped (callback context). */
function getCallbackSourceMessageId(ctx) {
  return ctx.callbackQuery?.message?.message_id || null;
}

function withReplyToMessageId(opts = {}, replyToMessageId = null) {
  if (!replyToMessageId) return opts;
  return {
    ...opts,
    reply_parameters: {
      message_id: replyToMessageId,
      allow_sending_without_reply: true,
      ...(opts.reply_parameters || {}),
    },
  };
}

function replyAsCallbackResult(ctx, text, opts = {}) {
  const replyToId = getCallbackSourceMessageId(ctx);
  if (!replyToId) return ctx.reply(text, opts);
  return ctx.reply(text, withReplyToMessageId(opts, replyToId));
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

  sessionStore.clearPendingClarification(telegramId);

  if (!isAgentEnabled()) {
    const profile = await getProfile(telegramId).catch(() => null);
    const gender = profile?.user_context?.gender || null;
    const pick = pickActionVerb(gender);
    const write = genderForm(gender, { f: "כתבי", m: "כתוב", n: "כתוב" });
    await ctx.reply(
      `הסוכן כבוי — ${pick} חיפוש מ-/search או ${write} «מוזיקה השבוע». לפרופיל: /profile`,
      searchMenuKeyboard(gender),
    );
    return;
  }

  sessionStore.appendUserMessage(telegramId, `[בחירה] ${opt.label} (value=${opt.value})`);

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
    header = "👥 *קהל יעד*\n";
    reply_markup = buildAudienceKeyboard(snapshot);
  } else if (view === PSE_VIEWS.AGES) {
    header = "🧒 *גילאים* (אפשר לבחור יותר מאחד)\n";
    reply_markup = buildAgesKeyboard(snapshot);
  } else if (view === PSE_VIEWS.PROXIMITY) {
    header = "📍 *מקום או מרחק*\n";
    reply_markup = buildProximityKeyboard(snapshot);
  } else if (view === PSE_VIEWS.DATES) {
    header = "📅 *טווח תאריכים*\n";
    reply_markup = buildDatesKeyboard(snapshot);
  } else if (view === PSE_VIEWS.TIMES) {
    header = "🕐 *טווח שעות*\n";
    reply_markup = buildTimesKeyboard(snapshot);
  } else if (view === PSE_VIEWS.TAGS) {
    snapshot._fieldEdit = { field: "tags" };
    header = buildFreeTextHeader({
      field: "תגיות לעקוב",
      current: (snapshot.filters?.watch_tag_names || []).join(", "),
      hint: "כתבו תגיות מופרדות בפסיק (לדוגמה: מוזיקה, סדנאות יצירה).",
    });
    reply_markup = buildFreeTextKeyboard("tags");
  } else if (view === PSE_VIEWS.VENUE) {
    snapshot._fieldEdit = { field: "venue" };
    header = buildFreeTextHeader({
      field: "מקום ספציפי",
      current: snapshot.filters?.location_label || snapshot.filters?.venue || "",
      hint: "כתבו שם של מקום (לדוגמה: מרכז פיס גאולים). ננסה לזהות אותו אוטומטית.",
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
      hint: "השאירו ריק במקרים רגילים. כתבו מילים רק אם חשוב שהמילה תופיע בשם האירוע (לדוגמה: יין).",
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
  await replyAsCallbackResult(ctx, "👍 לא שמרתי. אפשר לבקש מעקב שוב מתי שרוצים.");
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

  sessionStore.clearPendingClarification(telegramId);

  if (!isAgentEnabled()) {
    try {
      const mode = snapshot.filters?.date_to ? "one_time" : "recurring";
      let expiresAt = null;
      if (mode === "one_time" && snapshot.filters?.date_to) {
        expiresAt = new Date(`${snapshot.filters.date_to}T23:59:59+03:00`).toISOString();
      }
      await createSavedSearch(telegramId, {
        query: snapshot.query,
        tokens: snapshot.tokens,
        filters: snapshot.filters,
        tickets_needed: snapshot.tickets_needed,
        mode,
        expires_at: expiresAt,
      });
      sessionStore.clearPendingSave(telegramId);
      await replyAsCallbackResult(
        ctx,
        `✅ שמרתי מעקב: «${snapshot.query || "ללא כותרת"}»`,
      );
    } catch (err) {
      console.error("[Bot] pse:save (router) failed:", err.message);
      await replyAsCallbackResult(ctx, "⚠️ שגיאה בשמירת המעקב. אפשר לנסות שוב.");
    }
    return;
  }

  // CREATE path — synthesise the cue + resume the agent loop. The
  // agent's create_saved_search reads pendingSave and persists.
  sessionStore.appendUserMessage(telegramId, "[אישור שמירה] המשתמשת אישרה את החיפוש השמור.");

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

  sessionStore.clearPendingClarification(telegramId);

  if (!isAgentEnabled()) {
    const snapshot = session.pendingSave;
    try {
      const mode = snapshot.filters?.date_to ? "one_time" : "recurring";
      let expiresAt = null;
      if (mode === "one_time" && snapshot.filters?.date_to) {
        expiresAt = new Date(`${snapshot.filters.date_to}T23:59:59+03:00`).toISOString();
      }
      await createSavedSearch(telegramId, {
        query: snapshot.query,
        tokens: snapshot.tokens,
        filters: snapshot.filters,
        tickets_needed: snapshot.tickets_needed,
        mode,
        expires_at: expiresAt,
      });
      sessionStore.clearPendingSave(telegramId);
      await ctx.reply(`✅ שמרתי מעקב: «${snapshot.query || "ללא כותרת"}»`);
    } catch (err) {
      console.error("[Bot] ss:confirm (router) failed:", err.message);
      await ctx.reply("⚠️ שגיאה בשמירת המעקב.");
    }
    return;
  }

  sessionStore.appendUserMessage(telegramId, "[אישור שמירה] המשתמשת אישרה את החיפוש השמור.");

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
  await replyAsCallbackResult(ctx, "👍 לא שמרתי. אפשר לבקש מעקב שוב מתי שרוצים.");
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

// nav: callback handler removed — nav buttons are now direct URL
// buttons to Google Maps. The OS/browser handles app selection natively.

bot.action(/^wt:(\d+)(?::(\d+))?$/, async (ctx) => {
  const eventId = ctx.match[1];
  const presetNeeded = ctx.match[2] ? parseInt(ctx.match[2], 10) : null;
  // Ack the callback FIRST — addWatcher can hit Postgres latency
  // beyond the ~15s Telegram callback-query TTL, and once that
  // window closes the answerCbQuery call below throws "query is
  // too old". The user then sees a silent button with no toast,
  // even though we DID add their watcher. Ack-first keeps the UI
  // responsive (toast appears within ~50ms) regardless of how long
  // the actual side-effect takes.
  await safeAck(ctx, "🔔 רושמת...");
  console.log(
    `[Bot] wt: user=${ctx.from?.id} event=${eventId} preset=${presetNeeded ?? "—"}`,
  );
  try {
    if (presetNeeded && presetNeeded > 0) {
      await addWatcher(ctx.from.id, eventId, { ticketsNeeded: presetNeeded });
      await ctx.editMessageReplyMarkup({
        inline_keyboard: [[{ text: "🔕 בטל מעקב", callback_data: `unw:${eventId}` }]],
      });
      return;
    }
    await addWatcher(ctx.from.id, eventId);
    await replyAsCallbackResult(ctx, "🎫 כמה כרטיסים את צריכה לאירוע הזה?", {
      reply_markup: buildNeededKeyboard(eventId),
    });
  } catch (err) {
    console.error(`[Bot] wt error (event=${eventId}):`, err.stack || err.message);
    // Best-effort follow-up since the initial ack already showed
    // "🔔 רושמת..." — without this the user thinks it worked.
    await ctx.reply("⚠️ לא הצלחתי להוסיף למעקב — נסי שוב בעוד רגע").catch(() => {});
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
      .select("source, external_slug, external_url, online_url")
      .eq("id", eventId)
      .maybeSingle();
    const linkEvent = {
      id: eventId,
      source: row?.source,
      external_slug: row?.external_slug || null,
      external_url: row?.external_url || null,
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

const NOOP_TOASTS = {
  nomine: "אין כרגע מופעים מהסדרה שמתאימים לפרופיל שלך",
};
bot.action(/^noop:(.*)$/, async (ctx) => {
  const toast = NOOP_TOASTS[ctx.match[1]];
  await ctx.answerCbQuery(toast || undefined);
});

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
const {
  seriesKey,
  venueIdentity,
  filterOccurrencesByDateWindow,
  SERIES_EXPAND_PAGE_SIZE,
  SERIES_CARD_COUNT_CAP,
} = require("../lib/eventSeries");

function seriesSearchWindow(telegramId) {
  const f = sessionStore.getLastSearchFilters(telegramId) || {};
  const dateFrom = f.date_from || null;
  const dateTo = f.date_to || null;
  const windowLabel =
    dateFrom && dateTo ? describeWindowHe(dateFrom, dateTo) : null;
  return { dateFrom, dateTo, windowLabel };
}

function clipSeriesPayload(payload, dateFrom, dateTo) {
  if (!payload?.occurrences?.length || (!dateFrom && !dateTo)) return payload;
  const clipped = filterOccurrencesByDateWindow(
    payload.occurrences,
    dateFrom,
    dateTo,
  );
  if (!clipped.length) return payload;
  return { ...payload, occurrences: clipped };
}

async function resolveSeriesExpansionPayload(telegramId, seriesId) {
  const stored = sessionStore.getShownSeries(telegramId, seriesId);
  const dateFrom = stored?.date_from ?? seriesSearchWindow(telegramId).dateFrom;
  const dateTo = stored?.date_to ?? seriesSearchWindow(telegramId).dateTo;
  const windowLabel =
    stored?.window_label_he ??
    (dateFrom && dateTo ? describeWindowHe(dateFrom, dateTo) : null);

  let payload = stored;
  if (!payload?.occurrences?.length) {
    payload = await rebuildSeriesPayloadFromDb(seriesId, { dateFrom, dateTo });
  } else {
    payload = clipSeriesPayload(payload, dateFrom, dateTo);
  }
  if (payload && windowLabel) {
    payload = { ...payload, window_label_he: windowLabel };
  }
  return { payload, windowLabel };
}

async function deliverChunkedHtmlLines(ctx, lines) {
  const chunks = chunkRtlHtmlLines(lines);
  const replyToId = getCallbackSourceMessageId(ctx);
  for (let i = 0; i < chunks.length; i++) {
    const msgOpts = withReplyToMessageId(
      {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      },
      i === 0 ? replyToId : null,
    );
    if (i === 0 && replyToId) {
      await replyAsCallbackResult(ctx, chunks[i], msgOpts);
    } else if (replyToId) {
      await ctx.telegram.sendMessage(ctx.chat.id, chunks[i], msgOpts);
    } else {
      await ctx.reply(chunks[i], msgOpts);
    }
  }
}

function formatSeriesListCountLabel(total) {
  return total > SERIES_CARD_COUNT_CAP ? `${SERIES_CARD_COUNT_CAP}+` : String(total);
}

/** Same occurrence window as the card buttons (stored series + search dates). */
async function resolveSeriesPayloadForProfileActions(telegramId, seriesId) {
  const stored = sessionStore.getShownSeries(telegramId, seriesId);
  const dateFrom = stored?.date_from ?? seriesSearchWindow(telegramId).dateFrom;
  const dateTo = stored?.date_to ?? seriesSearchWindow(telegramId).dateTo;
  let payload = stored;
  if (!payload?.occurrences?.length) {
    payload = await rebuildSeriesPayloadFromDb(seriesId, { dateFrom, dateTo });
  } else {
    payload = clipSeriesPayload(payload, dateFrom, dateTo);
  }
  return { payload, dateFrom, dateTo };
}

async function profileMatchedSeriesFlats(telegramId, seriesId, profile) {
  const { payload } = await resolveSeriesPayloadForProfileActions(
    telegramId,
    seriesId,
  );
  const ids = (payload?.occurrences || [])
    .map((o) => o.id)
    .filter((id) => id != null);
  if (!ids.length) return { payload, flats: [], matched: [], total: 0 };
  const { data: rows, error } = await supabase
    .from("events")
    .select(SERIES_FILTER_SELECT)
    .in("id", ids);
  if (error || !rows?.length) {
    return { payload, flats: [], matched: [], total: 0 };
  }
  const seriesName = payload?.name || null;
  const flats = rows.map((r) =>
    flattenEvent({ ...r, name: r.name || seriesName }),
  );
  await expandLabels(flats);
  const { events: matched, total } = await filterAndRankForProfile(flats, profile, {
    annotateDistance: false,
  });
  return { payload, flats, matched, total };
}

/** Umbrella siblings filtered for profile — shared by button count + umb:me list. */
async function profileMatchedUmbrellaRows(slug, profile, { annotateDistance = false } = {}) {
  const { data: rows, error } = await fetchUmbrellaSiblingRows(slug);
  if (error || !rows?.length) {
    return { rows: [], matched: [], total: 0, proximityById: new Map() };
  }
  const flats = rows.map((r) => flattenEvent(r));
  await expandLabels(flats);
  const { events: matched, total } = await filterAndRankForProfile(flats, profile, {
    annotateDistance,
  });
  const order = new Map(matched.map((e, i) => [e.id, i]));
  const filteredRows = rows
    .filter((r) => order.has(r.id))
    .sort((a, b) => order.get(a.id) - order.get(b.id));
  const proximityById = annotateDistance
    ? new Map(matched.map((e) => [e.id, e._proximity]))
    : new Map();
  return { rows: filteredRows, matched, total, proximityById };
}

/** Profile-fit count for umbrella "בשבילי מהסדרה" — always live (matches umb:me). */
async function resolveUmbrellaProfileMatchCountForCard(ctx, slug) {
  const profile = await getCachedUserProfile(ctx);
  if (!profile || !slug) return 0;
  const { matched } = await profileMatchedUmbrellaRows(slug, profile);
  return matched.length;
}

/** Profile-fit count for "מופעים בשבילי" — same window + filter as seq:me. */
async function resolveSeriesProfileMatchCountForCard(ctx, seriesId) {
  const profile = await getCachedUserProfile(ctx);
  if (!profile) return 0;
  const { matched } = await profileMatchedSeriesFlats(
    ctx.from?.id,
    seriesId,
    profile,
  );
  return matched.length;
}

/** Build HTML lines for one page of a series occurrence list. */
function buildSeriesExpansionLines({
  payload,
  occsWithUrl,
  offset,
  botUsername,
  seriesId,
  headerMode = "all",
  profileMeta = null,
  enrichOcc = null,
  compact = false,
}) {
  const multiVenue = Boolean(payload.multiVenue);
  const cardHref = buildEventCardDeepLink(botUsername, seriesId);
  const nameEsc = escHtml(payload.name);
  const total = occsWithUrl.length;
  const page = occsWithUrl.slice(offset, offset + SERIES_EXPAND_PAGE_SIZE);
  const lines = [];

  if (headerMode === "profile" && profileMeta) {
    const { matched, total: profileTotal } = profileMeta;
    lines.push(
      cardHref
        ? `✨ ${matched} מתוך ${profileTotal} מתאימים לך — <a href="${escHtml(cardHref)}">${nameEsc}</a>`
        : `✨ ${matched} מתוך ${profileTotal} מתאימים לך — ${nameEsc}`,
    );
  } else {
    const countLabel = formatSeriesListCountLabel(total);
    lines.push(
      cardHref
        ? `📋 כל המופעים (${countLabel}) — <a href="${escHtml(cardHref)}">${nameEsc}</a>`
        : `📋 כל המופעים (${countLabel}) — ${nameEsc}`,
    );
  }
  if (!multiVenue && payload.location) lines.push(`📍 ${payload.location}`);
  if (total > SERIES_EXPAND_PAGE_SIZE) {
    const end = Math.min(offset + page.length, total);
    lines.push(
      escHtml(`מופעים ${offset + 1}–${end} מתוך ${total}`),
    );
  }
  lines.push("");

  for (const { occ } of page) {
    const dateStr = occ.date ? formatHebrewDate(occ.date) : "";
    const timeStr = formatTimeRange(occ.start_time, occ.end_time);
    const ticketsStr =
      occ.tickets_left === 0
        ? "🚫 אזל"
        : formatTicketsLine(occ.tickets_left) || "";
    const meta = [dateStr, timeStr].filter(Boolean).join(" — ");
    const metaEsc = escHtml(meta);
    // Each occurrence's date links to ITS OWN event card in the bot
    // (deep link), not the external booking site — the card has the
    // register button + full details.
    const occCardHref = buildEventCardDeepLink(botUsername, occ.id);
    const bullet = occCardHref
      ? `• <a href="${escHtml(occCardHref)}">${metaEsc}</a>`
      : `• ${metaEsc}`;
    lines.push(bullet);
    // Tickets on their OWN line (recurring series read cleaner this way).
    if (ticketsStr) lines.push(`   ${escHtml(ticketsStr)}`);
    if (typeof enrichOcc === "function") {
      for (const extra of enrichOcc(occ) || []) {
        if (extra) lines.push(extra);
      }
    }
    const audienceLine = formatAudienceLineForOccurrence(occ, {
      name: payload.name,
    });
    if (audienceLine) lines.push(`   ${escHtml(audienceLine)}`);
    if (multiVenue && occ.location) {
      lines.push(`   📍 ${escHtml(occ.location)}`);
    }
    if (!compact) {
      const readMoreHref = getMiniAppCatalogUrl()
        ? buildMiniAppReadMoreLink(botUsername, occ.id)
        : buildReadMoreDeepLink(botUsername, occ.id);
      const descLine = formatDescriptionForCard(occ.description, {
        readMoreHref,
        escapeHtml: escHtml,
      });
      if (descLine) lines.push(`   📝 ${descLine}`);
    }
  }

  const remaining = total - offset - page.length;
  if (remaining > 0) {
    const windowSuffix = payload.window_label_he || " בטווח";
    lines.push("");
    lines.push(escHtml(`… ועוד ${remaining} מופעים${windowSuffix}`));
  }
  return { lines, remaining, pageSize: page.length };
}

async function deliverSeriesExpansionPage(ctx, seriesId, offset, {
  payload,
  headerMode = "all",
  profileMeta = null,
  enrichOcc = null,
  compact = false,
} = {}) {
  let botUsername = null;
  try {
    botUsername = await referralService.getBotUsername(ctx.telegram);
  } catch {
    /* inline read-more omitted */
  }
  // When the caller didn't supply its own per-occurrence enrichment
  // (seq:me does, for the profile-matched list), annotate each occurrence
  // on THIS page with the travel time from the user's home — so "כל
  // המופעים" shows the distance per date just like "מופעים בשבילי".
  let effectiveEnrichOcc = enrichOcc;
  if (!effectiveEnrichOcc) {
    const profile = await getProfile(ctx.from.id).catch(() => null);
    const home = profile?.user_context?.constraints?.home_coordinates;
    if (home?.lat != null && home?.lng != null) {
      const pageOccs = payload.occurrences.slice(
        offset,
        offset + SERIES_EXPAND_PAGE_SIZE,
      );
      const probes = pageOccs.map((o) => ({
        id: o.id,
        location: o.location || null,
        _coords:
          o.lat != null && o.lng != null ? { lat: o.lat, lng: o.lng } : null,
      }));
      await annotateProximity(probes, profile);
      const labelById = new Map(
        probes
          .filter((p) => p._proximity?.label)
          .map((p) => [p.id, p._proximity.label]),
      );
      if (labelById.size) {
        effectiveEnrichOcc = (occ) => {
          const label = labelById.get(occ.id);
          return label ? [`   ${escHtml(label)}`] : [];
        };
      }
    }
  }
  // Occurrence date-links now point at each occurrence's bot card (deep
  // link), not the external booking URL — so we no longer resolve
  // getBookingUrl here.
  const occsWithUrl = payload.occurrences.map((occ) => ({ occ }));
  const { lines, remaining } = buildSeriesExpansionLines({
    payload,
    occsWithUrl,
    offset,
    botUsername,
    seriesId,
    headerMode,
    profileMeta,
    enrichOcc: effectiveEnrichOcc,
    compact: compact || occsWithUrl.length > 15,
  });
  await deliverChunkedHtmlLines(ctx, lines);
  if (remaining > 0) {
    const nextOffset = offset + SERIES_EXPAND_PAGE_SIZE;
    const nextBatch = Math.min(remaining, SERIES_EXPAND_PAGE_SIZE);
    await ctx.reply(
      rtlLine("לחצי להמשך הרשימה ⬇️"),
      Markup.inlineKeyboard([
        [
          Markup.button.callback(
            `📋 הצג עוד ${nextBatch} מופעים`,
            `seq:pg:${seriesId}:${nextOffset}`,
          ),
        ],
      ]),
    );
  }
}

async function rebuildSeriesPayloadFromDb(seriesId, { dateFrom = null, dateTo = null } = {}) {
  const supabase = require("../lib/supabase");

  // 1. Load the representative event to capture the series fingerprint.
  //    location_key joins through to the human-readable address for the
  //    output header. lat/lng come along so the multi-venue bucketing
  //    below can compare by physical place identity, not text label
  //    (see venueIdentity for why).
  const { data: rep, error: repErr } = await supabase
    .from("events")
    .select(
      "id, source, external_slug, external_url, online_url, name, location_key, min_months, max_months, audience, " +
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
  const rangeFrom = dateFrom && dateFrom > today ? dateFrom : today;
  let occQuery = supabase
    .from("events")
    .select(
      "id, source, external_slug, external_url, online_url, name, date, start_time, end_time, " +
        "tickets_left, description, location_key, min_months, max_months, audience, " +
        // Per-occurrence venue join. lat/lng/found feed `venueIdentity`
        // so two rows that resolved the same physical place from
        // different `raw_address` strings still collapse into one
        // bucket — without this the seq handler would say "מתקיים
        // במופע" for what is actually one venue (event 3489).
        "locations:location_key(raw_address, lat, lng, found)"
    )
    .eq("name", rep.name)
    .eq("archived", false)
    .gte("date", rangeFrom)
    .order("date", { ascending: true });
  if (dateTo) occQuery = occQuery.lte("date", dateTo);
  const { data: rows, error: occErr } = await occQuery;
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
      name: r.name ?? rep.name,
      source: r.source,
      external_slug: r.external_slug ?? null,
      external_url: r.external_url ?? null,
      date: r.date,
      start_time: r.start_time,
      end_time: r.end_time,
      tickets_left: r.tickets_left,
      // Per-occurrence prose blurb (sql/053). Populated only for city
      // children whose external_url is NULL (the only case where the
      // local description is the user's sole info source). Surfaced
      // by the seq: handler below as a third line per row so that two
      // rows with identical title/time/venue (umbrella siblings under
      // the same name) still differ visibly in the listing.
      description: r.description ?? null,
      min_months: r.min_months ?? null,
      max_months: r.max_months ?? null,
      audience: r.audience ?? null,
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

// "קרא עוד" — re-send the full event card with the complete description.
bot.action(/^ev:more:(\d+)$/, async (ctx) => {
  const eventId = parseInt(ctx.match[1], 10);
  try {
    await ctx.answerCbQuery().catch(() => {});
    let event =
      sessionStore.getLastSearchHits(ctx.from.id).find((e) => e.id === eventId) ||
      null;
    if (!event) event = await getEventById(eventId);
    if (!event) {
      await replyAsCallbackResult(ctx, "לא מצאתי את האירוע — אפשר לחפש שוב.");
      return;
    }
    // Mirror the original card EXACTLY: reuse the profile-fit verdict we
    // stored when the card was first rendered (recomputing here risked a
    // different result on a leaner event object).
    await sendEventCard(ctx, event, {
      fullDescription: true,
      replyToMessageId: getCallbackSourceMessageId(ctx),
      ...generalSearchCardFlags(ctx.from.id, eventId),
    });
  } catch (err) {
    console.error("[Bot] ev:more error:", err.message);
    try {
      await ctx.answerCbQuery("⚠️ שגיאה");
    } catch {}
  }
});

const SERIES_FILTER_SELECT =
  "id, source, external_slug, external_url, name, date, start_time, end_time, tickets_left, description, min_months, max_months, audience, tag_ids, access, category, location_key, locations:location_key(raw_address, lat, lng, found)";

bot.action(/^seq:me:(\d+)$/, async (ctx) => {
  const seriesId = parseInt(ctx.match[1], 10);
  try {
    const profile = await getProfile(ctx.from.id).catch(() => null);
    const { payload, matched, total } = await profileMatchedSeriesFlats(
      ctx.from.id,
      seriesId,
      profile,
    );
    if (!payload?.occurrences?.length) {
      await safeAck(ctx, "המופעים פגו, חיפשי שוב 🙏", { show_alert: true });
      return;
    }
    if (!matched.length) {
      await safeAck(ctx, "אין כרגע מופעים בסדרה שמתאימים לפרופיל שלך 🙏", {
        show_alert: true,
      });
      return;
    }
    const matchedById = new Map(matched.map((e) => [e.id, e]));
    await annotateProximity([...matchedById.values()], profile);
    // The profile filter used a CRUDE distance estimate; now that
    // annotateProximity gave us the accurate drive/walk time, drop any
    // occurrence that actually exceeds the user's limit — otherwise a
    // "13 דק נסיעה" event slips past a ≤10-min preference and then shows
    // its real distance, contradicting the filter.
    const { eventPassesLocationModes, getLocationModes } = require("../lib/locationPrefs");
    const locConstraints = profile?.user_context?.constraints || {};
    const locModes = getLocationModes(locConstraints);
    const locHome = locConstraints.home_coordinates;
    let okMatched = matched;
    if (locHome?.lat != null && locModes.length && !locModes.includes("any")) {
      okMatched = matched.filter((e) => {
        const prox = matchedById.get(e.id)?._proximity;
        return !prox || eventPassesLocationModes(prox, locConstraints);
      });
    }
    if (!okMatched.length) {
      await safeAck(ctx, "אין כרגע מופעים בסדרה שמתאימים לפרופיל שלך 🙏", {
        show_alert: true,
      });
      return;
    }
    await safeAck(ctx, "✨ שלחתי את המופעים המתאימים לך למטה ⬇️");
    const order = new Map(okMatched.map((e, i) => [e.id, i]));
    const matchedOccs = payload.occurrences
      .filter((o) => order.has(o.id))
      .sort((a, b) => order.get(a.id) - order.get(b.id));
    await deliverSeriesExpansionPage(ctx, seriesId, 0, {
      payload: { ...payload, occurrences: matchedOccs },
      headerMode: "profile",
      profileMeta: { matched: okMatched.length, total },
      enrichOcc: (occ) => {
        const flat = matchedById.get(occ.id);
        return flat?._proximity?.label
          ? [`   ${escHtml(flat._proximity.label)}`]
          : [];
      },
    });
  } catch (err) {
    if (isStaleCallbackQuery(err)) {
      console.warn(`[Bot] seq:me stale ack (user ${ctx.from?.id || "?"}): ${err.message}`);
      return;
    }
    console.error("[Bot] seq:me error:", err.message);
    try { await safeAck(ctx, "⚠️ שגיאה"); } catch {}
  }
});

bot.action(/^seq:pg:(\d+):(\d+)$/, async (ctx) => {
  const seriesId = parseInt(ctx.match[1], 10);
  const offset = parseInt(ctx.match[2], 10);
  try {
    await ctx.answerCbQuery().catch(() => {});
    const { payload } = await resolveSeriesExpansionPayload(ctx.from.id, seriesId);
    if (!payload?.occurrences?.length) {
      await ctx.reply("המופעים פגו, חיפשי שוב 🙏");
      return;
    }
    await deliverSeriesExpansionPage(ctx, seriesId, offset, { payload });
  } catch (err) {
    console.error("[Bot] seq:pg error:", err.message);
    try { await ctx.answerCbQuery("⚠️ שגיאה"); } catch {}
  }
});

bot.action(/^seq:(\d+)$/, async (ctx) => {
  const seriesId = parseInt(ctx.match[1], 10);
  try {
    const { payload } = await resolveSeriesExpansionPayload(ctx.from.id, seriesId);
    if (!payload || payload.occurrences.length === 0) {
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
    await safeAck(ctx, "📋 שלחתי לך את כל המופעים למטה ⬇️");
    await deliverSeriesExpansionPage(ctx, seriesId, 0, { payload });
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


/** Series/umbrella opts for `ev_<id>` deep-links — same card as ungrouped search. */
async function cardSendOptsForEvent(telegramId, event) {
  if (!event?.id) return {};
  if (event.umbrella_slug) {
    const { data: rows } = await fetchUmbrellaSiblingRows(event.umbrella_slug);
    const n = rows?.length || 0;
    if (n <= 1) return {};
    let seriesProfileMatchCount = 0;
    const profile = await getProfile(telegramId).catch(() => null);
    if (profile) {
      const flats = (rows || []).map((r) => flattenEvent(r));
      await expandLabels(flats);
      seriesProfileMatchCount = await countProfileMatches(flats, profile);
    }
    return { seriesOccurrenceCount: n, seriesProfileMatchCount };
  }
  const { dateFrom, dateTo, windowLabel } = seriesSearchWindow(telegramId);
  let payload = sessionStore.getShownSeries(telegramId, event.id);
  if (!payload?.occurrences?.length) {
    payload = await rebuildSeriesPayloadFromDb(event.id, { dateFrom, dateTo });
  } else {
    payload = clipSeriesPayload(payload, dateFrom, dateTo);
  }
  const n = payload?.occurrences?.length || 0;
  if (n <= 1) return {};
  let seriesProfileMatchCount = 0;
  const profile = await getProfile(telegramId).catch(() => null);
  if (profile && payload.occurrences?.length) {
    const ids = payload.occurrences.map((o) => o.id).filter((id) => id != null);
    if (ids.length) {
      const { data: rows } = await supabase
        .from("events")
        .select(SERIES_FILTER_SELECT)
        .in("id", ids);
      if (rows?.length) {
        const flats = rows.map((r) =>
          flattenEvent({ ...r, name: r.name || payload.name }),
        );
        await expandLabels(flats);
        seriesProfileMatchCount = await countProfileMatches(flats, profile);
      }
    }
  }
  return {
    seriesOccurrenceCount: n,
    seriesMultiVenue: Boolean(payload.multiVenue),
    seriesProfileMatchCount,
  };
}

/** Build chunked HTML body for umbrella sibling list (all or profile-filtered). */
async function buildUmbrellaExpansionPayload(slug, rows, {
  profileFiltered = false,
  matchedCount = 0,
  totalCount = 0,
  proximityById = null,
  interestHighlight = [],
  botUsername = null,
  profile = null,
} = {}) {
  const umbrellaTitle = rows[0]?.umbrella_title || slug;
  const allTagIds = new Set();
  for (const r of rows) for (const id of r.tag_ids || []) allTagIds.add(id);
  const tagDict = await require("../lib/labelStore").fetchLabelDict([...allTagIds]);

  const occs = rows.map((row) => {
    const occ = flattenEvent(row);
    const prox = proximityById?.get(occ.id);
    if (prox) occ._proximity = prox;
    return occ;
  });

  const umbrellaTitleEsc = escHtml(umbrellaTitle);
  const lines = [];
  const totalLabel = formatSeriesListCountLabel(rows.length);
  // Grouped-list title → bot card for the search representative (soonest row),
  // not the external booking / city parent page.
  const representativeId = rows[0]?.id ?? null;
  const cardHref = buildEventCardDeepLink(botUsername, representativeId);
  if (profileFiltered) {
    const headerText = `✨ ${matchedCount} מתוך ${totalCount} מתאימים לך — ${umbrellaTitleEsc}`;
    if (cardHref) {
      lines.push(`<a href="${escHtml(cardHref)}">${headerText}</a>`);
    } else {
      lines.push(headerText);
    }
  } else if (cardHref) {
    lines.push(
      `📋 כל אירועי (${totalLabel}) — <a href="${escHtml(cardHref)}">${umbrellaTitleEsc}</a>`,
    );
  } else {
    lines.push(`📋 כל אירועי (${totalLabel}) — ${umbrellaTitleEsc}`);
  }
  lines.push("");

  function resolveChildTitle(occ) {
    const n = (occ.name || "").trim();
    if (!n || n === umbrellaTitle) return "";
    return n;
  }

  for (let i = 0; i < occs.length; i++) {
    const occ = occs[i];
    if (i > 0) lines.push("");

    const tagsForRow = (occ.tag_ids || [])
      .map((id) => tagDict.get(id)?.name)
      .filter(Boolean);
    const iconEventShape = {
      name: occ.name,
      tags: tagsForRow,
      description: occ.description || null,
      category: occ.category || null,
    };
    const icon = getEventIcon(iconEventShape);
    const childTitle = resolveChildTitle(occ);
    const titleText = childTitle || umbrellaTitle;
    const titleEsc = escHtml(titleText);
    const childCardHref = buildEventCardDeepLink(botUsername, occ.id);
    lines.push(
      childCardHref
        ? `${icon} <b><a href="${escHtml(childCardHref)}">${titleEsc}</a></b>`
        : `${icon} <b>${titleEsc}</b>`,
    );

    if (occ.date) lines.push(`📅 ${escHtml(formatHebrewDate(occ.date))}`);
    const timeStr = formatTimeRange(occ.start_time, occ.end_time);
    if (timeStr) lines.push(`🕐 ${escHtml(timeStr)}`);
    const audienceLine = formatAudienceLineForOccurrence(occ, {
      name: umbrellaTitle,
      description: rows[0]?.description || occ.description,
    });
    if (audienceLine) lines.push(escHtml(audienceLine));
    if (occ._proximity?.label) lines.push(escHtml(occ._proximity.label));
    const venue = occ.location || "";
    const navUrl = buildLocationNavUrl(occ, navOptsFromProfile(profile, occ));
    if (venue && navUrl) {
      lines.push(`📍 <a href="${escHtml(navUrl)}">${escHtml(venue)}</a>`);
    } else if (venue) {
      lines.push(`📍 ${escHtml(venue)}`);
    }
    const ticketsLine =
      occ.tickets_left === 0
        ? "🚫 אזלו הכרטיסים"
        : formatTicketsLine(occ.tickets_left);
    if (ticketsLine) lines.push(escHtml(ticketsLine));
    const readMoreHref = getMiniAppCatalogUrl()
      ? buildMiniAppReadMoreLink(botUsername, occ.id)
      : buildReadMoreDeepLink(botUsername, occ.id);
    const descLine = formatDescriptionForCard(occ.description, {
      readMoreHref,
      escapeHtml: escHtml,
    });
    if (descLine) lines.push(`📝 ${descLine}`);
    if (tagsForRow.length) {
      const { filterTagsForDisplay } = require("../lib/tagSuppressPrefs");
      const displayTags = filterTagsForDisplay(tagsForRow, profile);
      const tagLine = formatTagLine(displayTags, {
        highlight: interestHighlight,
        searchHits: [],
      });
      if (tagLine) lines.push(escHtml(tagLine));
    }
  }

  return { chunks: chunkRtlHtmlLines(lines) };
}

async function deliverUmbrellaExpansion(ctx, payload) {
  const { chunks } = payload;
  const replyToId = getCallbackSourceMessageId(ctx);
  for (let i = 0; i < chunks.length; i++) {
    const umbOpts = withReplyToMessageId(
      {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      },
      replyToId,
    );
    if (i === 0 && replyToId) {
      await replyAsCallbackResult(ctx, chunks[i], umbOpts);
    } else if (replyToId) {
      await ctx.telegram.sendMessage(ctx.chat.id, chunks[i], umbOpts);
    } else {
      await ctx.reply(chunks[i], umbOpts);
    }
  }
}

// Open an event card from umbrella inline buttons (no /start deep link).
bot.action(/^evcard:(\d+)$/, async (ctx) => {
  const eventId = parseInt(ctx.match[1], 10);
  if (!Number.isFinite(eventId)) {
    await safeAck(ctx, "⚠️ מזהה לא תקין");
    return;
  }
  try {
    await safeAck(ctx);
    let event =
      sessionStore.getLastSearchHits(ctx.from.id).find((e) => e.id === eventId) ||
      null;
    if (!event) event = await getEventById(eventId);
    if (!event) {
      await ctx.reply("⚠️ האירוע לא נמצא");
      return;
    }
    const seriesOpts = await cardSendOptsForEvent(ctx.from.id, event);
    await sendEventCard(ctx, event, seriesOpts);
  } catch (err) {
    console.error("[Bot] evcard error:", err.message);
    try {
      await ctx.reply("⚠️ שגיאה בפתיחת הכרטיס");
    } catch {}
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Umbrella expansion — "📋 כל אירועי <umbrella>" button
// ──────────────────────────────────────────────────────────────────────────
//
// Companion to the `seq:` handler above, with a different grouping
// concept: instead of "all dates of the same recurring event", this
// shows "all sibling events in the umbrella programme". Triggered by
// the umb:<slug> callback that the card keyboard renders when
// `event.umbrella_slug` is populated (sql/054).
//
// Why a separate handler from seq:
//   - seq groups by series fingerprint (name + age range), excluding
//     location_key. Two rows with the same name = one series.
//   - umb groups by umbrella_slug, regardless of name. The Shavuot
//     umbrella has 27 children with 27 different names — seq would
//     give each its own card, umb collapses them under one heading.
//
// Lookup goes straight to Postgres (no session cache): the umbrella
// relationship is small enough to query on demand (typically 5-30
// rows per umbrella), and rebuilding from a synthetic-slug child is
// awkward anyway since the parent row was deleted at scrape time.
bot.action(/^umb:me:(.+)$/, async (ctx) => {
  const slug = ctx.match[1];
  try {
    const profile = await getProfile(ctx.from.id).catch(() => null);
    const { rows: filteredRows, matched, total, proximityById } =
      await profileMatchedUmbrellaRows(slug, profile, { annotateDistance: true });
    if (!filteredRows.length && !matched.length) {
      const { data: allRows, error } = await fetchUmbrellaSiblingRows(slug);
      if (error) {
        console.error(`[Bot] umb:me fetch failed for slug=${slug}: ${error.message}`);
        await safeAck(ctx, "⚠️ שגיאה בטעינה", { show_alert: true });
        return;
      }
      if (!allRows?.length) {
        await safeAck(ctx, "אין כרגע אירועים פעילים בקטגוריה הזו 🙏", { show_alert: true });
        return;
      }
      await safeAck(ctx, "אין כרגע אירועים בסדרה שמתאימים לפרופיל שלך 🙏", {
        show_alert: true,
      });
      return;
    }
    await safeAck(ctx, "✨ שלחתי את המתאימים לך למטה ⬇️");
    let botUsername = null;
    try {
      botUsername = await referralService.getBotUsername(ctx.telegram);
    } catch {
      /* inline read-more omitted */
    }
    const interests = (profile?.user_context?.interests || []).filter(Boolean);
    const payload = await buildUmbrellaExpansionPayload(slug, filteredRows, {
      profileFiltered: true,
      matchedCount: matched.length,
      totalCount: total,
      proximityById,
      interestHighlight: interests,
      botUsername,
      profile,
    });
    await deliverUmbrellaExpansion(ctx, payload);
  } catch (err) {
    if (isStaleCallbackQuery(err)) {
      console.warn(`[Bot] umb:me stale ack (user ${ctx.from?.id || "?"}): ${err.message}`);
      return;
    }
    console.error("[Bot] umb:me error:", err.stack || err.message);
    try { await safeAck(ctx, "⚠️ שגיאה"); } catch {}
  }
});

bot.action(/^umb:(?!me:)(.+)$/, async (ctx) => {
  const slug = ctx.match[1];
  try {
    const { data: rows, error } = await fetchUmbrellaSiblingRows(slug);
    if (error) {
      console.error(`[Bot] umb fetch failed for slug=${slug}: ${error.message}`);
      await safeAck(ctx, "⚠️ שגיאה בטעינה", { show_alert: true });
      return;
    }
    if (!rows?.length) {
      await safeAck(ctx, "אין כרגע אירועים פעילים בקטגוריה הזו 🙏", {
        show_alert: true,
      });
      return;
    }
    await safeAck(ctx, "📋 שלחתי לך את כל האירועים למטה ⬇️");
    let botUsername = null;
    try {
      botUsername = await referralService.getBotUsername(ctx.telegram);
    } catch {
      /* inline read-more omitted */
    }
    const flats = rows.map((r) => flattenEvent(r));
    await expandLabels(flats);
    let proximityById = null;
    const profile = await getProfile(ctx.from.id).catch(() => null);
    if (profile) {
      await annotateProximity(flats, profile);
      proximityById = new Map(
        flats.filter((e) => e._proximity).map((e) => [e.id, e._proximity]),
      );
    }
    const payload = await buildUmbrellaExpansionPayload(slug, rows, {
      botUsername,
      proximityById,
      profile,
    });
    await deliverUmbrellaExpansion(ctx, payload);
  } catch (err) {
    if (isStaleCallbackQuery(err)) {
      console.warn(`[Bot] umb stale ack (user ${ctx.from?.id || "?"}): ${err.message}`);
      return;
    }
    console.error("[Bot] umb error:", err.stack || err.message);
    try { await safeAck(ctx, "⚠️ שגיאה"); } catch {}
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Deterministic search router (`rtr:*`) — when AGENT_ENABLED=false
// ──────────────────────────────────────────────────────────────────────────
bot.action(/^rtr:(.+)$/, async (ctx) => {
  const telegramId = ctx.from.id;
  const action = ctx.match[1];
  const {
    applyDraftToggle,
    applyLegacyRouterAction,
    draftToFilters,
    emptyDraft,
    editSearchDraftHub,
    openSearchDraftHub,
  } = require("../lib/searchDraftPicker");

  try {
    const agentCtx = buildAgentCtx(ctx, {});
    const profile = await getProfile(telegramId).catch(() => null);
    const gender = profile?.user_context?.gender || null;

    if (action === "menu") {
      await ctx.answerCbQuery().catch(() => {});
      await openSearchDraftHub(ctx, sessionStore);
      return;
    }
    if (action === "save") {
      await ctx.answerCbQuery().catch(() => {});
      await startSaveFromLastSearch(telegramId, agentCtx);
      return;
    }
    if (action === "profile" || action === "profile_hint") {
      await ctx.answerCbQuery().catch(() => {});
      await showProfileView(ctx);
      return;
    }
    if (action === "go" || action === "go:all") {
      const state = sessionStore.getSearchDraft(telegramId);
      const filters = draftToFilters(state?.draft);
      if (!filters) {
        const pick = pickActionVerb(gender);
        await ctx.answerCbQuery(
          `${pick} לפחות מסנן אחד (תאריך, נושא, קהל…)`,
          { show_alert: true },
        ).catch(() => {});
        return;
      }
      // "🔍 חיפוש" = general (ignore the profile); "✨ חיפוש בשבילי" =
      // profile-aware.
      const general = action === "go:all";
      if (general) filters.ignore_profile = true;
      await ctx.answerCbQuery(general ? "מחפש בכל מה שיש…" : "מחפש בשבילך…").catch(() => {});
      await runSearchWithFilters(telegramId, agentCtx, filters);
      return;
    }
    if (action === "clear") {
      await ctx.answerCbQuery().catch(() => {});
      sessionStore.updateSearchDraft(telegramId, { draft: emptyDraft() });
      await editSearchDraftHub(ctx, sessionStore);
      return;
    }
    if (action.startsWith("tog:")) {
      let state = sessionStore.getSearchDraft(telegramId);
      if (!state) {
        await ctx.answerCbQuery().catch(() => {});
        await openSearchDraftHub(ctx, sessionStore);
        state = sessionStore.getSearchDraft(telegramId);
      }
      const nextDraft = applyDraftToggle(state.draft, action.slice(4));
      sessionStore.updateSearchDraft(telegramId, { draft: nextDraft });
      await ctx.answerCbQuery().catch(() => {});
      await editSearchDraftHub(ctx, sessionStore);
      return;
    }
    if (action.startsWith("runref:")) {
      await ctx.answerCbQuery().catch(() => {});
      await runRouterPreset(telegramId, agentCtx, ctx, action.slice(7));
      return;
    }
    // "חיפוש כללי" / "בשבילי" — re-run the last search toggling whether
    // the profile narrows the results.
    if (action === "scope:all" || action === "scope:me") {
      const all = action === "scope:all";
      await ctx.answerCbQuery(all ? "מחפש בכל מה שיש…" : "מחפש בשבילך…").catch(() => {});
      const last = sessionStore.getLastSearchFilters(telegramId);
      if (!last) {
        const retry = tryAgainVerb(gender);
        await ctx.reply(
          `אין חיפוש אחרון — ${retry} חיפוש חדש.`,
          searchMenuKeyboard(gender),
        );
        return;
      }
      await runSearchWithFilters(telegramId, agentCtx, {
        ...last,
        ignore_profile: all,
      });
      return;
    }
    if (action === "extend") {
      await ctx.answerCbQuery().catch(() => {});
      const hint = sessionStore.getLastExtensionHint(telegramId);
      const last = sessionStore.getLastSearchFilters(telegramId) || {};
      if (!hint?.suggested_date_to) {
        const retry = tryAgainVerb(gender);
        await ctx.reply(
          `אין הרחבה פעילה — ${retry} חיפוש חדש.`,
          searchMenuKeyboard(gender),
        );
        return;
      }
      const { weekRangeIL, todayISO } = require("../lib/timeContext");
      const filters = { ...last, date_to: hint.suggested_date_to };
      delete filters.date_preset;
      if (!filters.date_from) {
        if (last.date_preset === "this_week") {
          filters.date_from = weekRangeIL().startISO;
        } else {
          filters.date_from = todayISO();
        }
      }
      await runSearchWithFilters(telegramId, agentCtx, filters);
      return;
    }
    // Legacy keyboards (single-tap) — toggle draft, don't search until «חיפוש».
    if (
      action.startsWith("preset:") ||
      action.startsWith("refine:") ||
      action.startsWith("tag:") ||
      action.startsWith("kw:") ||
      action.startsWith("aud:") ||
      action.startsWith("act:")
    ) {
      let state = sessionStore.getSearchDraft(telegramId);
      if (!state) {
        await ctx.answerCbQuery().catch(() => {});
        await openSearchDraftHub(ctx, sessionStore);
        state = sessionStore.getSearchDraft(telegramId);
      }
      const nextDraft = applyLegacyRouterAction(state.draft, action);
      sessionStore.updateSearchDraft(telegramId, { draft: nextDraft });
      await ctx.answerCbQuery().catch(() => {});
      await editSearchDraftHub(ctx, sessionStore);
      return;
    }

    await ctx.answerCbQuery().catch(() => {});
  } catch (err) {
    console.error("[Bot] rtr callback failed:", err.message);
    try {
      const p = await getProfile(telegramId).catch(() => null);
      const retry = tryAgainVerb(p?.user_context?.gender);
      await ctx.reply(`⚠️ משהו נתקע בחיפוש — ${retry} שוב או /search`);
    } catch {}
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
      await safeAck(ctx, "החיפוש הזה כבר לא בתוקף — כתבו לי מה לחפש 🙏", { show_alert: true });
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
    const profileForCards = await getProfile(telegramId).catch(() => null);
    const renderedIds = [];
    for (const s of series) {
      const event = s.representative;
      if (!event) continue;
      try {
        const venueBuckets = new Set();
        for (const o of s.occurrences) venueBuckets.add(venueIdentity(o));
        const multiVenue = venueBuckets.size > 1;
        const { dateFrom, dateTo, windowLabel } = seriesSearchWindow(telegramId);
        const inWindow = filterOccurrencesByDateWindow(
          s.occurrences,
          dateFrom,
          dateTo,
        );
        const seriesOccs = inWindow.length ? inWindow : s.occurrences;
        let cardOccCount = Math.max(seriesOccs.length, 1);
        let seriesProfileMatchCount = 0;
        if (event.umbrella_slug) {
          const { data: umbRows } = await fetchUmbrellaSiblingRows(event.umbrella_slug);
          const umbN = umbRows?.length || 0;
          if (umbN > cardOccCount) cardOccCount = umbN;
          if (umbRows?.length && profileForCards) {
            const flats = umbRows.map((r) => flattenEvent(r));
            await expandLabels(flats);
            seriesProfileMatchCount = await countProfileMatches(flats, profileForCards);
          }
        } else if (seriesOccs.length > 0 && profileForCards) {
          seriesProfileMatchCount = await countProfileMatches(
            seriesOccs,
            profileForCards,
          );
        }

        if (seriesOccs.length > 1) {
          sessionStore.rememberShownSeries(telegramId, event.id, {
            name: event.name,
            location: event.location,
            location_key: event.location_key,
            multiVenue,
            date_from: dateFrom,
            date_to: dateTo,
            window_label_he: windowLabel || null,
            occurrences: seriesOccs.map((o) => ({
              id: o.id,
              name: o.name ?? event.name,
              source: o.source,
              external_slug: o.external_slug ?? null,
              external_url: o.external_url ?? null,
              date: o.date,
              start_time: o.start_time,
              end_time: o.end_time,
              tickets_left: o.tickets_left,
              description: o.description ?? null,
              min_months: o.min_months ?? null,
              max_months: o.max_months ?? null,
              audience: o.audience ?? null,
              location: o.location ?? null,
              location_key: o.location_key ?? null,
              lat: o._coords?.lat ?? null,
              lng: o._coords?.lng ?? null,
            })),
          });
        }
        // NB: do NOT reply-to the tapped message here. The button lives
        // on the "יש עוד N — להראות?" prompt, so threading each card as a
        // reply made every new card quote that prompt text. Send plain.
        await sendEventCard(ctx, event, {
          seriesOccurrenceCount: cardOccCount,
          seriesMultiVenue: multiVenue,
          seriesProfileMatchCount,
        });
        for (const o of seriesOccs) {
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
        ? "יש עוד אירוע אחד — להראות?"
        : `יש עוד ${remainingSeriesCount} אירועים — להראות?`;
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
// Event interest toggle (⭐ מעניין אותי)
// ──────────────────────────────────────────────────────────────────────────
bot.action(/^int:add:(\d+)$/, async (ctx) => {
  const eventId = ctx.match[1];
  try {
    await addInterest(ctx.from.id, eventId);
    // Fire-and-forget: store learning signal + boost category/tag weights
    recordInterestSignal(ctx.from.id, eventId).catch(() => {});
    recordPositiveSignal(ctx.from.id, eventId).catch(() => {});
    await ctx.answerCbQuery("⭐ שמרנו! נציג לך יותר אירועים כאלה");
    // Flip the button to the "cancel" state
    await ctx.editMessageReplyMarkup(
      replaceInlineButton(
        ctx.callbackQuery.message.reply_markup,
        `int:add:${eventId}`,
        { text: "⭐ מעניין אותי ✓", callback_data: `int:rem:${eventId}` },
      ),
    );
  } catch (err) {
    console.error("[Bot] int:add error:", err.message);
    await ctx.answerCbQuery("⚠️ שגיאה, נסי שוב");
  }
});

bot.action(/^int:rem:(\d+)$/, async (ctx) => {
  const eventId = ctx.match[1];
  try {
    await removeInterest(ctx.from.id, eventId);
    await ctx.answerCbQuery("הוסר הסימון");
    await ctx.editMessageReplyMarkup(
      replaceInlineButton(
        ctx.callbackQuery.message.reply_markup,
        `int:rem:${eventId}`,
        { text: "⭐ מעניין אותי", callback_data: `int:add:${eventId}` },
      ),
    );
  } catch (err) {
    console.error("[Bot] int:rem error:", err.message);
    await ctx.answerCbQuery("⚠️ שגיאה, נסי שוב");
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

registerFeedbackHandlers(bot, {
  supabase,
  sessionStore,
  getProfile,
  rememberKnownSeries,
  recordTooFarSignal,
  recordNotInterestedSignal,
  alertAdmin,
  replyAsCallbackResult,
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
    `${icon} *כרטיס חדש לאירוע שבמעקב שלך*`,
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

// Railway (and browsers hitting /miniapp) probe $PORT immediately. The
// HTTP server must listen before Telegram long-polling connects — otherwise
// deploy health checks fail with "Application failed to respond" while
// runCleanup() or getMe() are still in flight.
try {
  const oauthServer = require("../lib/oauthServer");
  oauthServer.start({ bot });
} catch (err) {
  console.error("[Bot] Express server failed to start:", err.message);
}

runCleanup()
  .then(({ deleted, archived }) => {
    console.log(`[Bot] Boot cleanup: deleted=${deleted}, archived=${archived}`);
  })
  .catch((err) => console.warn("[Bot] Boot cleanup warning:", err.message))
  .finally(() => {
    // Telegraf 4.x quirk: for long-polling, bot.launch() returns a
    // promise that resolves only when the polling loop STOPS (i.e.
    // on bot.stop()). The old code did `bot.launch().then(...)` and
    // therefore never ran the side-services — the newsletter
    // scheduler and OAuth server stayed unstarted for the bot's
    // entire lifetime, which surfaced as "renderer_unavailable"
    // from /newsletter_preview.
    //
    // Fix: use the second-arg `onLaunch` callback that telegraf
    // fires AFTER getMe() succeeds but BEFORE the polling loop
    // starts. We start the side-services from there, and only
    // `.catch()` on the outer promise so launch failures still
    // crash visibly.
    bot
      .launch({}, async () => {
        try {
          const me = await bot.telegram.getMe();
          console.log(
            `[Bot] Running as @${me.username} (id ${me.id}) | ` +
              `AGENT_ENABLED=${isAgentEnabled()} GEMINI_ONLY_ENRICHER=${(process.env.GEMINI_ONLY_ENRICHER ?? "true")}`,
          );
        } catch {
          console.log("[Bot] Running");
        }
        try {
          const newsletterScheduler = require("../lib/newsletterScheduler");
          newsletterScheduler.start({
            bot,
            renderUserDigest: renderNewsletterDigest,
          });
        } catch (err) {
          console.error("[Bot] Newsletter scheduler failed to start:", err.message);
        }
        if (!process.env.GOOGLE_OAUTH_CLIENT_ID || !process.env.GOOGLE_OAUTH_REDIRECT_URI) {
          console.log(
            "[Bot] Google OAuth not configured — /connect_calendar disabled. " +
              "Set GOOGLE_OAUTH_CLIENT_ID + _REDIRECT_URI + _CLIENT_SECRET to enable.",
          );
        }

        // Register the Mini App as the bot's Menu Button — appears as a
        // persistent "📅 קטלוג אירועים" button at the bottom of every chat.
        // Only registers when MINIAPP_URL is configured (set this to the
        // public URL of the deployed service + /miniapp, e.g.
        // https://your-service.up.railway.app/miniapp).
        const miniAppUrl = getMiniAppCatalogUrl();
        if (miniAppUrl) {
          bot.telegram
            .setChatMenuButton({
              menu_button: {
                type: "web_app",
                text: "📅 קטלוג אירועים",
                web_app: { url: miniAppUrl },
              },
            })
            .then(() => console.log(`[Bot] Mini App menu button set → ${miniAppUrl}`))
            .catch((err) =>
              console.warn(`[Bot] setChatMenuButton failed: ${err.message}`),
            );
        } else {
          console.log(
            "[Bot] MINIAPP_URL not set — Mini App menu button skipped. " +
              "Set MINIAPP_URL to enable the catalog button.",
          );
        }
      })
      .catch((err) => {
        console.error("[Bot] Failed to start:", err.message);
        // A 409 means another getUpdates is still active — usually the
        // previous instance's long-poll that Telegram hasn't released yet
        // (after a hard kill), or a parallel deploy. Do NOT exit: the
        // Express/Mini App server (started above) must stay up so the
        // catalog + profile keep working over the tunnel. Retry polling
        // with backoff until the lock frees.
        const is409 = /409|Conflict|terminated by other getUpdates/i.test(err.message || "");
        if (is409) {
          let attempt = 0;
          const retry = () => {
            attempt += 1;
            const delay = Math.min(60000, 5000 * attempt);
            console.warn(`[Bot] 409 conflict — retrying launch in ${delay / 1000}s (attempt ${attempt})`);
            setTimeout(() => {
              bot.launch({}, async () => {
                try {
                  const me = await bot.telegram.getMe();
                  console.log(`[Bot] Running as @${me.username} (id ${me.id}) after retry`);
                } catch { console.log("[Bot] Running (after retry)"); }
              }).catch((e) => {
                if (/409|Conflict|terminated by other getUpdates/i.test(e.message || "")) retry();
                else console.error("[Bot] launch retry failed:", e.message);
              });
            }, delay);
          };
          retry();
          return;
        }
        process.exit(1);
      });
  });

process.once("SIGINT", () => { gracefulShutdown("SIGINT").catch(() => process.exit(1)); });
process.once("SIGTERM", () => { gracefulShutdown("SIGTERM").catch(() => process.exit(1)); });

module.exports = bot;
