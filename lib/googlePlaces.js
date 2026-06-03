// Google Places API (New) — text search with Hebrew bias for Israel.
//
// Used to resolve free-text venue names like "משחקיית ר״געים" to a real,
// verified address+coordinates. Google's POI database is the same one
// powering google.com/maps; vastly better than Nominatim for small
// Israeli businesses, schools, community centers, etc.
//
// Pricing: First $200/month free (Google's "Maps Platform monthly credit").
// Text Search costs $0.032/request → ~6,250 free requests/month. Our cache
// in `locations` ensures each unique venue is queried at most once.
//
// To enable, set env var `GOOGLE_PLACES_API_KEY`. If unset, this module is
// a no-op and the geocoder falls through to Gemini-normalized Nominatim.

const axios = require("axios");

const PLACES_URL = "https://places.googleapis.com/v1/places:searchText";
const TIMEOUT_MS = 8000;

const apiKey = process.env.GOOGLE_PLACES_API_KEY || null;

// Geographic scope of the events we scrape — NOT the user's location.
// `locationRestriction` is a hard filter: anything Google places outside
// the box is treated as a false positive (this protects against e.g.
// "מרחב ליקוט רמת אפעל" being matched to a moshav with the same name 40km
// away). Override via env vars when adding a data source from a new region.
const BBOX_SOUTH = parseFloat(process.env.PLACES_BBOX_SOUTH || "31.97");
const BBOX_NORTH = parseFloat(process.env.PLACES_BBOX_NORTH || "32.16");
const BBOX_WEST  = parseFloat(process.env.PLACES_BBOX_WEST  || "34.74");
const BBOX_EAST  = parseFloat(process.env.PLACES_BBOX_EAST  || "34.92");

function isEnabled() {
  return Boolean(apiKey);
}

/**
 * Find a place by free-text query, biased to Israel.
 *
 * @param {string} query  Free-text venue / address.
 * @param {Object} [opts]
 * @param {string} [opts.city]  City context appended to the query
 *   when not already present. Hugely reduces ambiguity — Google's
 *   text search treats a trailing city as a hard locality filter,
 *   so "מרכז קהילתי אורות, רמת גן" can NOT come back as "אורים 41,
 *   ת"א". When omitted we keep the legacy bare-text behaviour.
 * @returns {Promise<{lat, lng, name, address, types}|null>}
 *   null on no key, no result, non-200, or any axios failure.
 */
async function findPlace(query, opts = {}) {
  if (!apiKey || !query) return null;
  const raw = String(query).trim();
  if (!raw) return null;

  // Append city if it's not already in the text. Substring match is
  // case-insensitive — "Ramat Gan" in the query collapses with a
  // city='רמת גן' arg only when one of them is romanised, which is
  // rare enough to accept the false-negative (we'd just double-add
  // the city, which Google's parser tolerates).
  const city = opts.city ? String(opts.city).trim() : null;
  const text = city && !raw.toLowerCase().includes(city.toLowerCase())
    ? `${raw}, ${city}`
    : raw;

  try {
    const { data, status } = await axios.post(
      PLACES_URL,
      {
        textQuery: text,
        languageCode: "he",
        regionCode: "IL",
        // HARD restrict to the geographic scope of the events we scrape.
        // Default box covers Tel Aviv metro (where 100% of Smarticket
        // Ramat Gan events live). When adding a data source for another
        // region, widen via PLACES_BBOX_* env vars or replace with a
        // multi-region union. Outside the box, returning null is
        // strictly better than returning the wrong place — the geocoder
        // falls through to Gemini-normalized Nominatim which is accurate
        // for street-name queries anywhere in Israel.
        locationRestriction: {
          rectangle: {
            low:  { latitude: BBOX_SOUTH, longitude: BBOX_WEST },
            high: { latitude: BBOX_NORTH, longitude: BBOX_EAST },
          },
        },
        maxResultCount: 1,
      },
      {
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask":
            "places.displayName,places.formattedAddress,places.location,places.types",
        },
        timeout: TIMEOUT_MS,
        validateStatus: () => true,
      }
    );

    if (status !== 200) {
      console.warn(
        `[GooglePlaces] HTTP ${status} for "${text}":`,
        data?.error?.message || JSON.stringify(data).slice(0, 200)
      );
      return null;
    }

    const place = data?.places?.[0];
    if (!place?.location) return null;

    return {
      lat: place.location.latitude,
      lng: place.location.longitude,
      name: place.displayName?.text || null,
      address: place.formattedAddress || null,
      types: place.types || [],
    };
  } catch (err) {
    console.warn(`[GooglePlaces] failed for "${text}": ${err.message}`);
    return null;
  }
}

// Address autocomplete suggestions (for the Mini App profile address
// field). Israel-wide on purpose — a user's HOME can be anywhere, unlike
// event venues which we restrict to the metro bbox. Returns up to `limit`
// formatted suggestion strings, or [] on no key / failure.
const AUTOCOMPLETE_URL = "https://places.googleapis.com/v1/places:autocomplete";
async function autocomplete(query, limit = 6) {
  if (!apiKey) return [];
  const text = String(query || "").trim();
  if (text.length < 2) return [];
  try {
    const { data, status } = await axios.post(
      AUTOCOMPLETE_URL,
      { input: text, languageCode: "he", regionCode: "IL" },
      {
        headers: { "Content-Type": "application/json", "X-Goog-Api-Key": apiKey },
        timeout: TIMEOUT_MS,
        validateStatus: () => true,
      },
    );
    if (status !== 200) {
      console.warn(`[GooglePlaces] autocomplete HTTP ${status}:`, data?.error?.message);
      return [];
    }
    return (data?.suggestions || [])
      .map((s) => s.placePrediction?.text?.text)
      .filter(Boolean)
      .slice(0, limit);
  } catch (err) {
    console.warn(`[GooglePlaces] autocomplete failed: ${err.message}`);
    return [];
  }
}

module.exports = { findPlace, autocomplete, isEnabled };
