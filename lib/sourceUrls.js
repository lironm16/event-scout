// Single source of truth for which Smarticket tenants we scrape and
// where each tenant's URLs live. Anywhere in the codebase that builds
// a booking URL, an image URL, or hits the calendar JSON should go
// through this file — never hardcode `mbe-rg.smarticket.co.il` again.
//
// Why a table:
//   Until 2026-05 we treated Smarticket as a single host
//   (`mbe-rg.smarticket.co.il`) and the URL was an env var. Then we
//   discovered Ramat Gan municipality runs a SECOND, disjoint feed on
//   `ramat-gan.smarticket.co.il` (libraries, workshops, the
//   "מחלקת הקהילה הגאה" department, etc.). Both expose the SAME
//   `/api/show_theater/get_events_calendar` endpoint and the SAME
//   `/event/<id>` redirect to the canonical Hebrew slug page —
//   verified empirically. Each row in `TENANTS` captures everything
//   that differs between the two; the rest of the code stays generic.
//
// ▶ ADDING A NEW TENANT: lockstep with the DB
//   The `events.source` column is a PostgreSQL ENUM (sql/035 —
//   `source_t`). The ENUM and this TENANTS array MUST stay in sync.
//   To add a 3rd source, do BOTH of these in the same change:
//     1. Add the entry to TENANTS below (siteOrigin, calendarUrl).
//     2. Run a one-line migration:
//          ALTER TYPE public.source_t ADD VALUE 'new-tenant';
//        (The keyword IF NOT EXISTS is safe here on PG 12+.)
//   Forgetting step 2 means every upsert tagged with the new
//   source fails with `invalid input value for enum source_t`.
//   That failure mode is intentional — the alternative is silent
//   data corruption with TEXT.

// Each tenant declares either:
//   - a `calendarUrl` (Smarticket-style: numeric ids, paid tickets,
//     standard /event/<id> redirect)
//   - a different `kind` flag (`'city'`) for sources whose URL space
//     and ingestion shape diverge — see lib/cityApi.js for the city
//     municipality API. City events use `external_slug` instead of
//     numeric id for URL construction; the tenant entry carries a
//     `bookingUrl` function that takes the row and produces the URL.
//
// ⚠️ ITERATING `TENANTS` FOR INGESTION:
//   The Smarticket scraper (api/check.js) and the HTML enricher
//   (api/enrich.js) BOTH iterate this array to hit each feed. They
//   MUST filter `t.kind === "smarticket"` first — non-smarticket
//   tenants have no `calendarUrl` and no Smarticket markup on their
//   site, so passing them through produces either "Invalid URL"
//   axios errors (check.js) or silent zero-result fetches
//   (enrich.js). The 2026-05 "[Scrape] rg-muni: fetch FAILED —
//   Invalid URL" log noise was exactly this oversight.
//   Anywhere else that iterates TENANTS for Smarticket-specific
//   work should apply the same filter.
const TENANTS = Object.freeze([
  Object.freeze({
    source: "mbe-rg",
    kind: "smarticket",
    siteOrigin: "https://mbe-rg.smarticket.co.il",
    calendarUrl: "https://mbe-rg.smarticket.co.il/api/show_theater/get_events_calendar",
  }),
  Object.freeze({
    source: "ramat-gan",
    kind: "smarticket",
    siteOrigin: "https://ramat-gan.smarticket.co.il",
    calendarUrl: "https://ramat-gan.smarticket.co.il/api/show_theater/get_events_calendar",
  }),
  Object.freeze({
    source: "rg-muni",
    kind: "city",
    // The detail/lobby API host (api-m subdomain) and the user-
    // visible site host (www) are different. siteOrigin is the
    // user-facing one — that's what booking URLs and image paths
    // resolve against (`/media/...` lives on www).
    siteOrigin: "https://www.ramat-gan.muni.il",
    // Slug-based URLs. `external_slug` lives on the row (sql/038).
    //
    // Multi-session umbrella events (e.g. "שישי ישראלי" running at
    // 4 different parks across June) are fanned out into child rows
    // by buildCityChildEventRow. Each child carries a synthetic slug
    // of the form `<parentSlug>__<YYYY-MM-DD>__<locId>__<HHMM>`
    // (see lib/cityApi.js:1110). The city CMS only knows about the
    // PARENT slug — the synthetic ones don't exist as URLs, so we
    // strip the `__suffix` before building the link. Parent rows
    // (no `__`) pass through unchanged.
    //
    // The `__` separator is reserved: cityApi.js uses it ONLY for the
    // child-slug join, never inside individual slug components.
    bookingUrl: (event) => {
      if (!event?.external_slug) {
        throw new Error(
          "rg-muni bookingUrl requires event.external_slug — " +
            "did you forget to SELECT it?",
        );
      }
      const parentSlug = event.external_slug.split("__", 1)[0];
      return `https://www.ramat-gan.muni.il/events/${parentSlug}/`;
    },
  }),
]);

const TENANTS_BY_SOURCE = new Map(TENANTS.map((t) => [t.source, t]));

// Default tenant for legacy rows that were written before the `source`
// column existed (sql/034 backfilled them as 'mbe-rg', so this matches
// the DB default). Only used when callers pass `undefined`/`null` — a
// genuinely unknown source string still throws so we don't silently
// guess on bad data.
const DEFAULT_SOURCE = "mbe-rg";

function getTenant(source) {
  const key = source || DEFAULT_SOURCE;
  const t = TENANTS_BY_SOURCE.get(key);
  if (!t) {
    throw new Error(
      `Unknown event source: ${JSON.stringify(source)}. ` +
        `Known sources: ${[...TENANTS_BY_SOURCE.keys()].join(", ")}.`,
    );
  }
  return t;
}

function getSiteOrigin(source) {
  return getTenant(source).siteOrigin;
}

// Booking URL — the page a buyer lands on.
//
// Smarticket tenants (mbe-rg, ramat-gan): `/event/<id>` redirects
// (301) to the canonical slug page. Using `/event/<id>` keeps the
// link copy-pasta portable: works whether or not Smarticket has the
// slug live yet.
//
// City municipal tenant (rg-muni): the URL is slug-based — the city
// site has no /event/<numeric-id> entry point. The tenant entry
// carries its own `bookingUrl(event)` function which expects
// `event.external_slug` to be present (sql/038). Callers must
// SELECT `external_slug` when they intend to render a booking
// link for a city event; the function throws loudly otherwise so
// missing-column bugs surface immediately instead of producing a
// broken URL.
function getBookingUrl(event) {
  if (!event) {
    throw new Error("getBookingUrl requires an event");
  }
  const t = getTenant(event.source);
  if (typeof t.bookingUrl === "function") {
    return t.bookingUrl(event);
  }
  if (event.id == null) {
    throw new Error(
      `getBookingUrl: tenant=${t.source} expects event.id but got none`,
    );
  }
  return `${t.siteOrigin}/event/${event.id}`;
}

// Image URL base — Smarticket returns image paths relative to the
// tenant's own host (e.g. `/uploads/upld...jpg`). We need the right
// origin per source to fully-qualify them.
function getImageBase(source) {
  return getSiteOrigin(source);
}

module.exports = {
  TENANTS,
  DEFAULT_SOURCE,
  getTenant,
  getSiteOrigin,
  getBookingUrl,
  getImageBase,
};
