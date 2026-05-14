const {
  enqueuePendingLocations,
  getPendingLocations,
  normalizeKey,
  isPlaceholderAddress,
  saveLocation,
} = require("./locationStore");
const { geocodeAddress } = require("./geocoding");
const { isVirtualVenue } = require("./virtualVenues");

/**
 * Given a raw venue string, ensure a row exists in `locations` for it and
 * return its canonical key (which doubles as the FK target on
 * `events.location_key`). Idempotent.
 *
 * Three "no-geocode" branches, each producing a row the geocoder
 * worker skips (lat/lng stay null) but which is fully FK'd from
 * `events.location_key` so we can tell "we processed this" from
 * "we never tried":
 *
 *   - virtual venues (Zoom, online, etc.) → source='virtual',
 *     kind='virtual'.
 *   - placeholder venues (source publishes "general" / "TBD" /
 *     "כללי" because the real address is given at registration) →
 *     source='placeholder', kind='placeholder'. Treated identically
 *     to virtual by every downstream consumer that checks lat/lng
 *     before rendering a map link or computing distance — see
 *     sql/036 and `isPlaceholderAddress` in locationStore.js.
 *   - regular addresses → enqueued as pending, geocoder fills
 *     lat/lng on next pass.
 *
 * Returns null only when the input is empty / pure whitespace
 * (genuinely unusable, not even a placeholder).
 */
async function ensureLocationKey(rawAddress) {
  if (isPlaceholderAddress(rawAddress)) {
    const key = normalizeKey(rawAddress);
    // `isPlaceholderAddress` returns true for empty input too — we
    // can't write a row with key="", so bail.
    if (!key) return null;
    await saveLocation({
      key,
      raw_address: rawAddress,
      source: "placeholder",
      found: false,
      kind: "placeholder",
    });
    return key;
  }

  const key = normalizeKey(rawAddress);
  if (!key) return null;

  if (isVirtualVenue(rawAddress)) {
    await saveLocation({
      key,
      raw_address: rawAddress,
      source: "virtual",
      found: false,
      kind: "virtual",
    });
    return key;
  }

  await enqueuePendingLocations([rawAddress]);
  return key;
}

// Nominatim's published policy is 1 request per second. Be a polite citizen.
const NOMINATIM_DELAY_MS = 1100;

/**
 * Resolve every pending row in `locations` by calling `geocodeAddress`. The
 * geocoder writes the final lat/lng (or `found: false`) back to the table, so
 * each venue is hit exactly once over the lifetime of the cache.
 */
async function resolvePending({ logger = console, limit = 500 } = {}) {
  const pending = await getPendingLocations(limit);
  const stats = { pending: pending.length, resolved: 0, failed: 0 };
  if (!pending.length) return stats;

  logger.log(`[Locations] Resolving ${pending.length} pending venue(s)...`);

  for (let i = 0; i < pending.length; i++) {
    const row = pending[i];
    const startedAt = Date.now();
    // Pass the per-row city so each venue is geocoded with its own
    // locality context. `getPendingLocations` synthesizes city =
    // DEFAULT_CITY when the column is missing (pre-031), so this
    // works on both old and new schemas.
    const result = await geocodeAddress(row.raw_address, { city: row.city });
    const tookMs = Date.now() - startedAt;

    if (result) {
      stats.resolved++;
      logger.log(
        `  [${i + 1}/${pending.length}] ✓ "${row.raw_address}" → ${result.lat.toFixed(4)},${result.lng.toFixed(4)} (${result.source})`
      );
    } else {
      // Re-read the row to know whether the geocoder reached a verdict
      // (saved as virtual / not-found) or just hit a transient error.
      const { getLocation } = require("./locationStore");
      const after = await getLocation(row.key);
      let reason = "transient — will retry";
      if (after) {
        if (after.kind === "virtual") reason = "virtual — saved";
        else if (after.found === false) reason = "not in OSM — saved";
      }
      stats.failed++;
      logger.log(`  [${i + 1}/${pending.length}] ✗ "${row.raw_address}" — ${reason}`);
    }

    // Rate-limit any call that actually hit the network. Cache hits return
    // in <200ms; anything slower means we made a Nominatim request — success,
    // 0-results, or 429 — and we MUST stay under Nominatim's "1 req/sec"
    // policy regardless of outcome.
    if (tookMs > 200) {
      await new Promise((r) => setTimeout(r, NOMINATIM_DELAY_MS));
    }
  }

  return stats;
}

module.exports = {
  ensureLocationKey,
  resolvePending,
};
