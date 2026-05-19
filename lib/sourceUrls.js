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
    // The Ramat-Gan municipality runs THREE distinct hosts (verified
    // empirically against the live CDN, 2026-05):
    //   - `api-m.ramat-gan.muni.il`  → JSON: lobby + detail endpoints.
    //   - `www.ramat-gan.muni.il`    → user-facing SPA + booking URLs
    //                                  (`/events/<slug>`).
    //   - `cms-media.ramat-gan.muni.il` → THE actual image CDN. The
    //     `/media/...` paths returned by the JSON API are relative to
    //     this host, NOT to `www.`. Hitting `www.ramat-gan.muni.il/media/...`
    //     silently returns the Angular SPA's `index.html` (3KB of
    //     `<!doctype html>` served with `content-type: text/html`),
    //     and Telegram's `sendPhoto` rejects it with "wrong type of
    //     the web page content" — every rg-muni event card fell back
    //     to text-only as a result. The same path served from
    //     `cms-media.` returns the real JPEG with the right
    //     `image/jpeg` content-type.
    //
    // `siteOrigin` stays on `www.` because the BOOKING URL resolver
    // below (`/events/<slug>/`) needs it. `imageOrigin` is the
    // override consulted by `getImageBase` for `/media/...` paths.
    siteOrigin: "https://www.ramat-gan.muni.il",
    imageOrigin: "https://cms-media.ramat-gan.muni.il",
    // URL resolution for city events follows TWO priorities:
    //
    //   1. `event.external_url` (sql/052) — a non-NULL per-row
    //      registration URL captured from `content.registerLink`
    //      (single events) or `schedule[].registerLink` (umbrella
    //      children). City events whose registration lives on a
    //      third-party booking provider (paykal.co.il for cooking
    //      workshops, bina.org.il for the "טנא מלא כוכבים" event,
    //      …) need the user to land on that provider's product
    //      page, not the city's marketing hub. Smarticket-hosted
    //      register links never reach a city row — the smarticket
    //      scraper handles them with source='mbe-rg' / 'ramat-gan'
    //      and a numeric-id URL.
    //
    //   2. The parent slug page (`/events/<parentSlug>/`) as the
    //      historical default. Used for genuinely register-link-
    //      less city events: free community happenings, multi-
    //      venue umbrellas without a central sign-up, etc.
    //
    // Multi-session umbrellas (e.g. "שישי ישראלי" at 4 parks) are
    // fanned out into child rows by buildCityChildEventRow. Each
    // child carries a synthetic slug of the form
    // `<parentSlug>__<YYYY-MM-DD>__<locId>__<HHMM>`. The CMS only
    // knows the parent slug, so the synthetic suffix gets stripped
    // before building the slug-fallback link.
    //
    // The `__` separator is reserved: cityApi.js uses it ONLY for
    // the child-slug join, never inside individual slug components.
    bookingUrl: (event) => {
      if (event?.external_url) {
        // Trust the captured URL verbatim. We don't validate or
        // re-host because the scraper already discards malformed
        // strings (empty / non-string registerLinks become NULL
        // in buildCity{,Child}EventRow).
        return event.external_url;
      }
      if (!event?.external_slug) {
        throw new Error(
          "rg-muni bookingUrl requires event.external_slug or external_url — " +
            "did you forget to SELECT them?",
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
// tenant's own host (e.g. `/uploads/upld...jpg`). The city tenant
// (rg-muni) splits image hosting off to a dedicated CDN
// (`cms-media.ramat-gan.muni.il`); the rest of the site stays on
// `www.`. Tenants opt in via the optional `imageOrigin` field —
// callers stay generic.
function getImageBase(source) {
  const t = getTenant(source);
  return t.imageOrigin || t.siteOrigin;
}

module.exports = {
  TENANTS,
  DEFAULT_SOURCE,
  getTenant,
  getSiteOrigin,
  getBookingUrl,
  getImageBase,
};
