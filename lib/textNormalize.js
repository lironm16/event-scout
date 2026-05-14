/**
 * Single source of truth for "how do we compare strings during search?".
 *
 * The same transformation is applied:
 *   - in JS, before sending an ILIKE term to Supabase
 *   - in Postgres, on the `events.name_normalized` generated column
 *     (sql/010_event_name_normalized.sql)
 *
 * Keep this in sync with the SQL regex.
 *
 * Removes:
 *   - ASCII quotes/apostrophes:     "  '  `
 *   - Hebrew geresh / gershayim:    ׳  ״
 *   - Curly/typographic quotes:     “ ” ‘ ’ ´
 *   - Common punctuation noise:     . , ; : ! ?
 * Then collapses runs of whitespace and lowercases.
 *
 * Examples:
 *   normalizeForSearch('משחקיית ר"געים')  → 'משחקיית רגעים'
 *   normalizeForSearch("ר׳געים")           → 'רגעים'
 *   normalizeForSearch('Theater "X" — 5+') → 'theater x — 5+'
 */
const STRIP_REGEX = /[\u0027\u0022\u0060\u00B4\u05F3\u05F4\u2018\u2019\u201C\u201D.,;:!?]+/g;

function normalizeForSearch(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(STRIP_REGEX, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Split a free-text user query into searchable tokens for OR-matching.
 * Drops Hebrew/English stop-words that are too generic to filter on.
 */
const STOPWORDS = new Set([
  // Hebrew themes that the categories field already covers
  "אירוע", "אירועים", "פעילות", "פעילויות",
  "הצגה", "הצגות", "סדנה", "סדנאות", "מופע", "מופעים",
  // Hebrew prepositions / connectors
  "של", "עם", "את", "אל", "על", "ל", "ב",
  // English equivalents
  "the", "a", "an", "and", "or", "for", "to",
  "event", "events", "activity", "activities", "show", "shows", "workshop", "workshops",
]);

function tokenizeQuery(text) {
  const normalized = normalizeForSearch(text);
  if (!normalized) return [];
  return normalized
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

module.exports = { normalizeForSearch, tokenizeQuery, STRIP_REGEX };
