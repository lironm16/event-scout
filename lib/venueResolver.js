const supabase = require("./supabase");

// Hebrew/English filler we shouldn't require when matching the user's
// venue text against stored locations. "אולם" + "פיס" + "גאולים" should
// all be considered, but "ב" / "של" / "the" shouldn't block a match.
const VENUE_STOP_WORDS = new Set([
  "ה", "ב", "ל", "ו", "מ", "ש", "כ",
  "של", "על", "את", "אל", "מן", "עם", "the", "a", "an", "of",
]);

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[\s,.\-_/()"'״׳]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !VENUE_STOP_WORDS.has(t));
}

/**
 * Resolve a user-typed venue ("גאולים" / "אולם פיס" / "מרכז פיס גאולים")
 * against the cached `locations` table.
 *
 * Strategy:
 *  - tokenize the user's text (drop fillers, lowercase, split on punct)
 *  - require ALL meaningful tokens to be substrings of `raw_address`
 *    (the user-facing venue label, never the geocoder's guess)
 *  - prefer exact-token matches (more tokens hit = better)
 *
 * IMPORTANT — we deliberately do NOT match against `display_name`.
 * `display_name` is whatever Google Places canonicalises the venue to,
 * which can be a totally unrelated street address when the input is
 * short/ambiguous. Real-world example: a row whose user-facing name is
 * "אשכול אופק" got geocoded to `display_name = "גאולים 43, חולון"`
 * because Google guessed Holon. Searching against display_name then
 * surfaced "אשכול אופק" as a candidate for any user query containing
 * "גאולים" — completely wrong. raw_address is the user's actual venue
 * label and is the only safe field for token matching.
 *
 * Returns:
 *  - { status: "matched", location_key, raw_address }            single hit
 *  - { status: "ambiguous", candidates: [{ key, raw_address }] } multiple hits
 *  - { status: "not_found" }                                    no rows match
 */
async function resolveVenue(userText) {
  const wantedTokens = tokenize(userText);
  if (!wantedTokens.length) return { status: "not_found" };

  // Pull a manageable slice — `locations` has at most a few hundred rows
  // in this product (one per unique venue we've seen), so we can afford
  // an in-memory scan rather than building a SQL ILIKE chain.
  const { data, error } = await supabase
    .from("locations")
    .select("key, raw_address, found")
    .eq("found", true)
    .order("last_used_at", { ascending: false })
    .limit(500);
  if (error) {
    console.error("[VenueResolver] locations query failed:", error.message);
    return { status: "not_found" };
  }

  const candidates = [];
  for (const row of data || []) {
    const haystack = (row.raw_address || "").toLowerCase();
    const allHit = wantedTokens.every((t) => haystack.includes(t));
    if (allHit) {
      candidates.push({
        key: row.key,
        raw_address: row.raw_address,
        // Hits = how many of the user's tokens AND how many were "strong"
        // (length >= 4) — we use this to break ties when several rows
        // pass the AND check.
        score: wantedTokens.reduce(
          (s, t) => s + (t.length >= 4 ? 2 : 1) * (haystack.includes(t) ? 1 : 0),
          0,
        ),
      });
    }
  }

  if (!candidates.length) return { status: "not_found" };

  // Sort by score desc, then by raw_address length asc (shorter = more
  // canonical, less noise).
  candidates.sort((a, b) =>
    b.score - a.score || (a.raw_address?.length || 0) - (b.raw_address?.length || 0),
  );

  // If the top candidate is clearly the leader (gap >= 1 strong token)
  // pick it; otherwise treat as ambiguous so the caller can ask the
  // user to disambiguate.
  if (candidates.length === 1 || candidates[0].score - candidates[1].score >= 2) {
    return {
      status: "matched",
      location_key: candidates[0].key,
      raw_address: candidates[0].raw_address,
    };
  }

  return {
    status: "ambiguous",
    candidates: candidates.slice(0, 5).map(({ key, raw_address }) => ({
      key,
      raw_address,
    })),
  };
}

module.exports = { resolveVenue };
