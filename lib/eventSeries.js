// Event-series grouping.
//
// Why this exists:
//   In Smarticket every occurrence of a recurring event (e.g.
//   "משחקיית רגעים לגיל לידה עד שנה" running 4× per week) lives as its
//   own row with its own id. When a user asks "what's on this week"
//   we'd send 8 near-identical cards — same title, same venue, just
//   different dates. UX feedback was unambiguous: "זה ממש מעמיס".
//
// What it does:
//   Groups a flat list of events into "series" by a stable
//   identity tuple. The first occurrence (chronologically) is the
//   "representative" the card renders for; all other occurrences are
//   surfaced behind a "כל המופעים" button.
//
// Identity (first match wins):
//   1. `umbrella_slug` when set (sql/054) — all children of a city
//      programme ("מגוון הרצאות לאזרחים ותיקים" with 12 different
//      child titles) collapse to ONE card in search. The card shows
//      the umbrella title + the soonest child's date; "כל אירועי …"
//      lists every sibling.
//   2. Else `(name, min_months, max_months)` for recurring rows.
//   • `location_key` is INTENTIONALLY EXCLUDED. Workshops like
//     "ביכורי תינוקות" run the same content at 6 different community
//     centres — to the user that's ONE event ("when can I attend?"),
//     not six. Pre-2026-05 we keyed on venue and the bot sent six
//     near-identical cards; user feedback made it clear that's
//     wrong. The card renderer compensates by showing
//     "📍 מתקיים במספר מיקומים" when occurrences span venues, and
//     the "כל המופעים" list shows the venue per-occurrence so the
//     user can still pick by location.

function normalizeName(name) {
  if (!name) return "";
  return String(name)
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Build a series identity key for an event. Two events with the same
 * key are considered occurrences of the same series.
 */
function seriesKey(event) {
  if (!event) return null;
  const slug =
    typeof event.umbrella_slug === "string" ? event.umbrella_slug.trim() : "";
  if (slug) return `umb:${slug}`;
  // location_key is deliberately omitted — see top-of-file comment.
  const parts = [
    normalizeName(event.name),
    event.min_months ?? "_",
    event.max_months ?? "_",
  ];
  return parts.join("|");
}

/**
 * Canonical physical-venue identity for an occurrence. Used to bucket
 * occurrences of a series into "same place" vs "different places" —
 * which then decides whether the card should say "מתקיים במספר מיקומים"
 * or pin a single venue at the top.
 *
 * Why this exists separately from `location_key`:
 *   `location_key` is a TEXT slug derived from the raw_address string.
 *   Two rows that resolved the same physical building from slightly
 *   different inputs ("מייקרס" vs "מייקרס, מסובים 2, רמת גן") end up
 *   with DIFFERENT location_keys even though the geocoder gave us the
 *   SAME lat/lng. Bucketing on the text key alone makes a single-venue
 *   series look multi-venue, polluting the "כל המופעים" list with a
 *   redundant venue line. See user feedback "אבל בפועל זה אותו מיקום"
 *   (May 2026, event id 3489).
 *
 * Strategy:
 *   1. If we have a real geocode (lat+lng + found=true), bucket by
 *      rounded coordinates. Five decimal places ≈ ~1m precision,
 *      which collapses near-identical geocodings of the same building
 *      from different inputs without merging neighbouring venues.
 *   2. Else fall back to `location_key` (slug-equality).
 *   3. Else a single shared sentinel — multiple unknown-venue rows
 *      mean "venue unknown", not "many distinct venues".
 *
 * Accepts either the flattened shape (`_coords: { lat, lng }`,
 * `_locationFound`) used by `bot/matchingService.js#flattenEvent` OR
 * a row-shaped object with `lat`/`lng` properties directly — the
 * `rebuildSeriesPayloadFromDb` path in bot/telegramBot.js inlines its
 * own projection and stores coordinates flat.
 */
function venueIdentity(occurrence) {
  if (!occurrence) return "__no_key__";
  const coordsBag = occurrence._coords || occurrence;
  const lat = coordsBag?.lat;
  const lng = coordsBag?.lng;
  // `_locationFound` may be undefined (not all callers populate it).
  // Treat undefined as "trust the coords if they're present" — a geocode
  // that returned (lat, lng) but didn't mark `found=true` is rare in
  // practice and almost always a real venue.
  const explicitlyNotFound = occurrence._locationFound === false;
  if (
    !explicitlyNotFound &&
    typeof lat === "number" &&
    typeof lng === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lng)
  ) {
    return `geo:${lat.toFixed(5)},${lng.toFixed(5)}`;
  }
  // No geocode → we do NOT compare the raw location_key TEXT: the same physical
  // place often has divergent text keys ("כיכר אורדע" vs "כיכר אורדע, כיכר
  // רמב\"ם ר\"ג"), which wrongly splits a single-venue series into "multi-venue".
  // Without coordinates we genuinely don't KNOW it's a different place, so all
  // un-geocoded occurrences share one sentinel (= "venue unknown", not "many
  // venues"). Venue identity is decided ONLY by the precise coordinate column.
  return "__no_key__";
}

/**
 * Sort comparator: chronological by date, then start_time. Events
 * missing one or both fall to the end (we still want them sorted
 * deterministically so the representative pick is stable).
 */
function compareByWhen(a, b) {
  const da = a?.date || "9999-12-31";
  const db = b?.date || "9999-12-31";
  if (da !== db) return da < db ? -1 : 1;
  const ta = a?.start_time || "99:99";
  const tb = b?.start_time || "99:99";
  if (ta !== tb) return ta < tb ? -1 : 1;
  // Stable tie-break by id — keeps test snapshots & rendering
  // deterministic when two occurrences share a slot.
  return (a?.id || 0) - (b?.id || 0);
}

/**
 * Group a list of events into series.
 *
 * Returns an array of `{ key, representative, occurrences }` where:
 *   - `representative` is the chronologically-first event (the one
 *     shown on the card head).
 *   - `occurrences` is the full list of events in the series, sorted
 *     by date+start_time. Length 1 = a "regular" event with no extras.
 *
 * The output series array is itself sorted by the representative's
 * date+time so callers can render in chronological order.
 */
function groupIntoSeries(events) {
  if (!Array.isArray(events) || !events.length) return [];

  const buckets = new Map();
  for (const e of events) {
    if (!e || e.id == null) continue;
    const key = seriesKey(e);
    if (!key) continue;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(e);
  }

  const series = [];
  for (const [key, bucket] of buckets.entries()) {
    bucket.sort(compareByWhen);
    series.push({
      key,
      representative: bucket[0],
      occurrences: bucket,
    });
  }

  series.sort((a, b) => compareByWhen(a.representative, b.representative));
  return series;
}

/**
 * Pick at most `maxSeries` series to render this turn, given the agent
 * has chosen a subset of event ids it considers most relevant.
 *
 * Algorithm:
 *   1. Group ALL hits the agent has seen into series (so we know the
 *      full occurrence list per series).
 *   2. Walk the agent's chosen ids IN ORDER, looking up each id's
 *      series. Take the FIRST `maxSeries` distinct series we hit.
 *      Remaining ids that landed in already-taken series are
 *      "absorbed" by those series (no new card, but their occurrences
 *      are already part of the bucket).
 *
 * Why walk in agent's chosen order: the agent ranks by relevance, so
 * the first series we hit is the most relevant one. Any subsequent id
 * that happens to be in the same series is implicitly de-duplicated.
 *
 * @param {Array} chosenIds
 * @param {Array} allHits  Full set of hits the agent has access to
 *                         (so series occurrence counts are complete,
 *                         not just whatever subset Gemini picked).
 * @param {number} maxSeries
 * @returns {{series: Array, absorbedIds: Array, missingIds: Array}}
 */
function selectSeriesForRender(chosenIds, allHits, maxSeries) {
  const ids = (chosenIds || []).map((n) => parseInt(n, 10)).filter(Number.isFinite);
  if (!ids.length) return { series: [], absorbedIds: [], missingIds: [] };

  const allSeries = groupIntoSeries(allHits || []);
  // Build (event_id → series) lookup so we can resolve agent-chosen ids.
  const idToSeries = new Map();
  for (const s of allSeries) {
    for (const occ of s.occurrences) idToSeries.set(occ.id, s);
  }

  const picked = [];
  const pickedKeys = new Set();
  const absorbed = [];
  const missing = [];
  for (const id of ids) {
    const s = idToSeries.get(id);
    if (!s) {
      missing.push(id);
      continue;
    }
    if (pickedKeys.has(s.key)) {
      absorbed.push(id);
      continue;
    }
    if (picked.length >= maxSeries) {
      // Over the cap — silently drop. Caller reports this back to
      // Gemini so it can mention "יש עוד X — לראות?" if it wants.
      absorbed.push(id);
      continue;
    }
    pickedKeys.add(s.key);
    picked.push(s);
  }

  return { series: picked, absorbedIds: absorbed, missingIds: missing };
}

/** Keep only occurrences whose `date` falls in [dateFrom, dateTo] (inclusive). */
function filterOccurrencesByDateWindow(occurrences, dateFrom, dateTo) {
  if (!Array.isArray(occurrences) || !occurrences.length) return [];
  if (!dateFrom && !dateTo) return occurrences;
  return occurrences.filter((o) => {
    const d = o?.date;
    if (!d) return true;
    if (dateFrom && d < dateFrom) return false;
    if (dateTo && d > dateTo) return false;
    return true;
  });
}

/** Max occurrences per "כל המופעים" message page. */
const SERIES_EXPAND_PAGE_SIZE = 25;
/** On the card, show "25+" when the in-window count exceeds this. */
const SERIES_CARD_COUNT_CAP = 25;

module.exports = {
  seriesKey,
  venueIdentity,
  groupIntoSeries,
  selectSeriesForRender,
  filterOccurrencesByDateWindow,
  SERIES_EXPAND_PAGE_SIZE,
  SERIES_CARD_COUNT_CAP,
  // Exposed for tests.
  _normalizeName: normalizeName,
  _compareByWhen: compareByWhen,
};
