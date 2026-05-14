// Single source of truth for the filler words we strip from saved-search
// tokens and free-text venue strings.
//
// HISTORY — pre-May-2026 these lived in two separate files: a richer
// SAVE_STOP_WORDS in `savedSearchService.js` (used at save-time) and a
// narrower STOP_WORDS in `savedSearchNotifier.js` (used at match-time).
// The two drifted ("אירועים" was filtered at save but not at notify),
// which contributed to the "watcher label silently became an AND filter"
// bug — see `savedSearchNotifier.js#deriveTokens` for the full story.
//
// After the redesign, tokens are sanitized exactly ONCE at save-time
// (`normalizeTokens`) and the notifier just trusts the array as stored.
// Free-text venue tokens at match-time still need filtering because
// `filters.venue` comes from user input that wasn't pre-cleaned. Both
// callers share this one list to keep behaviour consistent.
//
// EDITING — adding a word here affects:
//   - `normalizeTokens` in savedSearchService.js (token sanitation on save).
//   - `normalizeQueryText` in savedSearchService.js (cosmetic label cleanup).
//   - `venueMatches` in savedSearchNotifier.js (free-text venue tokens).
// Removing a word risks letting that token slip into the matcher; add
// with a moment's thought.

const STOP_WORDS = new Set([
  // First-person / second-person verbs and pronouns from casual asks.
  "אני", "אתה", "את", "אנחנו", "אתם", "הוא", "היא", "הם", "הן",
  "רוצה", "רוצי", "אבקש", "תחפש", "תחפשי", "תראה", "תראי", "תביא",
  "בבקשה", "אולי", "אפשר", "תוכלי", "תוכל",
  "לי", "לו", "לה", "להם", "להן",
  // Hebrew prepositions / particles.
  "של", "על", "את", "אל", "מן", "עם", "כי", "גם", "רק", "עד",
  "זה", "זו", "זאת", "אם", "כך", "כן", "לא", "כמו", "כל",
  // Single-letter prepositions glued onto the next word.
  "ה", "ב", "ל", "ו", "מ", "ש", "כ",
  // Proximity-ish filler ("שקרוב", "אליי") that's actually encoded as
  // structured `filters.proximity` — stripping prevents accidental
  // title-substring matching on these words.
  "שקרוב", "קרוב", "אליי", "אלינו", "אליך", "מקום", "מיקום",
  // Event-category filler — covered by structured filters (audience /
  // ages / activity_types). Without these in the stop-list, a label
  // like "אירועי גאולים" would force every matched event to literally
  // contain "אירועי" — a huge over-fit.
  "כרטיס", "כרטיסים", "מופע", "מופעים", "אירוע", "אירועי", "אירועים",
  "פעילות", "פעילויות",
  "מרכז", "במרכז",
  // Temporal filler — encoded as date_from / date_to ranges.
  "השבוע", "השבועות", "החודש", "השנה", "היום", "מחר", "מחרתיים",
  "בערב", "בבוקר", "בצהריים", "בלילה",
  // English filler (sometimes shows up in mixed-language asks).
  "the", "a", "an", "and", "or", "of", "for", "to", "in", "at", "on",
  "i", "want", "would", "looking", "find", "show", "me", "search",
]);

module.exports = { STOP_WORDS };
