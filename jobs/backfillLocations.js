// One-off backfill for events that landed in the DB before the
// detail-page address-extractor existed (lib/eventEnricher.js
// `extractEventAddress`).
//
// Why this exists:
//   The previous enrichment pipeline only got addresses from the
//   homepage scraper (api/enrich.js). That works fine for mbe-rg
//   (homepage lists every event) but ramat-gan paginates its
//   homepage to ~20 events, so most ramat-gan rows ended up with
//   `location_key = null`. The new enricher reads JSON-LD from the
//   detail page on EVERY new event going forward. This script
//   handles the historical backlog.
//
// Usage:
//   node jobs/backfillLocations.js                     # default: 30 events
//   node jobs/backfillLocations.js 200                 # custom limit
//   node jobs/backfillLocations.js all                 # process everything
//   node jobs/backfillLocations.js all ramat-gan       # one tenant
//
// Idempotent:
//   - Skips events whose `location_key` is already set.
//   - Skips events whose detail page doesn't expose a usable
//     address (mbe-rg detail pages mostly don't — that's expected,
//     their address comes from the homepage instead).
//   - Stamps no DB column to track "we tried" — re-running the
//     script just retries the same events. The detail-page fetch is
//     idempotent and the cost is one HTTP request per skipped row,
//     so this is fine for the scale we operate at.

require("dotenv").config({
  path: require("path").resolve(__dirname, "..", ".env"),
});

const supabase = require("../lib/supabase");
const { fetchDetailHtml, maybeFillLocationKey } = require("../lib/eventEnricher");

const DETAIL_FETCH_GAP_MS = 250; // matches lib/eventEnricher pacing

function parseLimit(arg) {
  if (!arg || arg === "all") return null;
  const n = parseInt(arg, 10);
  if (!Number.isFinite(n) || n <= 0) return 30;
  return n;
}

async function fetchTargets(limit, sourceFilter) {
  let q = supabase
    .from("events")
    .select("id, name, source")
    .eq("archived", false)
    .is("location_key", null)
    .order("id", { ascending: false });
  if (sourceFilter) q = q.eq("source", sourceFilter);
  if (limit) q = q.limit(limit);
  const { data, error } = await q;
  if (error) throw new Error(`Target fetch failed: ${error.message}`);
  return data || [];
}

async function readLocationKey(eventId) {
  // Re-read after `maybeFillLocationKey` to know whether the address
  // was actually written or skipped (silent skip = "detail page didn't
  // expose a usable address"). Cheap PK lookup.
  const { data } = await supabase
    .from("events")
    .select("location_key")
    .eq("id", eventId)
    .maybeSingle();
  return data?.location_key || null;
}

async function main() {
  const limit = parseLimit(process.argv[2]);
  const sourceFilter = process.argv[3] || null;
  const scope = sourceFilter ? `source='${sourceFilter}'` : "all sources";

  console.log(
    `[BackfillLocations] Selecting up to ${limit ?? "ALL"} events with ` +
      `location_key IS NULL (${scope})...`,
  );

  const targets = await fetchTargets(limit, sourceFilter);
  console.log(`[BackfillLocations] ${targets.length} target(s) found.`);
  if (!targets.length) {
    console.log("[BackfillLocations] Nothing to do. ✓");
    return;
  }

  let processed = 0;
  let filled = 0;
  let skipped = 0;
  let errors = 0;

  for (const event of targets) {
    processed++;
    try {
      const html = await fetchDetailHtml(event.id, event.name, event.source);
      await maybeFillLocationKey(event.id, html, event.source);
      const after = await readLocationKey(event.id);
      if (after) filled++;
      else skipped++;
    } catch (err) {
      errors++;
      console.error(`[BackfillLocations] #${event.id} failed: ${err.message}`);
    }

    if (processed % 10 === 0) {
      console.log(
        `  …progress ${processed}/${targets.length}  (filled=${filled} skipped=${skipped} errors=${errors})`,
      );
    }

    if (processed < targets.length) {
      await new Promise((r) => setTimeout(r, DETAIL_FETCH_GAP_MS));
    }
  }

  console.log("\n[BackfillLocations] Summary:");
  console.log(`  processed:  ${processed}`);
  console.log(`  filled:     ${filled}`);
  console.log(`  skipped:    ${skipped}  (no usable address on detail page)`);
  console.log(`  errors:     ${errors}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[BackfillLocations] Fatal:", err.message);
    process.exit(1);
  });
