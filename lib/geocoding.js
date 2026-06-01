const axios = require("axios");
const { normalizeKey, getLocation, saveLocation, touchLocation } = require("./locationStore");
const { isVirtualVenue } = require("./virtualVenues");
const { lookupVenue } = require("./venues");
const { normalizeAddress } = require("./addressNormalizer");
const googlePlaces = require("./googlePlaces");
const googleRoutes = require("./googleRoutes");
const { DEFAULT_CITY } = require("./geocodingDefaults");

// Travel-time estimation.
//
// PRIMARY: Google Routes API (`lib/googleRoutes.js`). Real road network +
// live traffic = the same ETA the user sees when they tap "🧭 נווט". Hits
// an in-process cache so repeated cards for the same (home, venue) pair
// are free. Requires GOOGLE_PLACES_API_KEY (same key, Routes API must be
// enabled in the GCP project alongside Places).
//
// FALLBACK: haversine (great-circle) × calibrated circuity + speed. Used
// when the API key is missing, the Routes API errors, or the call times
// out. Still ballpark-correct for the "is this walkable?" gate but the
// minute count can drift 20-50% from reality.
//
// Calibration of the fallback:
//   1. Speed: lower than free-flow because urban movement is interrupted
//      (signals, crosswalks, parking, traffic). Calibrated against
//      Google's own ETAs in Ramat Gan / Tel Aviv.
//   2. Circuity: the ratio of actual path distance to as-the-crow-flies
//      distance. Streets bend, dead-ends force detours, sidewalks dogleg
//      around buildings. Industry-standard urban circuity is 1.3-1.7;
//      we use the upper-mid range because Ramat Gan has hills and
//      one-way streets.
const WALKING_KM_PER_HOUR = 4.5;
const WALKING_CIRCUITY = 1.6;
const WALKING_MIN_PER_KM = (60 / WALKING_KM_PER_HOUR) * WALKING_CIRCUITY;
const DRIVING_KM_PER_HOUR = 22;
const DRIVING_CIRCUITY = 1.5;
const DRIVING_MIN_PER_KM = (60 / DRIVING_KM_PER_HOUR) * DRIVING_CIRCUITY;
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

// In-process LRU-ish cache. Keys are the normalized form, values are either a
// { lat, lng, source, display_name } record or null when the address has been
// confirmed un-geocodable. Process-local; the *real* cache is the locations
// table in Supabase, which survives restarts.
const geocodeCache = new Map();

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function walkMinutesFromKm(km) {
  return Math.round(km * WALKING_MIN_PER_KM);
}

function driveMinutesFromKm(km) {
  // Round up to a minimum of 3 minutes — even a 1-minute drive realistically
  // takes longer once you factor in parking, exiting the lot, etc.
  return Math.max(3, Math.round(km * DRIVING_MIN_PER_KM));
}

/** Straight-line km cap matching a drive-minute budget (heuristic, no Routes API). */
function kmForDriveMinutes(minutes) {
  if (!minutes || minutes <= 0) return 0;
  return minutes / DRIVING_MIN_PER_KM;
}

/**
 * Look up coordinates for an address/venue using a layered cache:
 *
 *   1. In-process Map (fastest, lost on restart).
 *   2. Persistent `locations` table in Supabase (cache survives restarts).
 *   3. Static `lib/venues.js` mapping (curated overrides, hand-verified).
 *   4. Nominatim / OpenStreetMap (one network call per *new* address).
 *
 * Every result — positive AND negative — is written back to the DB cache so
 * the same string is never sent to a remote map API twice.
 */
/**
 * @param {string} address Free-text venue / address.
 * @param {Object} [opts]
 * @param {string} [opts.city] City hint. Forwarded to every geocoder
 *   (LLM normalizer, Google Places, Nominatim) and persisted on the
 *   resulting locations row. Defaults to DEFAULT_CITY.
 */
async function geocodeAddress(address, opts = {}) {
  if (!address) return null;
  const key = normalizeKey(address);
  if (!key) return null;
  const city = opts.city || DEFAULT_CITY;

  // 0) Virtual / non-physical venues — never hit the network. Persist the
  // verdict so this string is resolved-as-virtual on subsequent lookups.
  if (isVirtualVenue(address)) {
    geocodeCache.set(key, null);
    saveLocation({
      key,
      raw_address: address,
      source: "virtual",
      found: false,
      kind: "virtual",
      city,
    }).catch(() => {});
    return null;
  }

  // 1) In-process cache
  if (geocodeCache.has(key)) return geocodeCache.get(key);

  // 2) Persistent DB cache
  try {
    const cached = await getLocation(key);
    if (cached) {
      const result = cached.found && cached.lat != null && cached.lng != null
        ? {
            lat: cached.lat,
            lng: cached.lng,
            source: cached.source || "db",
            display_name: cached.display_name || undefined,
          }
        : null;
      geocodeCache.set(key, result);
      // fire-and-forget last_used_at bump
      touchLocation(key).catch(() => {});
      return result;
    }
  } catch (err) {
    console.warn("[Geocoding] DB cache read failed:", err.message);
  }

  // 3) Local curated venue mapping
  const venue = lookupVenue(address);
  if (venue) {
    const result = { lat: venue.lat, lng: venue.lng, source: "venues", display_name: venue.name };
    geocodeCache.set(key, result);
    saveLocation({
      key,
      raw_address: address,
      display_name: venue.name,
      lat: venue.lat,
      lng: venue.lng,
      source: "venues",
      found: true,
      kind: "physical",
      city,
    }).catch(() => {});
    return result;
  }

  // 4) Google Places API — best for finding real-world venues by name
  //    ("משחקיית ר״געים", "מרכז קהילתי בית עמנואל"). Same data source
  //    Google Maps uses on the navigate button. Skipped if no API key is
  //    configured.
  //
  // When the raw address has a STREET NUMBER, Google Places can be
  // mis-led by a venue-name prefix in front of the actual address —
  // empirically observed on "אולם ספורט ביה"ס הגפן -בינימין 28 רמת גן"
  // where Google latched onto "אולם ספורט" and returned the wrong
  // sports complex at "דרך הטייסים 85" instead of the school at
  // "בנימין 28". To prevent that, we pre-clean the text with
  // `normalizeAddress` (Gemini-flash) and try BOTH the cleaned and
  // raw queries; if their results disagree we prefer the cleaned one,
  // because Gemini is reliably stripping the misleading prefix.
  //
  // Pure venue names without a number ("תיאטרון יהלום") skip this —
  // they hit Google's POI search directly, which handles them best.
  if (googlePlaces.isEnabled()) {
    // Trigger the Gemini pre-clean when the raw address looks like a
    // VENUE-PREFIXED string (e.g. "אולם ספורט מורדי הגטאות",
    // "בית ספר ויצמן - מנדס 55"). Google's POI search is reliably
    // mis-led by the venue-noun prefix: queries starting with
    // "אולם ספורט" hit the city's main sports complex
    // ("דרך הטייסים 85, רמת גן") regardless of the rest of the string.
    // Stripping the prefix before sending fixes it.
    //
    // We DON'T pre-clean for pure POI names ("בית עמנואל",
    // "סנימטק תל אביב") — those are exactly what Google's POI search
    // is best at. The heuristic fires only when at least one of:
    //   - the string starts with a known venue-noun prefix
    //   - the string contains a hyphen separating prefix from address
    //   - the string contains a digit (likely a street number)
    // Each unique venue is pre-cleaned at most once thanks to the
    // `locations` DB cache, so the extra Gemini latency only hits
    // the first ingest of a new venue.
    const hasStreetNumber = /\d/.test(address);
    const hasHyphen = /-/.test(address);
    const hasVenuePrefix = /^\s*(?:אולם\s+ספורט|בית\s+ספר|בי["״׳']?ס|ביה["״׳']?ס|מרכז\s+(?:קהילתי|תרבות|נוער|פיס|הצעירים)|מועדון\b|תיאטרון|אודיטוריום|היכל)/u.test(address);
    let cleanedAddress = null;
    if (hasStreetNumber || hasHyphen || hasVenuePrefix) {
      try {
        const hint = await normalizeAddress(address, { city });
        if (hint && hint.toLowerCase() !== address.toLowerCase()) {
          cleanedAddress = hint;
        }
      } catch {
        /* fall through; we'll just send raw */
      }
    }

    // Try cleaned first (when available) — Google rarely benefits
    // from venue-name prefixes when a clean street address is also on
    // hand, and is actively harmed by it for "אולם ספורט"-style cases.
    let place = null;
    if (cleanedAddress) {
      console.log(`[Geocoding] LLM pre-clean "${address}" → "${cleanedAddress}"`);
      place = await googlePlaces.findPlace(cleanedAddress, { city });
    }
    if (!place) {
      place = await googlePlaces.findPlace(address, { city });
    }
    if (place) {
      const result = {
        lat: place.lat,
        lng: place.lng,
        source: "google_places",
        display_name: place.address || place.name || undefined,
      };
      geocodeCache.set(key, result);
      saveLocation({
        key,
        raw_address: address,
        display_name: result.display_name,
        lat: result.lat,
        lng: result.lng,
        source: "google_places",
        found: true,
        kind: "physical",
        city,
      }).catch(() => {});
      return result;
    }
  }

  // 5) Remote geocoder. We hand the venue text to Gemini first to produce a
  //    clean street address (Hebrew abbreviations expanded, venue-name
  //    prefixes stripped, well-known landmarks resolved). The cleaned
  //    address is then sent to Nominatim. If Gemini returns the same
  //    string or null, we fall through to the original.
  let queryAddress = address;
  let normalizedHint = null;
  try {
    normalizedHint = await normalizeAddress(address, { city });
    if (normalizedHint && normalizedHint.toLowerCase() !== address.toLowerCase()) {
      console.log(`[Geocoding] LLM normalized "${address}" → "${normalizedHint}"`);
      queryAddress = normalizedHint;
    }
  } catch {
    /* fall through with original address */
  }

  // Append city to Nominatim query when the address doesn't already
  // contain it. Same idea as Google Places — anchors the search to
  // the right locality and prevents Nominatim from confidently
  // returning a same-named street in another city.
  const nominatimQuery = city && !queryAddress.toLowerCase().includes(city.toLowerCase())
    ? `${queryAddress}, ${city}`
    : queryAddress;

  try {
    const { data } = await axios.get(NOMINATIM_URL, {
      params: { q: nominatimQuery, format: "json", limit: 1, countrycodes: "il" },
      headers: { "User-Agent": "EventScout/1.0 (contact: bot)" },
      timeout: 8000,
    });

    if (!data?.length) {
      geocodeCache.set(key, null);
      saveLocation({
        key,
        raw_address: address,
        display_name: normalizedHint || null,
        source: "nominatim",
        found: false,
        city,
      }).catch(() => {});
      return null;
    }

    const result = {
      lat: parseFloat(data[0].lat),
      lng: parseFloat(data[0].lon),
      source: "nominatim",
      display_name: data[0].display_name,
    };
    geocodeCache.set(key, result);
    saveLocation({
      key,
      raw_address: address,
      display_name: result.display_name,
      lat: result.lat,
      lng: result.lng,
      source: "nominatim",
      found: true,
      kind: "physical",
      city,
    }).catch(() => {});
    return result;
  } catch (err) {
    console.warn(`[Geocoding] Nominatim failed for "${nominatimQuery}":`, err.message);
    // Don't cache transient network errors — let the next attempt retry.
    return null;
  }
}

// Walk-vs-drive threshold is now driven by the user's preference, not a
// fixed straight-line km cut-off. The previous spec used 1.5 km which
// renders as ~28-32 minutes of walking in our model — fine for an avid
// walker, way too long for a parent with a stroller or anyone with
// limited time. Move to a minute-based threshold so each user gets a
// label that matches THEIR tolerance.
//
// DEFAULT_MAX_WALK_MINUTES applies when the user hasn't pinned a value
// in their profile (`constraints.max_walking_minutes`). 15 is roughly:
//   - 1 km straight-line with our circuity (= 1.6 km route),
//   - the upper bound most non-runners consider "I'll just walk it".
// Bumping above 25 reintroduces the original "🚶 30 דק׳" problem;
// dropping below 10 makes nearby venues feel artificially out of reach.
const DEFAULT_MAX_WALK_MINUTES = 15;

// Inverse of walkMinutesFromKm — gives us the straight-line km that
// corresponds to a given walking-minutes target, used as the fast-path
// gate before paying for a Google Routes call.
function kmThresholdForWalkMinutes(minutes) {
  if (!minutes || minutes <= 0) return 0;
  return minutes / WALKING_MIN_PER_KM;
}

// Backward-compat export. Kept as the threshold for the DEFAULT user
// (no `max_walking_minutes` on profile), so any external caller that
// still reads this value gets a number consistent with the new logic.
const WALKABLE_KM_LIMIT = kmThresholdForWalkMinutes(DEFAULT_MAX_WALK_MINUTES);

function formatDistance(km) {
  return km < 1 ? `${Math.round(km * 1000)} מ'` : `${km.toFixed(1)} ק"מ`;
}

/**
 * Evaluate distance from user's home to a venue.
 *
 * Returns one of:
 *   - { resolved: true, km, walk_minutes, within_preference, requires_car,
 *       long_walk_warning, label, navigate_address, venue_coords } when both
 *     home + venue could be located.
 *   - { resolved: false, reason: "no_home" | "no_venue" | "ungeocodable",
 *       venue_text, label } when we could NOT compute a distance. Callers
 *     should ASK the user how far they're willing to travel rather than
 *     fabricating a number.
 */
/**
 * @param {{lat:number,lng:number}|null} homeCoords
 * @param {string|null} venueText
 * @param {number|null} maxWalkMinutes
 * @param {{lat:number,lng:number}|null} [preResolvedVenueCoords]
 *   Optional pre-computed venue coordinates. When provided, we skip the
 *   geocoder lookup entirely — useful when the caller already JOINed
 *   `locations` and has the lat/lng in hand.
 * @param {Object} [opts]
 * @param {string} [opts.city] City hint forwarded to geocodeAddress when
 *   we have to resolve the venue ourselves. Ignored when
 *   preResolvedVenueCoords are supplied.
 * @param {boolean} [opts.useRoutesApi=true] When false, skip Google Routes
 *   (haversine only). Use for bulk search/profile filters — one search
 *   used to call Routes per event and blew the QPM quota.
 */
async function evaluateProximity(homeCoords, venueText, maxWalkMinutes = null, preResolvedVenueCoords = null, opts = {}) {
  const useRoutesApi = opts.useRoutesApi !== false;
  // Virtual venues short-circuit BEFORE any home/coord checks — distance is
  // undefined for online events; we just want a friendly "online" label.
  if (venueText && isVirtualVenue(venueText)) {
    return {
      resolved: false,
      reason: "virtual",
      venue_text: venueText,
      label: "🌐 מפגש מקוון",
    };
  }

  if (!homeCoords?.lat || !homeCoords?.lng) {
    // Caller should have asked for an address before getting here. We return a
    // silent unresolved record so the card omits the distance line entirely.
    return { resolved: false, reason: "no_home", venue_text: venueText || null, label: null };
  }
  if (!venueText && !preResolvedVenueCoords) {
    return { resolved: false, reason: "no_venue", venue_text: null, label: null };
  }

  const venueCoords =
    preResolvedVenueCoords?.lat != null && preResolvedVenueCoords?.lng != null
      ? preResolvedVenueCoords
      : await geocodeAddress(venueText, { city: opts.city });

  if (!venueCoords) {
    // OSM/Nominatim doesn't index every Israeli small venue (playgrounds,
    // private studios). Stay quiet on the card — the Google Maps button still
    // works because Google's POI database is far richer than OSM's.
    return { resolved: false, reason: "ungeocodable", venue_text: venueText, label: null };
  }

  const km = haversineKm(homeCoords.lat, homeCoords.lng, venueCoords.lat, venueCoords.lng);

  // Per-user walk tolerance. `maxWalkMinutes` flows from the caller's
  // profile (`constraints.max_walking_minutes`); fall back to the
  // default when missing OR explicitly null. We treat 0 the same as
  // "use default" — a profile that says "0 minutes of walking" is
  // almost certainly a bug, not a deliberate choice.
  const effectiveMaxWalkMin =
    Number.isFinite(maxWalkMinutes) && maxWalkMinutes > 0
      ? maxWalkMinutes
      : DEFAULT_MAX_WALK_MINUTES;
  const kmLimit = kmThresholdForWalkMinutes(effectiveMaxWalkMin);

  // Fast-path decision: straight-line km vs. the user's minute-derived
  // km limit. Avoids a Google Routes call when the venue is clearly
  // far. The actual minute count for the SELECTED mode is then
  // refined by the API; we don't compute both — the card only shows
  // one label anyway.
  const requiresCar = km > kmLimit;
  const mode = requiresCar ? "drive" : "walk";

  // Fast path: heuristic numbers (used as fallback if the API call fails).
  let walkMinutes = walkMinutesFromKm(km);
  let driveMinutes = driveMinutesFromKm(km);
  let source = "heuristic";

  const apiMinutes = useRoutesApi
    ? await googleRoutes.computeTravelMinutes(homeCoords, venueCoords, mode)
    : null;
  if (apiMinutes != null) {
    source = "google_routes";
    if (mode === "walk") {
      walkMinutes = apiMinutes;
    } else {
      // Floor at 3 min for drive (parking, exiting lot, etc.) to match
      // the heuristic's lower bound and avoid jarring "1 דק'" labels.
      driveMinutes = Math.max(3, apiMinutes);
    }
  }

  // `within_preference` historically meant "the user's walking-minute
  // preference was satisfied". With the new model the preference IS
  // the cutoff, so this collapses to "we chose to label this as walk".
  // Keep the field for backward compatibility with savedSearchNotifier
  // and any future caller that wants the soft signal.
  const userExpectsWalk = !!maxWalkMinutes;
  const longWalkWarning = userExpectsWalk && requiresCar;

  let within = false;
  let icon;
  let label;

  if (!requiresCar) {
    within = walkMinutes <= effectiveMaxWalkMin;
    icon = "🚶";
    label = `🚶 ~${walkMinutes} דק' הליכה`;
  } else {
    within = false;
    icon = "🚗";
    label = `🚗 ~${driveMinutes} דק' נסיעה`;
  }

  return {
    resolved: true,
    km,
    walk_minutes: walkMinutes,
    drive_minutes: driveMinutes,
    within_preference: within,
    requires_car: requiresCar,
    long_walk_warning: longWalkWarning,
    icon,
    label,
    navigate_address: venueCoords.display_name || venueText,
    venue_coords: venueCoords,
    travel_time_source: source,
  };
}

module.exports = {
  haversineKm,
  walkMinutesFromKm,
  driveMinutesFromKm,
  kmForDriveMinutes,
  kmThresholdForWalkMinutes,
  DEFAULT_MAX_WALK_MINUTES,
  geocodeAddress,
  evaluateProximity,
  WALKABLE_KM_LIMIT,
};
