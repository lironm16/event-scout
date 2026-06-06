require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });
const axios = require("axios");
const cheerio = require("cheerio");
const { createClient } = require("@supabase/supabase-js");
const { TENANTS, DEFAULT_SOURCE } = require("../lib/sourceUrls");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const BATCH_SIZE = 10;
const BATCH_DELAY_MS = 500;

// Stubborn events whose location/image isn't in the listing HTML at all
// (community gatherings, private workshops, …) would otherwise be retried
// on every scrape cycle. Cooldown means: if we tried within the last
// COOLDOWN_HOURS and got nothing new, skip them this cycle. They still
// get retried daily in case Smarticket fills in the missing data later.
const COOLDOWN_HOURS = 24;

// "Enriched" = we have any image path on the row. The simpler
// "is the field populated?" check is what we want; the format
// (relative vs absolute) is no longer overloaded as an enriched
// signal — `lib/imageUrl.js#normalizeImageUrl` normalises both
// shapes at read time, so storage stays relative for portability.
function imageIsEnriched(image) {
  return !!(image && String(image).trim());
}

function attemptedRecently(iso) {
  if (!iso) return false;
  const ageMs = Date.now() - new Date(iso).getTime();
  return ageMs < COOLDOWN_HOURS * 60 * 60 * 1000;
}

async function getEventsToEnrich() {
  const { data, error } = await supabase
    .from("events")
    .select(
      "id, source, name, location_key, image, enrichment_last_attempt, locations:location_key(raw_address)",
    )
    .eq("archived", false);

  if (error) throw new Error(`Supabase query failed: ${error.message}`);

  const candidates = data
    .map((e) => ({
      id: e.id,
      source: e.source || DEFAULT_SOURCE,
      name: e.name,
      location: e.locations?.raw_address || null,
      location_key: e.location_key,
      image: e.image,
      enrichment_last_attempt: e.enrichment_last_attempt,
    }))
    .filter((e) => !e.location || !imageIsEnriched(e.image));

  const fresh = candidates.filter((e) => !attemptedRecently(e.enrichment_last_attempt));
  const cooled = candidates.length - fresh.length;
  if (cooled > 0) {
    console.log(`Skipping ${cooled} event(s) on enrichment cooldown (<${COOLDOWN_HOURS}h)`);
  }
  return fresh;
}

/**
 * Fetch ONE tenant's homepage and return its parsed cheerio doc. We
 * then look up each event-card on the doc that corresponds to the
 * tenant the event came from. Failures are non-fatal — we log and
 * return `null` so the rest of enrichment can still process other
 * tenants.
 */
async function fetchListingPage(tenant) {
  const baseUrl = tenant.siteOrigin;
  console.log(`Fetching listing page: ${baseUrl}`);
  try {
    const { data: html } = await axios.get(baseUrl, {
      headers: { "User-Agent": BROWSER_UA },
      timeout: 20_000,
    });
    const $ = cheerio.load(html);
    const eventLinks = $('a[href*="?id="]').length;
    console.log(`  ${tenant.source}: parsed ${eventLinks} event cards from HTML`);
    return $;
  } catch (err) {
    console.error(`  ${tenant.source}: listing fetch failed — ${err.message}`);
    return null;
  }
}

// Fetch the homepage for every Smarticket tenant (in parallel) and
// return a Map<source, $>. A failed tenant is recorded as `null`;
// callers must skip those events rather than crash.
//
// Non-Smarticket tenants (e.g. rg-muni / kind: "city") are
// deliberately excluded. The HTML scrape relies on Smarticket-
// specific markup (`a[href*="?id="]`, `.theater_name`, etc.) — it
// would silently return zero hits for any other site shape, masking
// the fact that we don't even try to enrich those events. City
// events get their location + image data inline from the city API
// (lib/cityApi.js) so they never need this path.
async function fetchListingPagesByTenant() {
  const entries = await Promise.all(
    TENANTS.filter((t) => t.kind === "smarticket").map(
      async (t) => [t.source, await fetchListingPage(t)],
    ),
  );
  return new Map(entries);
}

function extractEventData($, eventId, source) {
  const container = $(`a[href*="id=${eventId}"]`);
  if (!container.length) return null;

  let address = null;
  const theaterDiv = container.find(".theater_name");
  if (theaterDiv.length) {
    // Prefer the embedded Google-Maps link's address (street + city) over the
    // bare venue NAME. A bare name geocodes to the wrong city far too often
    // (e.g. "אשכול אופק" → Jaffa); Smarticket renders the real address inside
    // a <a href="maps.google.com/?q=רועי+קליין+3+רמת+גן">(מפת הגעה)</a>.
    const mapsHref = theaterDiv
      .find("a[href*='maps.goog'], a[href*='google.com/maps'], a[href*='maps.app']")
      .attr("href");
    if (mapsHref) {
      try {
        const u = new URL(mapsHref, "https://maps.google.com");
        const q = u.searchParams.get("q") || u.searchParams.get("daddr");
        if (q) {
          const decoded = decodeURIComponent(q).replace(/\+/g, " ").trim();
          if (decoded.length > 2) address = decoded;
        }
      } catch { /* fall through to the venue text below */ }
    }
    if (!address) {
      theaterDiv.find("span").remove();
      address = theaterDiv.text().replace(/\s+/g, " ").trim() || null;
    }
  }

  let imageUrl = null;
  const img = container.find(".pic img");
  if (img.length) {
    const src = img.attr("data-src") || img.attr("src");
    if (src && !src.includes("no_pic")) {
      // Persist as a RELATIVE path. Smarticket quotes its assets as
      // paths anyway ("/uploads/thumbs/x.jpg"); we just strip the
      // host if the markup happens to inline one. Read-time host
      // resolution lives in `lib/imageUrl.js#normalizeImageUrl` —
      // see the bot photo dispatcher and the saved-search notifier.
      // The `source` argument used to be passed here so the URL
      // resolved against the right tenant host at write time, but
      // doing it at read time is more robust to tenant-host
      // migrations and keeps the column shape consistent.
      if (src.startsWith("http://") || src.startsWith("https://")) {
        try {
          imageUrl = new URL(src).pathname;
        } catch {
          imageUrl = null;
        }
      } else {
        imageUrl = src.startsWith("/") ? src : `/${src}`;
      }
    }
  }

  return { address, imageUrl };
}

async function updateEvent(eventId, updates) {
  updates.last_updated = new Date().toISOString();

  const { error } = await supabase
    .from("events")
    .update(updates)
    .eq("id", eventId);

  if (error) throw new Error(`Update failed for ${eventId}: ${error.message}`);
}

async function processBatch(events, listingsByTenant) {
  const { ensureLocationKey } = require("../lib/locationResolver");
  let updated = 0;
  // `archived` used to be counted here when "not on homepage" was
  // mistakenly equated with "event is dead". The scraper's cleanup
  // pass is now the sole archiver — kept in the return shape for
  // callers (telegramBot's runScrape logs it) but always 0 from
  // the enricher.
  const archived = 0;

  for (const event of events) {
    console.log(`  Processing: ${event.name} (ID: ${event.id}, source: ${event.source})`);

    const $ = listingsByTenant.get(event.source);
    if (!$) {
      // Tenant homepage failed to load. Skip rather than archive — this
      // is a transient network issue, not the event vanishing.
      console.log(`    ⚠ ${event.source} listing unavailable — skipping this cycle`);
      continue;
    }

    const scraped = extractEventData($, event.id, event.source);

    if (!scraped) {
      // The event is alive in the calendar API (otherwise the scraper
      // would have already archived it via the cleanup pass) — it's
      // just not on the tenant's homepage. ramat-gan paginates its
      // homepage to ~20 events, so most events legitimately fail
      // homepage lookup but are perfectly bookable. Don't lie about
      // the row being archived; just stamp the cooldown so we don't
      // retry the same event next cycle.
      //
      // Pre-2026-05-09 we did `markArchived(event.id)` here, which
      // caused a thrash loop with the scraper: enrich archives →
      // scraper un-archives → enrich archives again, forever.
      console.log(`    — Not on ${event.source} homepage; skipping (event still live in calendar API)`);
      try {
        await supabase
          .from("events")
          .update({ enrichment_last_attempt: new Date().toISOString() })
          .eq("id", event.id);
      } catch (err) {
        console.error(`    ✗ Stamp attempt failed: ${err.message}`);
      }
      continue;
    }

    const fields = {};
    if (!event.location && scraped.address) {
      // Insert a pending stub in `locations` (idempotent) and link this event
      // to it via FK. The text never lands on the events row.
      const key = await ensureLocationKey(scraped.address);
      if (key) fields.location_key = key;
    }
    if (!imageIsEnriched(event.image) && scraped.imageUrl) fields.image = scraped.imageUrl;

    if (Object.keys(fields).length === 0) {
      // Stamp the attempt timestamp so we don't retry this same event in
      // the next scrape cycle. The cooldown lets us re-check daily in case
      // Smarticket eventually fills in the missing data.
      try {
        await supabase
          .from("events")
          .update({ enrichment_last_attempt: new Date().toISOString() })
          .eq("id", event.id);
      } catch (err) {
        console.error(`    ✗ Stamp attempt failed: ${err.message}`);
      }
      console.log(`    — Nothing new to extract (cooldown ${COOLDOWN_HOURS}h)`);
      continue;
    }

    // Successful enrich also updates the attempt timestamp via updateEvent
    // (it sets last_updated, but we add the attempt stamp explicitly so
    // both successful and unsuccessful pulls share the same tracking).
    fields.enrichment_last_attempt = new Date().toISOString();

    try {
      await updateEvent(event.id, fields);
      updated++;
      const parts = [];
      if (fields.location_key) parts.push(`location_key="${fields.location_key}"`);
      if (fields.image) parts.push(`image="${fields.image}"`);
      console.log(`    ✓ Updated: ${parts.join(", ")}`);
    } catch (err) {
      console.error(`    ✗ Update failed: ${err.message}`);
    }
  }

  return { updated, archived };
}

async function enrich() {
  console.log(`[${new Date().toISOString()}] Starting enrichment...\n`);

  const events = await getEventsToEnrich();
  if (events.length === 0) {
    console.log("All events already enriched — nothing to do");
    return { processed: 0, updated: 0, archived: 0 };
  }

  console.log(`Found ${events.length} event(s) to enrich\n`);

  const listingsByTenant = await fetchListingPagesByTenant();
  console.log();

  let totalUpdated = 0;
  let totalArchived = 0;

  const totalBatches = Math.ceil(events.length / BATCH_SIZE);
  for (let i = 0; i < events.length; i += BATCH_SIZE) {
    const batch = events.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    console.log(`Batch ${batchNum}/${totalBatches} (${batch.length} events):`);

    const { updated, archived } = await processBatch(batch, listingsByTenant);
    totalUpdated += updated;
    totalArchived += archived;

    if (i + BATCH_SIZE < events.length) {
      await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  console.log(`\nEnrichment complete:`);
  console.log(`  Processed: ${events.length}`);
  console.log(`  Updated:   ${totalUpdated}`);
  console.log(`  Archived:  ${totalArchived}`);
  console.log(`  Skipped:   ${events.length - totalUpdated - totalArchived}`);

  return { processed: events.length, updated: totalUpdated, archived: totalArchived };
}

module.exports = enrich;

if (require.main === module) {
  enrich()
    .then(({ processed }) => console.log(`\nDone — ${processed} events processed`))
    .catch((err) => {
      console.error("Enrichment failed:", err.message);
      process.exit(1);
    });
}
