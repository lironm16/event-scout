// One-off: re-queue events that PERMANENTLY gave up on enrichment due to
// transient Gemini availability (rate-limit / daily-limit / timeout / error)
// during the early-June 2026 quota crunch.
//
// Why: rows with `enrichment_failed_at` set are skipped by fetchPendingEvents
// forever (sql/072 permanent give-up after ENRICHMENT_MAX_FAILS). These 167
// failed only because Gemini was unavailable — not a data/code problem — so
// many still carry a stale/default audience (e.g. lullabies tagged "ותיקים").
// Clearing the retry metadata puts them back in the enrichment queue; the next
// enrich cycle re-classifies them (many resolve for FREE via the hash cache
// when a sibling is already correctly labelled).
//
// Safe: only clears the retry-METADATA columns. Never touches
// audience/category/tags/description — those are corrected by the re-enrich.
//
// Usage:
//   node jobs/resetFailedEnrichment.js           # dry run (count only)
//   node jobs/resetFailedEnrichment.js --apply   # perform the reset

require("dotenv").config();
const supabase = require("../lib/supabase");

(async () => {
  const apply = process.argv.includes("--apply");

  // Only re-queue TRANSIENT failures — never resurrect a genuine permanent
  // give-up (e.g. a row Gemini repeatedly couldn't parse for a real reason).
  const TRANSIENT = ["gemini_rate_limit", "gemini_daily_limit", "gemini_timeout", "gemini_error"];

  const { data, error } = await supabase
    .from("events")
    .select("id, name, enrichment_fail_reason")
    .eq("archived", false)
    .not("enrichment_failed_at", "is", null)
    .in("enrichment_fail_reason", TRANSIENT);

  if (error) { console.error("fetch failed:", error.message); process.exit(1); }
  console.log(`Transient-failure events to re-queue: ${data.length}`);
  if (!apply) {
    console.log("(dry run — pass --apply to reset)");
    data.slice(0, 10).forEach((e) => console.log("  ", e.id, e.enrichment_fail_reason, (e.name || "").slice(0, 40)));
    return;
  }

  const ids = data.map((e) => e.id);
  // Reset in chunks to stay well under any payload limits.
  let done = 0;
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const { error: upErr } = await supabase
      .from("events")
      .update({
        enrichment_failed_at: null,
        enrichment_fail_count: 0,
        enrichment_fail_reason: null,
        enrichment_next_retry_at: null,
      })
      .in("id", chunk);
    if (upErr) { console.error("reset chunk failed:", upErr.message); process.exit(1); }
    done += chunk.length;
  }
  console.log(`✓ re-queued ${done} events — they'll re-enrich on the next cycle.`);
})().catch((e) => { console.error(e); process.exit(1); });
