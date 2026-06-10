// One-batch age_range backfill, nearest-date-first, quota-aware.
//
// Fills events.age_range (+ derived min_months/max_months) using the strong
// model (gemini-2.5-flash) for events that don't have it yet. Ordered by date
// ascending (soonest events first). Stops cleanly on a 429 daily-quota error.
//
// State: jobs/.age_backfill_done.json — list of event ids already ATTEMPTED
// (success or "no age info"), so the free-tier 20/day quota is never wasted
// re-processing the same rows. Errors (timeout/429) do NOT mark an id done, so
// they're retried next run. Run repeatedly (cron) until "remaining: 0".
//
//   GEMINI_MODEL=gemini-2.5-flash node jobs/backfillAgeRange.js [batchMax]

process.env.GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
require("dotenv").config({ path: ".env.local" });
require("dotenv").config({ path: ".env" });

const fs = require("fs");
const path = require("path");
const supabase = require("../lib/supabase");
const enricher = require("../lib/eventEnricher");
const { resolveBounds, formatAgeRangeLabel } = require("../lib/eventAge");

const STATE_FILE = path.join(__dirname, ".age_backfill_done.json");
const BATCH_MAX = parseInt(process.argv[2], 10) || 18; // leave a couple for prod
const GAP_MS = 2500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isQuota = (m) => /429|quota|rate.?limit|Too Many Requests/i.test(m || "");

function loadDone() {
  try { return new Set(JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))); }
  catch { return new Set(); }
}
function saveDone(set) {
  fs.writeFileSync(STATE_FILE, JSON.stringify([...set]));
}

(async () => {
  const done = loadDone();
  const today = new Date().toISOString().slice(0, 10);

  // Candidates: active, no age_range yet, soonest first. Pull a generous slab
  // and filter out already-attempted ids in JS (state isn't in the DB).
  const { data: rows, error } = await supabase
    .from("events")
    .select("id, name, description, umbrella_title, min_months, max_months")
    .eq("archived", false)
    .is("age_range", null)
    .gte("date", today)
    .order("date", { ascending: true })
    .limit(400);
  if (error) { console.error("query failed:", error.message); process.exit(1); }

  const queue = (rows || []).filter((e) => !done.has(e.id));
  console.log(`model=${process.env.GEMINI_MODEL} | candidates(no age_range, future)=${(rows||[]).length} | already-attempted=${done.size} | queue=${queue.length} | batchMax=${BATCH_MAX}`);

  let filled = 0, noInfo = 0, processed = 0;
  for (const ev of queue) {
    if (processed >= BATCH_MAX) break;
    try {
      const res = await enricher.callGemini(ev.name, ev.description || "", [], ev.umbrella_title || null);
      const upd = {};
      let b = { min_months: null, max_months: null };
      if (res.age_range) {
        b = resolveBounds(res.age_range);
        upd.age_range = res.age_range;
        upd.min_months = b.min_months;
        upd.max_months = b.max_months;
      }
      // dev_stages can be present even with no chronological age ("סדנת גמילה").
      if (Array.isArray(res.dev_stages) && res.dev_stages.length) {
        upd.dev_stages = res.dev_stages;
      }
      if (Object.keys(upd).length) {
        const { error: uerr } = await supabase.from("events").update(upd).eq("id", ev.id);
        if (uerr) { console.warn(`#${ev.id} update failed: ${uerr.message}`); continue; }
        filled++;
        console.log(`✓ #${ev.id} "${(ev.name||"").slice(0,40)}" → "${formatAgeRangeLabel(res.age_range)}" [${b.min_months}..${b.max_months}]${upd.dev_stages ? " stages="+JSON.stringify(upd.dev_stages) : ""}`);
      } else {
        noInfo++;
        console.log(`· #${ev.id} "${(ev.name||"").slice(0,40)}" → no age info`);
      }
      done.add(ev.id);           // attempted (success or no-info) → never retry
      processed++;
      saveDone(done);            // persist after each so a mid-run crash is safe
      await sleep(GAP_MS);
    } catch (e) {
      if (isQuota(e.message)) {
        console.log(`\n⛔ daily quota hit (429) after ${processed} processed this run — stopping. Will resume next run.`);
        break;
      }
      // timeout / transient → leave un-done, retry next run
      console.warn(`! #${ev.id} ${String(e.message).slice(0,70)} (will retry)`);
      await sleep(GAP_MS);
    }
  }

  // Remaining = future no-age events not yet attempted.
  const { count: remainingFuture } = await supabase
    .from("events").select("id", { count: "exact", head: true })
    .eq("archived", false).is("age_range", null).gte("date", today);
  const remaining = Math.max(0, (remainingFuture || 0) - [...done].length >= 0 ? (remainingFuture || 0) : 0);
  console.log(`\nrun done: filled=${filled}, no-info=${noInfo}, processed=${processed}`);
  console.log(`future events still without age_range (DB): ${remainingFuture}`);
  process.exit(0);
})();
