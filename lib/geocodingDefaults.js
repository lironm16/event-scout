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

module.exports = {
  DEFAULT_CITY,
};
