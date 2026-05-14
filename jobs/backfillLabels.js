// One-off backfill driver for sql/026 (normalized labels).
//
// Selects events whose label columns are still empty (`category IS
// NULL` — see eventEnricher's "this row was processed by the new
// pipeline" marker; sql/032 turned the old `category_id` FK column
// into the `category` ENUM column) and re-runs `enrichEventData` on
// each. Sibling and hash caches kick in once the first sibling for a
// given title/body lands, so a fresh run on N events typically issues
// far fewer than N Gemini calls.
//
// Usage:
//   node jobs/backfillLabels.js          # default limit 30
//   node jobs/backfillLabels.js 100      # custom limit
//   node jobs/backfillLabels.js all      # process everything
require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });

const { createClient } = require("@supabase/supabase-js");
const { enrichEventData } = require("../lib/eventEnricher");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const DETAIL_FETCH_GAP_MS = 250; // matches lib/eventEnricher pacing

function parseLimit(arg) {
  if (!arg || arg === "all") return null; // null → no limit
  const n = parseInt(arg, 10);
  if (!Number.isFinite(n) || n <= 0) return 30;
  return n;
}

async function fetchTargets(limit) {
  // We deliberately ignore description_hash — old events still carry
  // v3 hashes from before the migration, but their `category` is NULL
  // because the new schema didn't exist when they were last enriched.
  // Picking by `category IS NULL` is the cleanest "needs enrichment"
  // signal.
  let q = supabase
    .from("events")
    .select("id, name")
    .eq("archived", false)
    .is("category", null)
    .order("id", { ascending: false });
  if (limit) q = q.limit(limit);
  const { data, error } = await q;
  if (error) throw new Error(`Target fetch failed: ${error.message}`);
  return data || [];
}

async function probeMigration() {
  // Cheap probe: select the new column. PostgREST raises a clear error
  // when the column doesn't exist, which lets us bail out early with a
  // useful pointer instead of crashing on the first UPDATE.
  const { error } = await supabase.from("events").select("category").limit(1);
  if (error) {
    if (error.code === "42703" || /column .* does not exist/i.test(error.message || "")) {
      throw new Error(
        "sql/032_audience_category_enums.sql is not applied yet. Run it via Supabase SQL editor and retry.",
      );
    }
    throw new Error(`Migration probe failed: ${error.message}`);
  }
}

async function main() {
  const limit = parseLimit(process.argv[2]);
  await probeMigration();
  console.log(`[Backfill] Selecting up to ${limit ?? "ALL"} events with category IS NULL...`);

  const targets = await fetchTargets(limit);
  console.log(`[Backfill] ${targets.length} target(s) found.`);
  if (!targets.length) {
    console.log("[Backfill] Nothing to do. ✓");
    return;
  }

  let processed = 0;
  let siblings = 0;
  let hashHits = 0;
  let geminiCalls = 0;
  let errors = 0;

  for (let i = 0; i < targets.length; i++) {
    const ev = targets[i];
    try {
      const result = await enrichEventData(ev);
      processed++;
      if (result.source === "sibling_cache") siblings++;
      else if (result.source === "hash_cache") hashHits++;
      else if (result.source === "gemini") geminiCalls++;

      const labelStr = result.labels
        ? `audience=${result.labels.audience || "—"} cat=${result.labels.category} months=${result.labels.min_months}-${result.labels.max_months} tags=[${(result.labels.tags || []).join(",")}]`
        : `← copied from #${result.source_event_id}`;
      console.log(`[Backfill] (${i + 1}/${targets.length}) #${ev.id} "${(ev.name || "").slice(0, 50)}" → ${labelStr} (${result.source})`);
    } catch (err) {
      errors++;
      console.error(`[Backfill] (${i + 1}/${targets.length}) #${ev.id} FAILED: ${err.message}`);
    }

    if (i + 1 < targets.length) {
      await new Promise((r) => setTimeout(r, DETAIL_FETCH_GAP_MS));
    }
  }

  console.log("\n[Backfill] Summary:");
  console.log(`  processed:     ${processed}`);
  console.log(`  sibling-cache: ${siblings}`);
  console.log(`  hash-cache:    ${hashHits}`);
  console.log(`  gemini calls:  ${geminiCalls}`);
  console.log(`  errors:        ${errors}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[Backfill] Fatal:", err.message);
    process.exit(1);
  });
