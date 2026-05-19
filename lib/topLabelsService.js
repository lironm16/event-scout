// Paginated fetch of tags from the `labels` dictionary, sorted by
// `events_count DESC`. Powers the new onboarding step that lets a
// user pick interests from the actual top-N tags in the catalog,
// rather than the small curated TOPIC_CATEGORIES list.
//
// Pagination model — OFFSET-based, page size = 12 (5-6 rows × 2
// chips). Page 0 returns the 12 most popular labels with usage > 0;
// page 1 the next 12; etc. We hide labels with `events_count = 0`
// even though sql/050 auto-prunes them — defensive in case the
// trigger lags or the operator just ran a partial backfill.
//
// We return both `id` (numeric, used in Telegram callback_data because
// it's tiny vs the 2-byte-per-char Hebrew name) AND `name` (the
// Hebrew display string + the value we eventually persist into
// `profile.user_context.interests[]`).
//
// `hasMore` is computed by overfetching by 1 row — cheaper than a
// separate COUNT(*) and accurate on the boundary.

const supabase = require("./supabase");

const PAGE_SIZE = 12;

async function fetchTopLabelsPage(offset = 0) {
  if (!Number.isFinite(offset) || offset < 0) offset = 0;

  // Overfetch by 1 so we can answer "is there another page?" without a
  // second round-trip. The N+1th row is sliced off the returned data
  // before we hand it back to callers.
  const limit = PAGE_SIZE + 1;
  const { data, error } = await supabase
    .from("labels")
    .select("id, name, events_count")
    .gt("events_count", 0)
    .order("events_count", { ascending: false })
    .order("id", { ascending: true })  // stable tiebreak
    .range(offset, offset + limit - 1);

  if (error) {
    console.warn("[TopLabels] fetch failed:", error.message);
    return { labels: [], hasMore: false };
  }

  const rows = data || [];
  const hasMore = rows.length > PAGE_SIZE;
  const labels = (hasMore ? rows.slice(0, PAGE_SIZE) : rows).map((r) => ({
    id: Number(r.id),
    name: String(r.name),
    events_count: Number(r.events_count || 0),
  }));
  return { labels, hasMore };
}

// Total count of labels eligible for the picker (events_count > 0).
// Used by the onboarding "🔁 הצג עוד 12/N" button to surface the
// remaining label count to the user. Cheap COUNT(*) query — no
// rows transferred — but we still cache the result for ~60s so a
// user who rapidly paginates doesn't re-issue the same query on
// every press. The number changes only when scrapes complete, so
// staleness within a single onboarding session is fine.
let _countCache = { value: null, fetchedAt: 0 };
const COUNT_TTL_MS = 60_000;

async function countAvailableLabels() {
  const now = Date.now();
  if (_countCache.value != null && now - _countCache.fetchedAt < COUNT_TTL_MS) {
    return _countCache.value;
  }
  const { count, error } = await supabase
    .from("labels")
    .select("*", { count: "exact", head: true })
    .gt("events_count", 0);
  if (error) {
    console.warn("[TopLabels] count failed:", error.message);
    // Fall back to the cached value if we have one, else 0. Never throw
    // — the caller only uses this for UI hints (the "of N" suffix on
    // the show-more button), so a missing count gracefully degrades.
    return _countCache.value || 0;
  }
  _countCache = { value: Number(count || 0), fetchedAt: now };
  return _countCache.value;
}

module.exports = {
  PAGE_SIZE,
  fetchTopLabelsPage,
  countAvailableLabels,
};
