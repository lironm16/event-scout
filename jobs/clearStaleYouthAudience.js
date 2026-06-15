// One-off: clear the stale "נוער" audience that became a junk bucket.
//
// Finding (2026-06-15): audience="נוער" had become a default-ish dumping
// ground for events that never got a successful CURRENT-prompt Gemini eval.
// Of 113 נוער events, 107 have NO age (min/max_months null), and 43+ of those
// are clearly babies/toddlers by name ("עיסוי תינוקות", "צלילים מלידה",
// "יוגה לזחילה", "קונקט לגילאי 4 חודשים…"). The wrong label is stale data
// preserved across rate-limit retry failures, and the hash cache PROPAGATES it
// to siblings — so a naive re-enrich can re-spread it via a cache hit.
//
// Policy (user, 2026-06-15): "I prefer the default to be NULL rather than נוער
// when we didn't really determine it." So for these undetermined rows:
//   • audience → NULL   (no more wrong "נוער"; matches the honest "unknown")
//   • description_hash → NULL  → forces a FRESH Gemini eval next cycle
//     (no cache hit off a still-wrong sibling)
//   • reset enrichment retry metadata → re-queue
//
// Scope: audience='נוער' AND min_months IS NULL AND max_months IS NULL.
//   The ~6 נוער events that DO carry a real age (genuine 12–18 teen events)
//   are left untouched.
//
// Usage:
//   node jobs/clearStaleYouthAudience.js           # dry run
//   node jobs/clearStaleYouthAudience.js --apply    # perform

require("dotenv").config();
const supabase = require("./../lib/supabase");

(async () => {
  const apply = process.argv.includes("--apply");

  let from = 0, all = [];
  while (true) {
    const { data, error } = await supabase
      .from("events")
      .select("id, name, audience, min_months, max_months")
      .eq("archived", false)
      .eq("audience", "נוער")
      .is("min_months", null)
      .is("max_months", null)
      .range(from, from + 999);
    if (error) { console.error("fetch failed:", error.message); process.exit(1); }
    all = all.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }

  console.log(`Stale null-age "נוער" events to reset → audience NULL + re-enrich: ${all.length}`);
  if (!apply) {
    all.slice(0, 15).forEach((e) => console.log("  ", e.id, (e.name || "").slice(0, 50)));
    console.log("(dry run — pass --apply to reset)");
    return;
  }

  const ids = all.map((e) => e.id);
  let done = 0;
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const { error } = await supabase
      .from("events")
      .update({
        audience: null,                 // honest "unknown" instead of wrong "נוער"
        description_hash: null,          // force a FRESH Gemini eval (no cache hit)
        enrichment_failed_at: null,
        enrichment_fail_count: 0,
        enrichment_fail_reason: null,
        enrichment_next_retry_at: null,
      })
      .in("id", chunk);
    if (error) { console.error("reset chunk failed:", error.message); process.exit(1); }
    done += chunk.length;
  }
  console.log(`✓ reset ${done} events (audience NULL, hash cleared, re-queued for fresh enrichment).`);
})().catch((e) => { console.error(e); process.exit(1); });
