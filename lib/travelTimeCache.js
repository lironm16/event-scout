// Persistent, cross-user cache for Google Routes travel times.
//
// Layered on top of lib/googleRoutes.js (which keeps a process-local Map at
// ~11 m precision). Here we add a Supabase-backed cache keyed on a COARSE
// home grid (~1 km) so neighbours share rows and the cache survives
// restarts. See sql/073_travel_time_cache.sql for the rationale.
//
// Flow per (home, venue, mode):
//   1. DB read — fresh row (within TTL) → return its minutes.
//   2. miss/stale → call the Routes API once, upsert the row, return.
// On any DB error we degrade to calling the API directly (never throw).

const supabase = require("./supabase");
const googleRoutes = require("./googleRoutes");

// 90 days: travel times between two fixed points barely change. Long TTL
// keeps the API call count low; the worst case is a slightly stale ETA.
const TTL_MS = 90 * 24 * 60 * 60 * 1000;

// ~1.1 km cells for the origin (strong cross-user sharing); ~110 m for the
// venue (venues are a bounded, already-distinct set).
function cell(lat, lng, decimals) {
  const f = 10 ** decimals;
  return `${Math.round(lat * f) / f},${Math.round(lng * f) / f}`;
}

function homeCell(coords) {
  return cell(coords.lat, coords.lng, 2);
}

function venueCell(coords) {
  return cell(coords.lat, coords.lng, 3);
}

/**
 * Travel minutes for (origin → dest, mode), DB-cached across users/restarts.
 * Returns minutes (number) or null (same contract as googleRoutes).
 */
async function getTravelMinutesCached(origin, dest, mode) {
  if (!origin?.lat || !origin?.lng || !dest?.lat || !dest?.lng) return null;
  const hCell = homeCell(origin);
  const vCell = venueCell(dest);

  try {
    const { data, error } = await supabase
      .from("travel_time_cache")
      .select("minutes, computed_at")
      .eq("home_cell", hCell)
      .eq("venue_cell", vCell)
      .eq("mode", mode)
      .maybeSingle();
    if (!error && data && data.minutes != null) {
      const age = Date.now() - new Date(data.computed_at).getTime();
      if (age < TTL_MS) return data.minutes;
    }
  } catch (err) {
    console.warn("[TravelCache] read failed:", err.message);
  }

  const minutes = await googleRoutes.computeTravelMinutes(origin, dest, mode);
  if (minutes == null) return null;

  try {
    await supabase
      .from("travel_time_cache")
      .upsert(
        {
          home_cell: hCell,
          venue_cell: vCell,
          mode,
          minutes,
          computed_at: new Date().toISOString(),
        },
        { onConflict: "home_cell,venue_cell,mode" },
      );
  } catch (err) {
    console.warn("[TravelCache] write failed:", err.message);
  }
  return minutes;
}

module.exports = { getTravelMinutesCached, homeCell, venueCell };
