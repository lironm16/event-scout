// One-off: reopen enrichment for rows stuck after a transient Gemini failure.
//
// Targets events where:
//   - enrichment_failed_at is set (old binary give-up), AND
//   - we have usable prose (description length > 50), AND
//   - tag_ids is empty (the common partial-failure shape)
//
// Clears failure/retry columns so the normal cron picks them up again.
//
// Usage:
//   node jobs/backfillEnrichmentRetry.js          # dry-run
//   node jobs/backfillEnrichmentRetry.js --apply
require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });
require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env.local") });

const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const MIN_DESCRIPTION_LEN = 50;

async function hasRetryColumns() {
  const { error } = await supabase
    .from("events")
    .select("enrichment_fail_count")
    .limit(1);
  return !(error && /does not exist/i.test(error.message || ""));
}

async function fetchStuckRows() {
  const { data, error } = await supabase
    .from("events")
    .select("id, name, source, tag_ids, description, enrichment_failed_at")
    .eq("archived", false)
    .not("enrichment_failed_at", "is", null)
    .order("id", { ascending: false });
  if (error) throw new Error(error.message);
  return (data || []).filter((row) => {
    const desc = (row.description || "").trim();
    if (desc.length < MIN_DESCRIPTION_LEN) return false;
    const tags = row.tag_ids;
    return !Array.isArray(tags) || tags.length === 0;
  });
}

async function main() {
  const apply = process.argv.includes("--apply");
  const rows = await fetchStuckRows();
  console.log(`[BackfillRetry] ${rows.length} stuck row(s) with description + empty tag_ids`);
  for (const row of rows.slice(0, 20)) {
    console.log(`  #${row.id} ${(row.name || "").slice(0, 50)}`);
  }
  if (rows.length > 20) console.log(`  … and ${rows.length - 20} more`);

  if (!apply) {
    console.log("[BackfillRetry] Dry-run. Pass --apply to reset failure columns.");
    return;
  }
  if (!rows.length) return;

  const ids = rows.map((r) => r.id);
  const patch = { enrichment_failed_at: null };
  if (await hasRetryColumns()) {
    patch.enrichment_fail_count = 0;
    patch.enrichment_fail_reason = null;
    patch.enrichment_next_retry_at = null;
  }
  const { error } = await supabase.from("events").update(patch).in("id", ids);
  if (error) throw new Error(error.message);
  console.log(`[BackfillRetry] Reset ${ids.length} row(s). Run npm run enrich to re-process.`);
}

main().catch((err) => {
  console.error("[BackfillRetry] Fatal:", err.message);
  process.exit(1);
});
