const supabase = require("./supabase");
const { DEFAULT_CITY } = require("./geocodingDefaults");

// Normalize a venue string into a stable, deduplicating cache key.
//
// Why it's worth being aggressive here:
//   The cache key is the PRIMARY KEY of the locations table. Two
//   strings that mean the same place must collapse to the same key,
//   or we end up with duplicate rows that all geocode independently
//   (and often to different wrong places). Real-world cases we've
//   hit:
//     "מרכז קהילתי אור (לשעבר חרוזים)"
//     "מרכז קהילתי אור (לשעבר חרוזים).."   ← stray trailing dots
//   …both representing the same place. The trailing-dot row got
//   re-geocoded as a separate entry.
//
// What we DON'T strip (by user rule):
//   Internal punctuation, parens content, dashes — anything that
//   could meaningfully change which place the user means. So
//   "X (לשעבר Y)" and "X (חדש)" stay distinct keys.
function normalizeKey(text) {
  return (text || "")
    .toLowerCase()
    // 1. Drop Unicode bidi / zero-width junk that copy-paste from
    //    websites silently injects. These chars never carry semantic
    //    meaning but they DO change byte equality, so a row pasted
    //    once with U+200F and once without becomes two rows.
    .replace(/[\u200E\u200F\u200B\u202A-\u202E]/g, "")
    // 2. Hebrew quote variants → ASCII (geresh / gershayim).
    .replace(/[׳']/g, "'")
    .replace(/[״"]/g, '"')
    // 3. Trim repeated terminal punctuation. Smarticket sometimes
    //    emits "..", ".", ",", "…" at the end of the venue label.
    //    These are pure typos — never carry meaning — so we strip
    //    them for keying. raw_address keeps the original string
    //    untouched for display.
    .replace(/[.,…]+\s*$/g, "")
    // 4. Collapse whitespace runs to single space.
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Pseudo-addresses that Smarticket data-entry uses as a placeholder
 * when the real venue is unknown / TBD. Real-world example: ramat-gan
 * #3537 ("בצ'אטה") and 14 sibling events all ship with JSON-LD
 * `Place.name = "כללי"` (Hebrew for "general") and an empty
 * streetAddress. If we let those reach the geocoder, Google Places
 * happily maps "כללי, רמת גן" to the municipality building at
 * דרך אבא הלל 77 — a confidently wrong answer worse than no answer
 * at all (the bot now cheerfully tells users a swimming-group event
 * is at city hall).
 *
 * Rejecting at this layer means the event row simply gets
 * `location_key = NULL` until/unless the venue is actually filled in
 * upstream. Downstream UI already handles missing locations
 * gracefully ("מיקום לא זמין" / hide the line).
 *
 * Patterns are matched against the NORMALIZED key, so casing and
 * punctuation variants collapse into the same rule.
 */
const PLACEHOLDER_KEYS = new Set([
  "כללי", "כללית",
  "אין", "אין מיקום",
  "מיקום", "מיקום לא ידוע",
  "tbd", "tba", "n/a", "na",
  "general", "generic", "unknown",
  "?", "??", "???", "-", "--", "---", "—",
]);

function isPlaceholderAddress(text) {
  const k = normalizeKey(text);
  if (!k) return true; // empty / whitespace counts as placeholder
  return PLACEHOLDER_KEYS.has(k);
}

/**
 * User-facing venue text from a locations row. Returns null for
 * `kind = 'placeholder'` so the bot doesn't render `📍 כללי` —
 * those rows exist to preserve the "we processed this; source
 * intentionally hid the address" signal (see sql/036) but should
 * NEVER surface as a venue line.
 *
 * Use this everywhere the bot is about to render `📍 ${location}`.
 * The lat/lng-null check that hides the maps button is already
 * correct for placeholder rows; this closes the parallel gap for
 * the text label.
 *
 * @param {Object|null} loc - The joined `locations` row. Must
 *   include `kind` for the suppression check; if you only selected
 *   `raw_address`, this helper degrades to "always show" — make
 *   sure the SELECT includes `kind`.
 * @returns {string|null}
 */
function displayLocationText(loc) {
  if (!loc) return null;
  if (loc.kind === "placeholder") return null;
  return loc.raw_address || null;
}

/**
 * Look up a cached geocoding result by normalized key.
 *
 * Returns:
 *   - null  when we've never seen the key OR the row is still PENDING
 *           (found IS NULL). In both cases the caller should run the
 *           geocoder, which will fill the row in.
 *   - row   when the lookup is resolved (found = TRUE or FALSE).
 */
async function getLocation(key) {
  if (!key) return null;
  const { data, error } = await supabase
    .from("locations")
    .select(
      "key, raw_address, display_name, lat, lng, source, found, kind, city, created_at, last_used_at"
    )
    .eq("key", key)
    .maybeSingle();

  if (error && error.code !== "PGRST116") {
    // The `city` column was introduced in sql/031. If a deployment
    // hasn't applied that migration yet, the SELECT explodes with
    // "column locations.city does not exist". Fall back to the v1
    // shape and synthesize city = DEFAULT_CITY so callers don't break.
    if (/column .*\bcity\b.* does not exist/i.test(error.message)) {
      const fallback = await supabase
        .from("locations")
        .select(
          "key, raw_address, display_name, lat, lng, source, found, kind, created_at, last_used_at"
        )
        .eq("key", key)
        .maybeSingle();
      if (fallback.error && fallback.error.code !== "PGRST116") {
        console.error("[Locations] getLocation error:", fallback.error.message);
        return null;
      }
      if (!fallback.data) return null;
      if (fallback.data.found === null) return null;
      return { ...fallback.data, city: DEFAULT_CITY };
    }
    console.error("[Locations] getLocation error:", error.message);
    return null;
  }
  if (!data) return null;
  // Pending stub — pretend it's a cache miss so the caller will resolve it.
  if (data.found === null) return null;
  return data;
}

/**
 * Insert pending stubs for any venue strings we haven't seen yet. This keeps
 * the locations table in 1:1 sync with the distinct venue set scraped from
 * Smarticket — every unique venue gets exactly one row, even before the
 * geocoder has run.
 *
 * Existing rows (resolved or failed) are untouched: we use insert + onConflict
 * "do nothing" semantics.
 */
/**
 * @param {string[]} addresses Raw venue strings to enqueue.
 * @param {Object} [opts]
 * @param {string} [opts.city] City context for the geocoder. Defaults
 *   to DEFAULT_GEOCODE_CITY; pass per-source / per-feed when extending
 *   to new markets. Stored on the row so the warmer respects it.
 */
async function enqueuePendingLocations(addresses, opts = {}) {
  if (!Array.isArray(addresses) || !addresses.length) return 0;

  const city = opts.city || DEFAULT_CITY;
  const seen = new Set();
  const rows = [];
  for (const raw of addresses) {
    const key = normalizeKey(raw);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    rows.push({
      key,
      raw_address: raw,
      source: "pending",
      found: null,
      kind: "unknown",
      city,
    });
  }
  if (!rows.length) return 0;

  // Use INSERT ... ON CONFLICT DO NOTHING (supabase-js's
  // `ignoreDuplicates`) instead of check-then-insert.
  //
  // Why we abandoned the SELECT-then-INSERT pattern:
  //   The previous version did a SELECT for existing keys, filtered
  //   them out, and only INSERTed the remainder. That's NOT atomic
  //   in PostgreSQL — two concurrent callers (or two iterations
  //   within a single scrape that produce the same normalized key
  //   from differently-spelled raw addresses) can both observe
  //   "key not present", both proceed to INSERT, and the second one
  //   trips locations_pkey with:
  //     duplicate key value violates unique constraint "locations_pkey"
  //   This was reproduced in the wild during the city-muni rollout,
  //   where multiple events at venues like "מייקרס" share a venue
  //   address that normalises to the same key.
  //
  //   `INSERT ... ON CONFLICT (key) DO NOTHING` collapses both calls
  //   into a single round-trip with the right semantics: existing
  //   rows are PRESERVED unchanged (we don't want to stomp a
  //   resolved row's lat/lng with a pending stub), new rows are
  //   inserted, conflicts are silent.
  //
  //   The trade-off: the return value can no longer report "how
  //   many of your inputs were genuinely new" without a follow-up
  //   read. Callers don't currently use the count for anything
  //   besides a log line, so we report `rows.length` (= candidates
  //   considered) which is honest and cheap.
  const { error } = await supabase
    .from("locations")
    .upsert(rows, { onConflict: "key", ignoreDuplicates: true });
  if (error) {
    // sql/031 hasn't been applied yet — retry without `city` so the
    // pipeline doesn't stall waiting on a manual deploy step.
    if (/column .*\bcity\b.* does not exist/i.test(error.message)) {
      const stripped = rows.map(({ city: _city, ...rest }) => rest);
      const retry = await supabase
        .from("locations")
        .upsert(stripped, { onConflict: "key", ignoreDuplicates: true });
      if (retry.error) {
        console.error("[Locations] enqueue insert (no-city retry) failed:", retry.error.message);
        return 0;
      }
      return stripped.length;
    }
    console.error("[Locations] enqueue insert failed:", error.message);
    return 0;
  }
  return rows.length;
}

/**
 * Fetch every pending row (geocoder hasn't run yet). The worker iterates
 * over this list and calls the geocoder, which writes the final result back.
 */
async function getPendingLocations(limit = 200) {
  const { data, error } = await supabase
    .from("locations")
    .select("key, raw_address, city")
    .is("found", null)
    .limit(limit);
  if (error) {
    if (/column .*\bcity\b.* does not exist/i.test(error.message)) {
      // Pre-031 fallback — synthesize city so the warmer can still work.
      const fallback = await supabase
        .from("locations")
        .select("key, raw_address")
        .is("found", null)
        .limit(limit);
      if (fallback.error) {
        console.error("[Locations] getPendingLocations error:", fallback.error.message);
        return [];
      }
      return (fallback.data || []).map((r) => ({ ...r, city: DEFAULT_CITY }));
    }
    console.error("[Locations] getPendingLocations error:", error.message);
    return [];
  }
  return data || [];
}

function inferKind(entry) {
  if (entry.kind) return entry.kind;
  if (entry.source === "virtual") return "virtual";
  if (entry.found && entry.lat != null && entry.lng != null) return "physical";
  return "unknown";
}

/**
 * Persist a positive ({ lat, lng, ... }) or negative ({ found: false })
 * geocoding result. Idempotent — uses upsert on the primary key.
 *
 * `kind` is inferred when not supplied:
 *   - source='virtual' → 'virtual'
 *   - found=true with coords → 'physical'
 *   - everything else → 'unknown'
 */
async function saveLocation(entry) {
  if (!entry?.key) return;
  const row = {
    key: entry.key,
    raw_address: entry.raw_address || entry.key,
    display_name: entry.display_name || null,
    lat: entry.lat ?? null,
    lng: entry.lng ?? null,
    source: entry.source || "nominatim",
    found: entry.found !== false,
    kind: inferKind(entry),
    city: entry.city || DEFAULT_CITY,
    last_used_at: new Date().toISOString(),
  };
  const { error } = await supabase
    .from("locations")
    .upsert(row, { onConflict: "key" });
  if (error) {
    // sql/031 not yet applied — drop the city field and retry.
    if (/column .*\bcity\b.* does not exist/i.test(error.message)) {
      const { city: _city, ...stripped } = row;
      const retry = await supabase
        .from("locations")
        .upsert(stripped, { onConflict: "key" });
      if (retry.error) {
        console.error("[Locations] saveLocation (no-city retry) error:", retry.error.message);
      }
      return;
    }
    console.error("[Locations] saveLocation error:", error.message);
  }
}

/**
 * Bump last_used_at on a cache hit (best-effort, fire-and-forget).
 */
async function touchLocation(key) {
  if (!key) return;
  await supabase
    .from("locations")
    .update({ last_used_at: new Date().toISOString() })
    .eq("key", key);
}

module.exports = {
  normalizeKey,
  isPlaceholderAddress,
  displayLocationText,
  PLACEHOLDER_KEYS,
  getLocation,
  saveLocation,
  touchLocation,
  enqueuePendingLocations,
  getPendingLocations,
};
