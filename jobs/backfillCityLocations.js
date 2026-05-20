// Backfill location_key for city (rg-muni) events that have no venue.
//
// City events don't have HTML detail pages — their venue should come
// from the CMS API JSON (`content.location`). When that field is absent
// the event lands with `location_key = NULL`.
//
// This script tries to recover those rows by asking Gemini to extract
// a venue from the event's description text, then running the result
// through `ensureLocationKey` (→ geocoding queue) exactly as the live
// scraper does.
//
// Usage:
//   node jobs/backfillCityLocations.js              # default: 50 events
//   node jobs/backfillCityLocations.js 200
//   node jobs/backfillCityLocations.js all
//
// Idempotent: skips events that already have a location_key or have no
// description to extract from.

require("dotenv").config({
  path: require("path").resolve(__dirname, "..", ".env"),
});

const supabase = require("../lib/supabase");
const { extractVenueFromText } = require("../lib/addressNormalizer");
const { ensureLocationKey } = require("../lib/locationResolver");
const { DEFAULT_CITY } = require("../lib/geocodingDefaults");

// Gemini rate-limit courtesy pause between requests
const GEMINI_GAP_MS = 500;

function parseLimit(arg) {
  if (!arg || arg === "all") return null;
  const n = parseInt(arg, 10);
  return Number.isFinite(n) && n > 0 ? n : 50;
}

async function fetchTargets(limit) {
  let q = supabase
    .from("events")
    .select("id, name, description")
    .eq("source", "rg-muni")
    .eq("archived", false)
    .is("location_key", null)
    .not("description", "is", null)
    .order("id", { ascending: false });
  if (limit) q = q.limit(limit);
  const { data, error } = await q;
  if (error) throw new Error(`Target fetch failed: ${error.message}`);
  return data || [];
}

async function main() {
  const limit = parseLimit(process.argv[2]);
  console.log(
    `[BackfillCityLocations] Selecting up to ${limit ?? "ALL"} rg-muni events ` +
      `with location_key IS NULL and a description...`,
  );

  const targets = await fetchTargets(limit);
  console.log(`[BackfillCityLocations] ${targets.length} target(s) found.`);
  if (!targets.length) {
    console.log("[BackfillCityLocations] Nothing to do. ✓");
    return;
  }

  let processed = 0;
  let extracted = 0;
  let filled = 0;
  let skipped = 0;
  let errors = 0;

  for (const event of targets) {
    processed++;
    try {
      const venue = await extractVenueFromText(event.name || "", event.description, {
        city: DEFAULT_CITY,
      });

      if (!venue) {
        skipped++;
        console.log(`  [${processed}/${targets.length}] #${event.id} "${event.name}" — no venue found`);
      } else {
        extracted++;
        console.log(`  [${processed}/${targets.length}] #${event.id} "${event.name}" → "${venue}"`);

        const key = await ensureLocationKey(venue);
        if (key) {
          const { error } = await supabase
            .from("events")
            .update({ location_key: key })
            .eq("id", event.id);

          if (error) {
            errors++;
            console.error(`    ✗ DB write failed: ${error.message}`);
          } else {
            filled++;
            console.log(`    ✓ location_key = "${key}"`);
          }
        }
      }
    } catch (err) {
      errors++;
      console.error(`  [${processed}/${targets.length}] #${event.id} error: ${err.message}`);
    }

    if (processed < targets.length) {
      await new Promise((r) => setTimeout(r, GEMINI_GAP_MS));
    }
  }

  console.log("\n[BackfillCityLocations] Summary:");
  console.log(`  processed:  ${processed}`);
  console.log(`  extracted:  ${extracted}  (Gemini found a venue)`);
  console.log(`  filled:     ${filled}     (location_key written)`);
  console.log(`  skipped:    ${skipped}    (no venue in description)`);
  console.log(`  errors:     ${errors}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[BackfillCityLocations] Fatal:", err.message);
    process.exit(1);
  });
