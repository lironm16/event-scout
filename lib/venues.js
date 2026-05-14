/**
 * Hardcoded coordinates for common venues in the Ramat Gan / Tel Aviv area.
 * Lookups normalize Hebrew/English aliases. Add more as you encounter them.
 *
 * IMPORTANT: only add an entry here if you have *verified* coordinates.
 * If unsure, leave it out — the geocoding pipeline will fall through to
 * Nominatim (OpenStreetMap), which is more reliable than a guess.
 *
 * Removed (Theater Russell) on 2026-05-02: the previous coordinates were
 * inaccurate and produced impossible "7 min walk from Nachlieli 4" labels.
 * Until verified by hand against OSM/Google, fall through to Nominatim.
 */

const VENUES = [
  {
    // NOTE: "יהלום" alone is intentionally NOT an alias — it also
    // matches "בית ספר יהלום" (a school at קריניצי 68, completely
    // different venue). Require "תיאטרון" to disambiguate.
    aliases: ["yahalom theater", "תיאטרון יהלום"],
    name: "תיאטרון יהלום",
    address: "אבא הלל סילבר 2, רמת גן",
    lat: 32.0853, lng: 34.8127,
  },
  {
    aliases: ["מרכז פיס גאולים", "merkez pais geulim", "פיס גאולים"],
    name: "מרכז פיס גאולים",
    address: "המעפילים 10, רמת גן",
    lat: 32.0762, lng: 34.8221,
  },
  {
    aliases: ["נקודת מפגש", "z'abotinski 107", "ז'בוטינסקי 107"],
    name: "נקודת מפגש",
    address: "דרך זאב ז'בוטינסקי 107, רמת גן",
    lat: 32.0833, lng: 34.8194,
  },
  {
    aliases: ["היכל התרבות רמת גן", "heichal hatarbut ramat gan"],
    name: "היכל התרבות רמת גן",
    address: "דרך אבא הלל 60, רמת גן",
    lat: 32.0832, lng: 34.8082,
  },
  {
    aliases: ["מוזיאון רמת גן", "ramat gan museum"],
    name: "מוזיאון רמת גן לאמנות ישראלית",
    address: "אבא הלל סילבר 146, רמת גן",
    lat: 32.0783, lng: 34.8174,
  },
  {
    aliases: ["צוותא", "tzavta"],
    name: "צוותא",
    address: "אבן גבירול 30, תל אביב",
    lat: 32.0794, lng: 34.7775,
  },
  {
    aliases: ["סינמטק תל אביב", "tel aviv cinematheque"],
    name: "סינמטק תל אביב",
    address: "שפרינצק 2, תל אביב",
    lat: 32.0654, lng: 34.7710,
  },
  {
    aliases: ["הבימה", "habima"],
    name: "תיאטרון הבימה",
    address: "כיכר הבימה, תל אביב",
    lat: 32.0746, lng: 34.7793,
  },
  {
    aliases: ["סטריט תיאטרון", "מיני תיאטרון"],
    name: "מיני תיאטרון רמת גן",
    address: "ז'בוטינסקי 56, רמת גן",
    lat: 32.0816, lng: 34.8129,
  },
];

function normalize(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[׳']/g, "'")
    .replace(/[״"]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function lookupVenue(text) {
  if (!text) return null;
  const n = normalize(text);
  for (const venue of VENUES) {
    for (const alias of venue.aliases) {
      if (n.includes(normalize(alias))) return venue;
    }
  }
  return null;
}

module.exports = { VENUES, lookupVenue };
