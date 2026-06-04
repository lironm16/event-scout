// One-off: re-enrich ALL non-archived events from scratch via Gemini.
//
// Resets the enrichment markers so every row becomes "pending", then runs
// enrichPendingEvents in a loop until drained. Audience/category/tags/age
// are OVERWRITTEN as each row reprocesses, so there's no degraded window
// (we only null description_hash + failure markers, not the live values).
//
// The bot should be STOPPED while this runs (avoid double Gemini calls).
// Raise the daily cap for the run:  ENRICHER_DAILY_GEMINI_LIMIT=1000
//
//   node jobs/reEnrichAll.js
//   node jobs/reEnrichAll.js --reset-only   # just reset markers, don't run

require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env.local"), override: true });
require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });

const supabase = require("../lib/supabase");
const enricher = require("../lib/eventEnricher");

const RESET_ONLY = process.argv.includes("--reset-only");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function resetMarkers() {
  const { count } = await supabase
    .from("events").select("id", { count: "exact", head: true }).eq("archived", false);
  // Core reset: null the hash (→ "never enriched") + clear permanent give-up.
  const { error } = await supabase
    .from("events")
    .update({ description_hash: null, enrichment_failed_at: null })
    .eq("archived", false);
  if (error) throw new Error(`reset core failed: ${error.message}`);
  // Best-effort: retry-tracking columns (may not exist on older schemas).
  for (const patch of [{ enrichment_fail_count: 0 }, { enrichment_next_retry_at: null }]) {
    const { error: e2 } = await supabase.from("events").update(patch).eq("archived", false);
    if (e2) console.warn(`  (skip ${Object.keys(patch)[0]}: ${e2.message})`);
  }
  return count;
}

(async () => {
  console.log("[reEnrich] resetting enrichment markers on non-archived events…");
  const n = await resetMarkers();
  console.log(`[reEnrich] reset ~${n ?? "?"} rows.`);
  if (RESET_ONLY) { console.log("[reEnrich] --reset-only; done."); process.exit(0); }

  let round = 0, totalProcessed = 0, totalClassified = 0, totalErrors = 0;
  while (true) {
    round++;
    const r = await enricher.enrichPendingEvents(20);
    totalProcessed += r.processed || 0;
    totalClassified += r.classified || 0;
    totalErrors += r.errors || 0;
    console.log(
      `[reEnrich] round ${round}: processed=${r.processed} classified=${r.classified} errors=${r.errors}` +
        (r.skipped_no_key ? " (NO GEMINI KEY)" : "") +
        (r.daily_limit_reached ? " (DAILY LIMIT REACHED)" : ""),
    );
    if (r.skipped_no_key || r.skipped_no_migration) break;
    if (r.daily_limit_reached) { console.log("[reEnrich] hit daily Gemini cap — stopping; re-run tomorrow or raise ENRICHER_DAILY_GEMINI_LIMIT."); break; }
    if (!r.processed) break; // drained
    await sleep(800);
  }
  console.log(`[reEnrich] DONE. rounds=${round} processed=${totalProcessed} classified=${totalClassified} errors=${totalErrors}`);
  process.exit(0);
})().catch((e) => { console.error("[reEnrich] FATAL", e.message); process.exit(1); });
