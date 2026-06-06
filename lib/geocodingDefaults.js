// Single source of truth for the default city used when geocoding.
//
// Why a dedicated module:
//   The default city appears in three places — the SQL DEFAULT on
//   `locations.city`, the env var, and several JS callers (the
//   address normalizer, googlePlaces wrapper, geocoding entry). If
//   any of them disagrees we get subtle bugs (e.g. a row created
//   with the SQL default but geocoded with a different env value).
//   Importing from one module keeps them in lockstep.
//
// To extend to multi-city later: replace the single `DEFAULT_CITY`
// with a per-source / per-user lookup. The signature `(city) → city`
// stays the same; only this file changes.

const DEFAULT_CITY = process.env.DEFAULT_GEOCODE_CITY || "רמת גן";

// Approx. centre of Ramat Gan + a sanity radius. A geocoder result farther
// than this from the centre is almost always a wrong-city match (e.g. a
// same-named venue in Jaffa, ~7.6 km away) and is rejected. Preferring the
// source's real street address handles most cases; this is the backstop for
// bare venue names that still slip through.
const CITY_CENTER = { lat: 32.082, lng: 34.814 };
const MAX_KM_FROM_CITY = Number(process.env.MAX_GEOCODE_KM_FROM_CITY) || 7;

module.exports = {
  DEFAULT_CITY,
  CITY_CENTER,
  MAX_KM_FROM_CITY,
};
