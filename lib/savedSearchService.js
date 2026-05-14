const supabase = require("./supabase");
const { AUDIENCE_LABELS } = require("./categories");
const { findOverlapsIn } = require("./savedSearchOverlap");
const { STOP_WORDS: SAVE_STOP_WORDS } = require("./savedSearchStopwords");

// Tokenize a free-text venue label into lowercase words so we can subtract
// them from the saved tokens. With `location_key` already pinning the
// exact venue, leaving "פיס" / "גאולים" inside `tokens` would force EVERY
// matched event title to literally contain those words — a huge over-fit.
function venueLabelTokens(label) {
  if (!label) return new Set();
  return new Set(
    String(label)
      .toLowerCase()
      .split(/[\s,.\-_/()"'\u05F4\u05F3]+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 2),
  );
}

function audienceKeywordSet(audience) {
  if (!audience) return new Set();
  const label = AUDIENCE_LABELS[audience];
  return label ? new Set([label.toLowerCase()]) : new Set();
}

/**
 * Strip filler words and short fragments from explicit `tokens` passed
 * by the agent or copied from a previous watcher. Keeps tokens ≥2 chars
 * that aren't in the stop-word list, and removes anything that overlaps
 * a structured filter (audience keyword, venue keyword) since those
 * filters carry the constraint at match time.
 *
 * NOTE — after the May-2026 query/tokens decoupling, this function NO
 * longer mines `queryText`. The label is purely cosmetic; if the user
 * wants substring filtering on the event title they have to put the
 * keywords into `tokens` explicitly (the editable confirmation card
 * makes this a one-tap action). Pre-decoupling, leaking query text
 * into tokens silently turned every watcher label into an AND filter
 * over event titles — see lib/savedSearchNotifier.js#deriveTokens for
 * the full story.
 *
 * `queryText` is still accepted as an argument for compatibility with
 * existing call sites but the value is ignored.
 */
function normalizeTokens(rawTokens, _queryText, filters = {}) {
  const fromArr = Array.isArray(rawTokens) ? rawTokens : [];

  const venueTokens = venueLabelTokens(filters.location_label);
  const audienceKws = audienceKeywordSet(filters.audience);

  const all = fromArr
    .map((t) => String(t || "").toLowerCase().trim())
    .filter((t) => t.length >= 2 && !SAVE_STOP_WORDS.has(t))
    .filter((t) => !venueTokens.has(t))
    .filter((t) => !audienceKws.has(t));
  return [...new Set(all)];
}

/**
 * Cosmetic cleanup of the watcher's display label. Drops obvious filler
 * ("אני רוצה ש…") so the user sees "סיור עששיות" in /saved rather than
 * "אני רוצה שתחפשי לי סיור עששיות". The cleaned text NEVER feeds the
 * matcher — that contract is enforced in normalizeTokens above and in
 * the notifier's deriveTokens. A small leak here is purely a UI nit.
 */
function normalizeQueryText(rawQuery) {
  if (!rawQuery) return "";
  const cleaned = String(rawQuery)
    .split(/[\s,]+/)
    .map((w) => w.trim())
    .filter((w) => w && !SAVE_STOP_WORDS.has(w.toLowerCase()))
    .join(" ");
  return cleaned || rawQuery; // fall back to original if cleanup left nothing
}

/**
 * Persist a snapshot of the user's most recent search as a "topic watcher".
 *
 * Inputs are normalized HERE (tokens stop-word-filtered, query stripped of
 * filler) so the per-scrape matcher can run pure deterministic matching
 * without re-cleaning every cycle. With the brain prompt's normalization +
 * this safety net, no Gemini call is needed at match time.
 *
 * `payload` shape (all fields except query+mode are optional):
 *   {
 *     query:            "סיור עששיות",                  // DISPLAY LABEL ONLY — never feeds the matcher
 *     tokens:           ["סיור", "עששיות"],             // explicit title-substring AND filter, optional
 *     filters: {
 *       audience:         "kids" | "family" | "all" | … | null,
 *       ages:             [4, 9] | null,               // ages-in-years; ANY-fit against min/max_months
 *       proximity:        "walk" | "drive" | null,
 *       format:           "physical" | "virtual" | null,
 *       time_after:       "16:00" | null,
 *       time_before:      "21:00" | null,
 *       date_from:        "2026-05-04" | null,
 *       date_to:          "2026-05-09" | null,
 *       location_key:     "merkaz pais geulim" | null, // FK into locations.key
 *       location_label:   "מרכז פיס גאולים, רמת גן" | null, // raw_address for display
 *       venue:            "פיס גאולים" | null,         // free-text fallback only
 *       watch_tag_names:  ["מוזיקה"] | null,           // topic watcher (matched against event.tags)
 *     },
 *     tickets_needed:   3 | null,
 *     mode:             "one_time" | "recurring",
 *     expires_at:       ISO timestamptz | null,
 *   }
 *
 * For one_time mode, tickets_remaining is initialised to tickets_needed so
 * "✅ קניתי N" buttons can decrement it down to 0 and auto-archive the row.
 */
async function createSavedSearch(telegramId, payload) {
  const { cleanedQuery, cleanedTokens, filters } = buildSearchRowPayload(payload);

  const row = {
    telegram_id: String(telegramId),
    query: cleanedQuery,
    tokens: cleanedTokens,
    filters,
    tickets_needed: payload.tickets_needed ?? null,
    tickets_remaining: payload.tickets_needed ?? null,
    mode: payload.mode === "one_time" ? "one_time" : "recurring",
    expires_at: payload.expires_at || null,
  };
  const { data, error } = await supabase
    .from("saved_searches")
    .insert(row)
    .select()
    .single();
  if (error) throw new Error(`Save search failed: ${error.message}`);
  console.log(
    `[SavedSearch] Created saved search id=${data.id} ` +
    `query="${cleanedQuery}" tokens=[${cleanedTokens.join(",")}] ` +
    `filters=${JSON.stringify(row.filters)}`,
  );
  return data;
}

/**
 * Apply the same sanitisation that `createSavedSearch` runs to a payload
 * destined for an UPDATE. Pulled out so create + update share one truth
 * for token cleanup, filter sanitisation, and tag deduplication.
 */
function buildSearchRowPayload(payload) {
  const cleanedQuery = normalizeQueryText(payload.query);

  const filters = {};
  for (const [k, v] of Object.entries(payload.filters || {})) {
    if (!k.startsWith("_")) filters[k] = v;
  }

  if (Array.isArray(filters.watch_tag_names)) {
    const seen = new Set();
    const out = [];
    for (const raw of filters.watch_tag_names) {
      const s = String(raw || "").trim();
      if (!s) continue;
      const key = s.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
    }
    if (out.length) filters.watch_tag_names = out;
    else delete filters.watch_tag_names;
  }

  // Ages — accept array of ints (years), drop non-numerics, dedupe, sort
  // ascending so the storage shape is stable across edits (makes
  // /saved summaries and overlap-detection diffs predictable).
  if (Array.isArray(filters.ages)) {
    const numeric = filters.ages
      .map((n) => (typeof n === "number" ? n : parseInt(n, 10)))
      .filter((n) => Number.isFinite(n) && n >= 0);
    const unique = [...new Set(numeric)].sort((a, b) => a - b);
    if (unique.length) filters.ages = unique;
    else delete filters.ages;
  }

  // available_only was historically documented on the payload but never
  // read by the notifier (tickets_left > 0 is enforced unconditionally
  // for every saved-search match). Strip it so it doesn't survive on
  // newly-created rows and confuse future readers of the JSONB.
  if ("available_only" in filters) delete filters.available_only;

  const cleanedTokens = normalizeTokens(payload.tokens, cleanedQuery, filters);
  return { cleanedQuery, cleanedTokens, filters };
}

/**
 * Replace the filters / tokens / quantity / mode of an existing saved
 * search in-place. Used by the "🔄 update existing" path of the
 * overlap-detection flow — preserves the row's id and, crucially, its
 * `saved_search_notifications` dedup history (so we don't re-spam
 * events the user has already seen).
 *
 * Caller must own the row (telegram_id is enforced at the SQL layer).
 */
async function updateSavedSearch(id, telegramId, payload) {
  const { cleanedQuery, cleanedTokens, filters } = buildSearchRowPayload(payload);

  const updates = {
    query: cleanedQuery,
    tokens: cleanedTokens,
    filters,
    tickets_needed: payload.tickets_needed ?? null,
    tickets_remaining: payload.tickets_needed ?? null,
  };
  if (payload.mode === "one_time" || payload.mode === "recurring") {
    updates.mode = payload.mode;
  }
  if (payload.expires_at !== undefined) {
    updates.expires_at = payload.expires_at;
  }
  // Re-activate if previously archived. Most callers won't hit this
  // because update is usually wired off live overlap detection, but if
  // a user updates an archived search we treat it as "bring it back".
  updates.archived = false;

  const { data, error } = await supabase
    .from("saved_searches")
    .update(updates)
    .eq("id", id)
    .eq("telegram_id", String(telegramId))
    .select()
    .single();
  if (error) throw new Error(`Update saved search failed: ${error.message}`);
  console.log(
    `[SavedSearch] Updated id=${data.id} ` +
    `query="${cleanedQuery}" tokens=[${cleanedTokens.join(",")}] ` +
    `filters=${JSON.stringify(filters)}`,
  );
  return data;
}

/**
 * Return existing saved searches for `telegramId` that overlap with
 * `snapshot`. The relationship classifier lives in
 * `lib/savedSearchOverlap.js`; this thin wrapper is the only place we
 * actually hit the DB. Result is sorted "most actionable first" so the
 * caller can default to the top entry.
 *
 * `snapshot` shape mirrors the `payload` accepted by createSavedSearch
 * (i.e. `{ query, tokens, filters, … }`). Archived rows are skipped.
 */
async function findOverlappingSavedSearches(telegramId, snapshot) {
  const existing = await listSavedSearches(telegramId);
  return findOverlapsIn(snapshot, existing);
}

async function listSavedSearches(telegramId) {
  const { data, error } = await supabase
    .from("saved_searches")
    .select("*")
    .eq("telegram_id", String(telegramId))
    .eq("archived", false)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`List saved searches failed: ${error.message}`);
  return data || [];
}

async function getSavedSearch(id, telegramId) {
  let q = supabase.from("saved_searches").select("*").eq("id", id);
  if (telegramId != null) q = q.eq("telegram_id", String(telegramId));
  const { data, error } = await q.maybeSingle();
  if (error) throw new Error(`Get saved search failed: ${error.message}`);
  return data;
}

/**
 * Promote an existing one_time saved search to recurring (clears expiry).
 * Keeps the same row + dedup history.
 */
async function promoteToRecurring(id, telegramId) {
  let q = supabase
    .from("saved_searches")
    .update({ mode: "recurring", expires_at: null })
    .eq("id", id);
  if (telegramId != null) q = q.eq("telegram_id", String(telegramId));
  const { error } = await q;
  if (error) throw new Error(`Promote saved search failed: ${error.message}`);
}

/**
 * Soft-delete: keeps history but stops further matches/notifications.
 * Restricting to the calling user avoids accidental cross-user deletion.
 */
async function archiveSavedSearch(id, telegramId) {
  let q = supabase
    .from("saved_searches")
    .update({ archived: true })
    .eq("id", id);
  if (telegramId != null) q = q.eq("telegram_id", String(telegramId));
  const { error } = await q;
  if (error) throw new Error(`Archive saved search failed: ${error.message}`);
}

async function markNotified(savedSearchId, eventId) {
  const { error } = await supabase
    .from("saved_search_notifications")
    .upsert(
      {
        saved_search_id: savedSearchId,
        event_id: parseInt(eventId, 10),
      },
      { onConflict: "saved_search_id,event_id" },
    );
  if (error) throw new Error(`Mark saved-search notified failed: ${error.message}`);

  await supabase
    .from("saved_searches")
    .update({ last_notified_at: new Date().toISOString() })
    .eq("id", savedSearchId);
}

async function getNotifiedEventIds(savedSearchId) {
  const { data, error } = await supabase
    .from("saved_search_notifications")
    .select("event_id")
    .eq("saved_search_id", savedSearchId);
  if (error) throw new Error(`Get notified failed: ${error.message}`);
  return (data || []).map((r) => r.event_id);
}

/**
 * All active (non-archived, non-expired) saved searches across users.
 * Used by the post-scrape matcher to fan out notifications.
 */
async function listAllActiveSavedSearches() {
  const nowIso = new Date().toISOString();
  // OR condition: expires_at IS NULL OR expires_at > now()
  const { data, error } = await supabase
    .from("saved_searches")
    .select("*")
    .eq("archived", false)
    .or(`expires_at.is.null,expires_at.gt.${nowIso}`);
  if (error) throw new Error(`List active saved searches failed: ${error.message}`);
  return data || [];
}

/**
 * Bulk dedup map: { saved_search_id → Set<event_id> } so the matcher can
 * skip already-notified pairs without N round-trips.
 */
// ───── 2nd-hand ticket notifications (separate dedup table) ─────

async function markTicketNotified(savedSearchId, ticketId) {
  const { error } = await supabase
    .from("saved_search_ticket_notifications")
    .upsert(
      { saved_search_id: savedSearchId, ticket_id: ticketId },
      { onConflict: "saved_search_id,ticket_id" },
    );
  if (error) {
    console.error(`[SavedSearch] Mark ticket-notified failed: ${error.message}`);
  }
}

async function getNotifiedTicketMap(savedSearchIds) {
  if (!Array.isArray(savedSearchIds) || !savedSearchIds.length) return new Map();
  const { data, error } = await supabase
    .from("saved_search_ticket_notifications")
    .select("saved_search_id, ticket_id")
    .in("saved_search_id", savedSearchIds);
  if (error) {
    console.error(`[SavedSearch] Get ticket-notified map failed: ${error.message}`);
    return new Map();
  }
  const map = new Map();
  for (const row of data || []) {
    if (!map.has(row.saved_search_id)) map.set(row.saved_search_id, new Set());
    map.get(row.saved_search_id).add(row.ticket_id);
  }
  return map;
}

async function getNotifiedMap(savedSearchIds) {
  if (!Array.isArray(savedSearchIds) || !savedSearchIds.length) return new Map();
  const { data, error } = await supabase
    .from("saved_search_notifications")
    .select("saved_search_id, event_id")
    .in("saved_search_id", savedSearchIds);
  if (error) throw new Error(`Notified map fetch failed: ${error.message}`);
  const map = new Map();
  for (const row of data || []) {
    if (!map.has(row.saved_search_id)) map.set(row.saved_search_id, new Set());
    map.get(row.saved_search_id).add(row.event_id);
  }
  return map;
}

/**
 * Decrement tickets_remaining and possibly archive.
 *
 * Mode semantics (intentionally aggressive for `one_time`):
 *  - one_time: ANY purchase signal archives the row. Rationale: when the
 *    user searches for "סיור עששיות" and we surface 5 instances on
 *    different dates, marking even ONE as bought means she's done — we
 *    don't want to keep pinging her about the other 4.
 *  - recurring: decrement towards 0; at 0, reset to `tickets_needed` so
 *    the next round of events starts a fresh quota.
 *
 * Returns:
 *  - `null` if the row doesn't track quantity at all
 *  - `{ remaining: <number|null>, archived: <boolean> }` otherwise
 */
async function decrementTicketsRemaining(id, by) {
  const { data: current, error: readErr } = await supabase
    .from("saved_searches")
    .select("tickets_remaining, tickets_needed, mode, telegram_id")
    .eq("id", id)
    .maybeSingle();
  if (readErr) throw new Error(`Read remaining failed: ${readErr.message}`);
  if (!current) return null;

  const baseline = current.tickets_remaining ?? current.tickets_needed ?? 0;
  const remaining = Math.max(baseline - by, 0);

  if (current.mode === "one_time") {
    await supabase
      .from("saved_searches")
      .update({ tickets_remaining: remaining, archived: true })
      .eq("id", id);
    return { remaining, archived: true };
  }

  // Recurring mode: zero rolls over to a fresh quota for next time.
  const next = remaining === 0 ? (current.tickets_needed ?? null) : remaining;
  const { error: writeErr } = await supabase
    .from("saved_searches")
    .update({ tickets_remaining: next })
    .eq("id", id);
  if (writeErr) throw new Error(`Write remaining failed: ${writeErr.message}`);
  return { remaining: next, archived: false };
}

/**
 * Mark a saved search as "found" — explicit user signal, archives now and
 * doesn't touch quantity. Used by the "✅ מצאתי, סיימי לעקוב" button on
 * grouped/batch notifications where decrementing by N doesn't really fit.
 */
async function markFoundAndArchive(id, telegramId) {
  await archiveSavedSearch(id, telegramId);
}

module.exports = {
  createSavedSearch,
  updateSavedSearch,
  findOverlappingSavedSearches,
  listSavedSearches,
  listAllActiveSavedSearches,
  getSavedSearch,
  promoteToRecurring,
  archiveSavedSearch,
  markNotified,
  getNotifiedEventIds,
  getNotifiedMap,
  markTicketNotified,
  getNotifiedTicketMap,
  decrementTicketsRemaining,
  markFoundAndArchive,
};
