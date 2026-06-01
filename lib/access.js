// Shared community-access classifier.
//
// Two callers feed this module:
//
//   * lib/cityApi.js — runs every cycle for `rg-muni`, classifies
//     from the city CMS's structured `category.name` / `cluster[].name`
//     / venue text. The signals are short, hand-curated strings.
//
//   * api/check.js — runs every cycle for Smarticket events, classifies
//     from the event title (and description when present). The
//     signals are free-text Hebrew labels the venue chose for the
//     ticket page. Title alone gives surprisingly good precision
//     because Smarticket tenants advertise community membership in
//     the title ("למילואימניקים.ות …", "Pride Night — קהילה גאה",
//     "ערב הורים לילדים עם צרכים מיוחדים"). Description acts as a
//     fallback when the title is generic.
//
// Why one shared module:
//   Two months ago the rule list lived only in cityApi.js. The
//   2026-05 reservist cycle exposed Smarticket events with the
//   same access semantics, and copy-pasting the regex list there
//   would have created two sources of truth. Centralising here
//   means adding a new community is one regex in one place.
//
// What this module does NOT do:
//   * It does not decide whether to STORE `access='open'` vs.
//     leaving the existing value alone — that's the caller's
//     policy (city scraper always wins; Smarticket only overwrites
//     when we have a positive signal). The classifier just
//     answers "what scope does this text imply?".
//   * It does not maintain a separate Hebrew vs. English list —
//     the regexes are case-insensitive and accept either, so
//     ramat-gan events with English titles ("Pride", "Miluim
//     night") are caught too.

// Each rule: { access, match: RegExp } where `access` is one of the
// `access_t` ENUM values defined in sql/039 (+ sql/057 for miluim).
//
// Order doesn't matter — we stop at the first match and the rules
// are mutually exclusive in practice (no event is run by both the
// disabilities and the LGBTQ department, for example). If a future
// rule competes, swap to "longest-text-match wins" rather than
// reordering blindly.
const ACCESS_RULES = [
  {
    access: "community-disabilities",
    // Catches "ילדים ובוגרים עם מוגבלות" and any future variants
    // referencing disability ("מוגבלויות", "עם צרכים מיוחדים", etc.)
    match: /מוגבלות|מוגבלויות|צרכים\s*מיוחדים|חינוך\s*מיוחד/,
  },
  {
    access: "community-lgbtq",
    // "הקהילה הגאה" (category) or "המרכז הגאה" (venue/cluster).
    // The single word "גאה" in Hebrew is a safe signal in this
    // context — the city CMS uses it exclusively for LGBTQ content.
    // "ЛГБТ" is the Cyrillic abbreviation for LGBT — appears in
    // Russian-language event titles like "ЛГБТ русскоязычный".
    // Note: \b word-boundary does NOT work for Cyrillic in JS (Cyrillic
    // chars are \W, so there's never a \w/\W transition around them).
    // We use a lookahead/lookbehind against Cyrillic letters instead.
    match: /הקהילה\s*הגאה|המרכז\s*הגאה|קהילה\s*גאה|\bpride\b|(?<![А-ЯЁа-яёЄІЇА-ЯҐ])ЛГБТ(?![А-ЯЁа-яёЄІЇА-ЯҐ])/i,
  },
  {
    access: "community-seniors",
    // Catches the city's standard senior-targeted phrasings:
    //   • "אזרחים ותיקים" — the polite Hebrew for senior citizens,
    //     used by the city CMS for the umbrella "מגוון הרצאות
    //     מרתקות לאזרחים ותיקים ברחבי העיר" and similar.
    //   • "מועדון ותיקים" — the standard name for senior clubs.
    //   • "הגיל השלישי" — formal phrase, with or without "בלבד".
    //   • "for-age-60-and-over" — comes straight from the umbrella
    //     urlName (`lectures-for-age-60-and-over`). English fallback
    //     for any future bilingual flyers ("seniors" / "elderly").
    //
    // We deliberately DO NOT match the bare word "ותיקים" because
    // it appears in club names of any age ("מועדון ותיקי רמת חן",
    // "ותיקי הצנחנים") that aren't necessarily senior-only. The
    // construct-state "ותיקי X" is widespread; the noun phrase
    // "אזרחים ותיקים" / "מועדון ותיקים" is specific enough.
    match: /הגיל\s*השלישי|אזרחים\s*ותיקים|מועדון\s*ותיקים|רק\s*ל\s*60\+|\b60\s*\+\s*בלבד|for[-_ ]age[-_ ]60[-_ ]and[-_ ]over|\bseniors?\b|\belderly\b/i,
  },
  {
    access: "community-miluim",
    // Trigger words for events explicitly run for reserve duty
    // veterans. The vast majority of Hebrew miluim events spell it
    // "מילואים" / "למילואימניק" / "למילואימניקים.ות" — the second
    // form is informal but extremely common on Smarticket titles.
    // English fallback for the rare bilingual flyer.
    //
    // Why this is safe (no false positives expected):
    //   * "מילואים" is a closed cultural concept — the only Hebrew
    //     phrase that uses this root is the reserves. Compare to
    //     a generic word like "צעירים" which would over-match.
    //   * We require the WORD, not just the root letters
    //     (`\b`-equivalent via `\bמילוא`-style assertions don't
    //     work in Hebrew the same way), so we lean on the surrounding
    //     three-letter sequence and accept the small false-positive
    //     risk in exchange for catching titles like "פק״ל קפה
    //     ולמילואימניקים".
    // No \b around Hebrew — JS word boundaries don't work on Hebrew letters.
    match:
      /מילואים|למילואימניק|מילואימניק|משרת[יי]\.?\s*ות?\s*מילואים|משרת[יי]ם?\s*מילואים|מילואים\s*פעיל|\bmiluim\b|\breservists?\b/i,
  },
  {
    access: "community-olim",
    // New immigrants (עולים) — not Russian-only events (those stay
    // community-russian via the rule below). Placed before the Russian
    // rule so "לעולים מרוסיה" does not match here.
    match:
      /עולים\s*חדשים|עולה\s*חדש|עולים\s*חדש|new\s+olim|olim\s+hadashim|עדיפות\s+ל[-\s]*עולים|priority\s+for\s+new\s+olim|לעולים(?!\s*מ?\s*רוס)|\bolim\b|אולפן\s*לעולים|מועדון\s*לעולים|ערב\s+לעולים/i,
  },
  {
    access: "community-russian",
    // Russian-speaking community events. Two signals:
    //
    //   1. Any run of 3+ Cyrillic letters in the text. In the
    //      Israeli events context Cyrillic appears EXCLUSIVELY in
    //      events targeted at the Russian-speaking community —
    //      Hebrew transliterates Russian names back to Hebrew
    //      letters ("ירוסלב" not "Ярослав"), so a real Cyrillic
    //      sequence in a title is a clean positive signal. The
    //      3-character floor guards against incidental single
    //      letters (none observed in our corpus, but cheap to
    //      require).
    //
    //   2. Explicit Hebrew references to the Russian-speaking
    //      community, for events whose titles are in Hebrew but
    //      whose audience the venue advertises in the body /
    //      umbrella ("ערב לדוברי רוסית", "מועדון לעולים מרוסיה").
    //      We deliberately do NOT match the bare word "רוסית"
    //      because it appears in non-community contexts ("ספרות
    //      רוסית" — Russian literature, taught to Hebrew speakers).
    //      Same construct-state caution as community-seniors above.
    //
    // English / Latin variants ("russian-speaking", "rusofones")
    // are caught by the explicit-mention regex too — rare in
    // practice but cheap to include.
    match: /[\u0400-\u04FF]{3,}|דוברי\s*רוסית|דוברת\s*רוסית|לעולים\s*מ?רוסיה|קהילה\s*דוברת\s*רוסית|\brussian[-\s]?speak/i,
  },
];

/**
 * Match `text` against every rule and return the FIRST hit's access
 * value, or null if no rule fires.
 *
 * Use `classifyAllAccessFromText` when you need ALL matching scopes
 * (e.g. an event like "ЛГБТ русскоязычный" that is simultaneously
 * community-lgbtq AND community-russian).
 */
function classifyAccessFromText(text) {
  if (!text || typeof text !== "string") return null;
  for (const rule of ACCESS_RULES) {
    if (rule.match.test(text)) return rule.access;
  }
  return null;
}

/**
 * Like `classifyAccessFromText` but returns ALL matching scopes as
 * an array, or null when nothing matches. Callers that write to the
 * DB should use this so multi-community events (e.g. an LGBTQ event
 * whose title is in Russian) get both tags stamped.
 */
function classifyAllAccessFromText(text) {
  if (!text || typeof text !== "string") return null;
  const hits = ACCESS_RULES.filter((r) => r.match.test(text)).map(
    (r) => r.access,
  );
  return hits.length > 0 ? hits : null;
}

/**
 * Convenience: classify a Smarticket-style event using the title
 * plus an optional description. Returns the access scope or null
 * (caller treats null as "don't overwrite existing value").
 *
 * Returns only the FIRST match. Use `classifyAllAccessForEvent` when
 * you need all matching scopes (i.e. when writing to the DB).
 */
function classifyAccessForEvent({ name, description }) {
  return (
    classifyAccessFromText(name) ||
    classifyAccessFromText(description) ||
    null
  );
}

/**
 * Like `classifyAccessForEvent` but collects ALL matching scopes
 * across both title and description, deduped. Returns an array of
 * scope strings or null when no community signal is found.
 *
 * Example: name="ЛГБТ русскоязычный" → ['community-lgbtq', 'community-russian']
 * Example: name="ערב מילואים" → ['community-miluim']
 * Example: name="ערב קיץ" → null (caller keeps existing DB value)
 */
function classifyAllAccessForEvent({ name, description }) {
  const seen = new Set();
  for (const text of [name, description]) {
    for (const scope of classifyAllAccessFromText(text) || []) {
      seen.add(scope);
    }
  }
  return seen.size > 0 ? Array.from(seen) : null;
}

module.exports = {
  ACCESS_RULES,
  classifyAccessFromText,
  classifyAllAccessFromText,
  classifyAccessForEvent,
  classifyAllAccessForEvent,
};
