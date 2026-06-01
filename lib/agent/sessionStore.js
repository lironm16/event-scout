// In-memory conversation history for the agent loop, keyed by Telegram user.
//
// Why in-memory:
//   • A bot restart wipes context — that's fine for v1; users re-state their
//     intent after a restart, and the longest flows take seconds, not hours.
//   • All other ephemeral state in this codebase (pendingSaveSessions,
//     recentResultsByUser, etc.) follow the same pattern.
//
// History shape mirrors Gemini's `Content[]` format so we can pass it
// directly to `model.generateContent({ contents })`:
//   [
//     { role: 'user',     parts: [{ text }] },
//     { role: 'model',    parts: [{ functionCall: { name, args } }] },
//     { role: 'function', parts: [{ functionResponse: { name, response } }] },
//     { role: 'model',    parts: [{ text }] },
//   ]
//
// `pendingClarification` lets the orchestrator pause mid-turn while waiting
// for the user to answer a yes/no/multi-choice question. The next inbound
// text or button press is fed into the agent loop as the answer to that
// dangling tool call.

const TTL_MS = 30 * 60 * 1000;
const MAX_TURNS = 20;

const sessions = new Map();

function now() {
  return Date.now();
}

function key(telegramId) {
  return String(telegramId);
}

function ensureSession(telegramId) {
  const k = key(telegramId);
  let s = sessions.get(k);
  if (!s) {
    s = {
      history: [],
      pendingClarification: null,
      pendingSave: null,
      // Map<seriesId, { occurrences: Array<event_id> }>. Populated by
      // present_event_results when a card is rendered for a recurring
      // event series. The Telegram callback handler `series:<id>` reads
      // from here to show "כל המופעים" without another DB round-trip.
      // Bounded growth: capped at LAST_SHOWN_SERIES_CAP via setLastShownSeries.
      lastShownSeries: new Map(),
      // Set<event_id> of events we've rendered cards for in this session.
      // Populated by present_event_results / pgn:next / newsletter digest.
      // Powers "להראות עוד" pagination only — search_events does NOT
      // filter on this. Bounded via FIFO at SHOWN_EVENT_IDS_CAP.
      shownEventIds: new Set(),
      lastInteractionAt: now(),
    };
    sessions.set(k, s);
  }
  s.lastInteractionAt = now();
  return s;
}

function getSession(telegramId) {
  const s = sessions.get(key(telegramId));
  if (!s) return null;
  if (now() - s.lastInteractionAt > TTL_MS) {
    sessions.delete(key(telegramId));
    return null;
  }
  s.lastInteractionAt = now();
  return s;
}

function clearSession(telegramId) {
  sessions.delete(key(telegramId));
}

// History truncation: every turn (a model+function pair, or a model-only
// reply) bumps the count. Once we cross MAX_TURNS, drop the oldest pair so
// the next Gemini call doesn't carry stale context. We keep this dumb on
// purpose — full token-budget summarization can come later.
function truncateIfNeeded(history) {
  while (history.length > MAX_TURNS * 2) {
    history.shift();
  }
}

function appendUserMessage(telegramId, text) {
  const s = ensureSession(telegramId);
  s.history.push({ role: "user", parts: [{ text: String(text) }] });
  truncateIfNeeded(s.history);
  return s;
}

// Inject a "the user just clicked button X" event WITHOUT showing it as a
// raw user message — useful when callbacks resume a paused agent flow. We
// model it as a `function` role response to the dangling function call so
// Gemini sees the answer in the natural place in history.
function appendButtonResponse(telegramId, functionName, response) {
  const s = ensureSession(telegramId);
  s.history.push({
    role: "function",
    parts: [{ functionResponse: { name: functionName, response } }],
  });
  truncateIfNeeded(s.history);
  return s;
}

function appendModelTurn(telegramId, parts) {
  const s = ensureSession(telegramId);
  s.history.push({ role: "model", parts });
  truncateIfNeeded(s.history);
  return s;
}

function appendFunctionResponse(telegramId, functionName, response) {
  const s = ensureSession(telegramId);
  s.history.push({
    role: "function",
    parts: [{ functionResponse: { name: functionName, response } }],
  });
  truncateIfNeeded(s.history);
  return s;
}

/**
 * Append a single `function` role turn carrying multiple functionResponse
 * parts — one per parallel call Gemini issued in a single round. Required
 * because Gemini's chat protocol demands the calls and their responses
 * live in adjacent turns AND share role boundaries.
 */
function appendFunctionTurn(telegramId, parts) {
  const s = ensureSession(telegramId);
  s.history.push({ role: "function", parts });
  truncateIfNeeded(s.history);
  return s;
}

function setPendingClarification(telegramId, value) {
  const s = ensureSession(telegramId);
  s.pendingClarification = value;
  return s;
}

function clearPendingClarification(telegramId) {
  const s = sessions.get(key(telegramId));
  if (s) s.pendingClarification = null;
}

function setPendingSave(telegramId, snapshot) {
  const s = ensureSession(telegramId);
  s.pendingSave = snapshot;
  return s;
}

function clearPendingSave(telegramId) {
  const s = sessions.get(key(telegramId));
  if (s) s.pendingSave = null;
}

// Last `resolve_venue` round-trip — kept on session so the `clr:`
// callback can reconstruct (alias → picked location_key) and feed it
// to venueMemory without round-tripping through Gemini for the metadata.
function setLastResolveVenue(telegramId, payload) {
  const s = ensureSession(telegramId);
  s.lastResolveVenue = payload;
  return s;
}

function getLastResolveVenue(telegramId) {
  const s = sessions.get(key(telegramId));
  return s?.lastResolveVenue || null;
}

function clearLastResolveVenue(telegramId) {
  const s = sessions.get(key(telegramId));
  if (s) s.lastResolveVenue = null;
}

// Cap the per-session series cache at this many entries. We render at
// most ~5 cards/turn so 50 covers ~10 turns of context — far longer
// than a typical user keeps a card around before tapping its button.
// Anything older drops out FIFO.
const LAST_SHOWN_SERIES_CAP = 50;

function rememberShownSeries(telegramId, seriesId, payload) {
  const s = ensureSession(telegramId);
  if (!s.lastShownSeries) s.lastShownSeries = new Map();
  // Re-insert (delete-then-set) to refresh insertion order — JS Maps
  // iterate in insertion order, so this keeps "most recent" at the end.
  s.lastShownSeries.delete(seriesId);
  s.lastShownSeries.set(seriesId, payload);
  while (s.lastShownSeries.size > LAST_SHOWN_SERIES_CAP) {
    const oldest = s.lastShownSeries.keys().next().value;
    s.lastShownSeries.delete(oldest);
  }
}

function getShownSeries(telegramId, seriesId) {
  const s = sessions.get(key(telegramId));
  if (!s?.lastShownSeries) return null;
  const payload = s.lastShownSeries.get(seriesId);
  if (!payload) return null;
  s.lastInteractionAt = now();
  return payload;
}

// Per-session "I already showed you this event" tracking. Cap is sized
// to ~40 turns × 5 cards/turn = 200, comfortably over the practical
// chat depth before a session times out at TTL_MS. Older ids drop FIFO.
const SHOWN_EVENT_IDS_CAP = 200;

function rememberShownEvents(telegramId, eventIds) {
  if (!Array.isArray(eventIds) || !eventIds.length) return;
  const s = ensureSession(telegramId);
  if (!s.shownEventIds) s.shownEventIds = new Set();
  for (const raw of eventIds) {
    const id = typeof raw === "number" ? raw : parseInt(raw, 10);
    if (!Number.isFinite(id)) continue;
    // Re-insert (delete then add) so insertion order tracks "most
    // recently shown" — same trick we use for lastShownSeries.
    // Keeps the FIFO eviction below biased toward dropping the
    // OLDEST entries, not the most recent ones.
    s.shownEventIds.delete(id);
    s.shownEventIds.add(id);
  }
  while (s.shownEventIds.size > SHOWN_EVENT_IDS_CAP) {
    const oldest = s.shownEventIds.values().next().value;
    if (oldest === undefined) break;
    s.shownEventIds.delete(oldest);
  }
}

// Returns a plain Array (not a Set) so callers can pass it directly to
// a SQL `.not("id", "in", "(...)")` clause without extra conversion.
// Returns [] (never null) so consumers can spread/iterate
// unconditionally.
function getShownEventIds(telegramId) {
  const s = sessions.get(key(telegramId));
  if (!s?.shownEventIds || s.shownEventIds.size === 0) return [];
  return Array.from(s.shownEventIds);
}

// ────────────────────────────────────────────────────────────────────
// Persistent pagination context — survives across turns so a "כן /
// להראות עוד" button tap can deterministically advance through the
// LAST search's remaining series WITHOUT routing through Gemini.
//
// The agent context (`ctx.lastSearchHits`) is rebuilt per turn, so it
// can't power an out-of-band callback handler — we mirror the hits
// here, keyed by session. Cleared automatically when the user does
// anything else that would invalidate the pagination scope (a new
// search, leaving the chat, TTL eviction).
//
// Shape:
//   { hits: [event row, …],  // last search's full hits
//     savedAt: epoch_ms }
// ────────────────────────────────────────────────────────────────────
function setLastSearchHits(telegramId, hits) {
  if (!Array.isArray(hits) || !hits.length) return;
  const s = ensureSession(telegramId);
  s.lastSearchHits = { hits, savedAt: now() };
}

function getLastSearchHits(telegramId) {
  const s = sessions.get(key(telegramId));
  return Array.isArray(s?.lastSearchHits?.hits) ? s.lastSearchHits.hits : [];
}

function clearLastSearchHits(telegramId) {
  const s = sessions.get(key(telegramId));
  if (s) delete s.lastSearchHits;
}

// Last deterministic-router search filters — powers "רק קרוב" refinements
// without Gemini. Cleared on TTL with the session.
function setLastSearchFilters(telegramId, filters) {
  const s = ensureSession(telegramId);
  s.lastSearchFilters = filters ? { ...filters } : null;
}

function getLastSearchFilters(telegramId) {
  const s = sessions.get(key(telegramId));
  return s?.lastSearchFilters || null;
}

function clearLastSearchFilters(telegramId) {
  const s = sessions.get(key(telegramId));
  if (s) delete s.lastSearchFilters;
}

function setLastExtensionHint(telegramId, hint) {
  const s = ensureSession(telegramId);
  s.lastExtensionHint = hint ? { ...hint } : null;
}

function getLastExtensionHint(telegramId) {
  const s = sessions.get(key(telegramId));
  return s?.lastExtensionHint || null;
}

function clearLastExtensionHint(telegramId) {
  const s = sessions.get(key(telegramId));
  if (s) delete s.lastExtensionHint;
}

// Interests-picker state — populated by /interests (or the agent's
// `present_interest_picker` tool) and consumed by the `ip:*` callback
// handlers in telegramBot.js.
//
// SHAPE on `session.interestsPicker`:
//   {
//     target:        "self" | "partner",
//     partnerName?:  string,            // present when target === "partner"
//     selected:      string[],          // Hebrew chip labels currently checked
//     messageId?:    number,            // Telegram message id of the picker UI
//                                       //   used to edit the inline keyboard
//                                       //   in-place on each toggle
//     freeTextMode?: boolean,           // true once user tapped "אחר..."
//                                       //   the next text message is parsed
//                                       //   as free-form interests
//   }
//
// EXPIRY — purely in-memory, swept by the existing TTL cleanup interval.
// No persistence: if the bot restarts mid-flow, the user simply re-opens
// the picker. The PROFILE is the durable record; this state is just the
// transient pick-and-toggle interaction.
function setInterestsPicker(telegramId, value) {
  const s = ensureSession(telegramId);
  s.interestsPicker = value;
  return s;
}

function getInterestsPicker(telegramId) {
  const s = sessions.get(key(telegramId));
  return s?.interestsPicker || null;
}

function updateInterestsPicker(telegramId, patch) {
  const s = sessions.get(key(telegramId));
  if (!s || !s.interestsPicker) return null;
  s.interestsPicker = { ...s.interestsPicker, ...patch };
  return s.interestsPicker;
}

function clearInterestsPicker(telegramId) {
  const s = sessions.get(key(telegramId));
  if (s) delete s.interestsPicker;
}

// ────────────────────────────────────────────────────────────────────
// Onboarding state — multi-step picker flow (toplabels → topics →
// audiences → location). Replaces the single-shot `interestsPicker`
// for the `/start` and `/interests` entry points; the legacy
// `interestsPicker` stays around for the partner-interests sub-flow
// which is still a one-step interaction.
//
// SHAPE on `session.onboarding`:
//   {
//     step:              "toplabels" | "topics" | "audiences" | "location"
//                        | "summary" | "location_other",
//     topLabelNames:     Set<string>,   // Hebrew names of labels checked
//                                       //   in the popularity-paginated
//                                       //   step; persisted into
//                                       //   profile.user_context.interests[].
//     topLabelsLoaded:   Array<{id, name, events_count}>,
//                                       //   labels we've already fetched
//                                       //   from the dictionary; grows by
//                                       //   PAGE_SIZE on each "show more".
//                                       //   Used as the chip source so the
//                                       //   render keeps showing labels
//                                       //   the user already toggled even
//                                       //   after they paginated past.
//     topLabelsHasMore:  boolean,       // true when last fetch returned a
//                                       //   full page; controls whether
//                                       //   we show "🔁 הצג עוד" vs
//                                       //   "סיימתי".
//     topics:      Set<string>,    // chip labels (Hebrew)
//     audiences:   Set<string>,    // chip labels (Hebrew)
//     location:    { id, label, max_walking_minutes, preference } | null,
//     extraLabels: string[],       // free-text legacy interests
//                                  //   carried over from existing profile —
//                                  //   not selectable, just preserved so save
//                                  //   doesn't clobber what the agent learned
//                                  //   from chat ("יין", "ג'אז" etc.).
//     messageId?:  number,         // Telegram message id we're editing in
//                                  //   place across steps
//     chatId?:     number,         // ditto, the chat id the message lives in
//     startedAt:   epoch_ms,
//     triggeredBy: "auto" | "manual",
//                                  // "auto" = first-touch /start for a new
//                                  //   user; "manual" = /interests command,
//                                  //   welcome button, /profile re-edit.
//                                  //   The summary card uses this to choose
//                                  //   between "מעולה! בואי נתחיל" and
//                                  //   "התעדכן בהצלחה!".
//   }
//
// EXPIRY — same TTL as the rest of the session. If the user abandons
// onboarding mid-flow, the next /interests re-opens from scratch but
// pre-selects whatever already landed in `profile.interests` /
// `profile.communities` from previous saves (we save per-step, see
// Phase 5).
function setOnboarding(telegramId, value) {
  const s = ensureSession(telegramId);
  s.onboarding = value;
  return s;
}

function getOnboarding(telegramId) {
  const s = sessions.get(key(telegramId));
  return s?.onboarding || null;
}

function updateOnboarding(telegramId, patch) {
  const s = sessions.get(key(telegramId));
  if (!s || !s.onboarding) return null;
  s.onboarding = { ...s.onboarding, ...patch };
  return s.onboarding;
}

function clearOnboarding(telegramId) {
  const s = sessions.get(key(telegramId));
  if (s) delete s.onboarding;
}

// ────────────────────────────────────────────────────────────────────
// Newsletter multi-select state — populated when the scheduler
// delivers a digest with select buttons, consumed by the `nl:*`
// callback handlers in telegramBot.js.
//
// SHAPE on `session.newsletter`:
//   {
//     selectedEventIds: Set<number>,       // currently-toggled events
//     cardMessageIds:   Map<eventId, number>, // for in-place toggle re-render
//     events:           Map<eventId, eventRow>, // payload for bulk actions
//                                          //   (need event.name/date/location
//                                          //   when assembling share text or
//                                          //   calendar inserts WITHOUT
//                                          //   re-querying the DB)
//     footerChatId:     number,            // chat where the footer lives
//     footerMessageId:  number,            // for editing the counter
//     deliveredAt:      epoch_ms,
//   }
//
// EXPIRY — TTL_MS sweep. If the user comes back to a stale digest the
// callback handlers detect the missing state and toast "ה‑newsletter
// הזה כבר לא בתוקף — תקבלי חדש בשבוע הבא". The buttons on the cards
// remain in chat history (Telegram retention), so this is a normal
// long-tail case, not an error.
function setNewsletterState(telegramId, value) {
  const s = ensureSession(telegramId);
  s.newsletter = value;
  return s;
}

function getNewsletterState(telegramId) {
  const s = sessions.get(key(telegramId));
  return s?.newsletter || null;
}

function updateNewsletterState(telegramId, patch) {
  const s = sessions.get(key(telegramId));
  if (!s || !s.newsletter) return null;
  s.newsletter = { ...s.newsletter, ...patch };
  return s.newsletter;
}

function clearNewsletterState(telegramId) {
  const s = sessions.get(key(telegramId));
  if (s) delete s.newsletter;
}

// Favorite locations picker — multi-select from popularity-ranked catalog.
// SHAPE on `session.favoriteLocationsPicker`:
//   { loaded, selectedKeys: Set, offset, hasMore, total, messageId, chatId, returnTo }
function setFavoriteLocationsPicker(telegramId, value) {
  const s = ensureSession(telegramId);
  s.favoriteLocationsPicker = value;
  return s;
}

function getFavoriteLocationsPicker(telegramId) {
  const s = sessions.get(key(telegramId));
  return s?.favoriteLocationsPicker || null;
}

function updateFavoriteLocationsPicker(telegramId, patch) {
  const s = sessions.get(key(telegramId));
  if (!s?.favoriteLocationsPicker) return null;
  s.favoriteLocationsPicker = { ...s.favoriteLocationsPicker, ...patch };
  return s.favoriteLocationsPicker;
}

function clearFavoriteLocationsPicker(telegramId) {
  const s = sessions.get(key(telegramId));
  if (s) delete s.favoriteLocationsPicker;
}

// Multi-select search hub draft (see lib/searchDraftPicker.js).
// SHAPE: { draft, draftText?, messageId, chatId }
function setSearchDraft(telegramId, value) {
  const s = ensureSession(telegramId);
  s.searchDraft = value;
  return s;
}

function getSearchDraft(telegramId) {
  const s = sessions.get(key(telegramId));
  return s?.searchDraft || null;
}

function updateSearchDraft(telegramId, patch) {
  const s = sessions.get(key(telegramId));
  if (!s?.searchDraft) return null;
  s.searchDraft = { ...s.searchDraft, ...patch };
  return s.searchDraft;
}

function clearSearchDraft(telegramId) {
  const s = sessions.get(key(telegramId));
  if (s) delete s.searchDraft;
}

// Sweep stale sessions periodically — without this, abandoned sessions
// (user opens a chat, never replies) leak memory until the process exits.
setInterval(() => {
  const cutoff = now() - TTL_MS;
  for (const [k, s] of sessions) {
    if (s.lastInteractionAt < cutoff) sessions.delete(k);
  }
}, 5 * 60 * 1000).unref();

module.exports = {
  TTL_MS,
  MAX_TURNS,
  ensureSession,
  getSession,
  clearSession,
  appendUserMessage,
  appendButtonResponse,
  appendModelTurn,
  appendFunctionResponse,
  appendFunctionTurn,
  setPendingClarification,
  clearPendingClarification,
  setPendingSave,
  clearPendingSave,
  setLastResolveVenue,
  getLastResolveVenue,
  clearLastResolveVenue,
  rememberShownSeries,
  getShownSeries,
  rememberShownEvents,
  getShownEventIds,
  setLastSearchHits,
  getLastSearchHits,
  clearLastSearchHits,
  setLastSearchFilters,
  getLastSearchFilters,
  clearLastSearchFilters,
  setLastExtensionHint,
  getLastExtensionHint,
  clearLastExtensionHint,
  setInterestsPicker,
  getInterestsPicker,
  updateInterestsPicker,
  clearInterestsPicker,
  setOnboarding,
  getOnboarding,
  updateOnboarding,
  clearOnboarding,
  setNewsletterState,
  getNewsletterState,
  updateNewsletterState,
  clearNewsletterState,
  setFavoriteLocationsPicker,
  getFavoriteLocationsPicker,
  updateFavoriteLocationsPicker,
  clearFavoriteLocationsPicker,
  setSearchDraft,
  getSearchDraft,
  updateSearchDraft,
  clearSearchDraft,
};
