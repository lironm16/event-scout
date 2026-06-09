// DIVERSE age_range DRY-RUN (NO DB writes). Samples events across audiences +
// age patterns so the output can be reviewed for quality before committing to a
// paid backfill. Uses whatever GEMINI_MODEL is set (default gemini-2.5-flash;
// for previewing on the free tier set GEMINI_MODEL=gemini-flash-latest +
// ENRICH_TIMEOUT_MS=40000).
//
//   GEMINI_MODEL=gemini-flash-latest ENRICH_TIMEOUT_MS=40000 \
//     node jobs/dryRunAgeRangeSample.js [perBucket]

require("dotenv").config({ path: ".env.local" });
require("dotenv").config({ path: ".env" });
const supabase = require("./../lib/supabase");
const enricher = require("../lib/eventEnricher");
const { resolveBounds, formatAgeRangeLabel } = require("../lib/eventAge");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isQuota = (m) => /429|quota|Too Many Requests/i.test(m || "");

const PER = parseInt(process.argv[2], 10) || 2;
const today = new Date().toISOString().slice(0, 10);

// Diverse buckets — patterns we most want to verify.
const BUCKETS = [
  { label: "תינוקות (שלב/חודשים)", filter: (q) => q.eq("audience", "תינוקות") },
  { label: "ילדים", filter: (q) => q.eq("audience", "ילדים") },
  { label: "נוער", filter: (q) => q.eq("audience", "נוער") },
  { label: "מבוגרים", filter: (q) => q.eq("audience", "מבוגרים") },
  { label: "ותיקים", filter: (q) => q.eq("audience", "ותיקים") },
  { label: "לכל המשפחה", filter: (q) => q.eq("audience", "לכל המשפחה") },
  { label: "כותרת 'לא כולל'", filter: (q) => q.ilike("name", "%לא כולל%") },
  { label: "טווח מספרי בשם (X-Y)", filter: (q) => q.or("name.ilike.%גילאי%,name.ilike.%לגילאי%") },
];

(async () => {
  console.log(`model=${process.env.GEMINI_MODEL || "gemini-2.5-flash"} timeout=${process.env.ENRICH_TIMEOUT_MS || 15000}ms  (DRY RUN — no writes)\n`);
  const seen = new Set();
  for (const b of BUCKETS) {
    let q = supabase.from("events")
      .select("id,name,description,umbrella_title,audience,age_range,min_months,max_months")
      .eq("archived", false).gte("date", today);
    q = b.filter(q);
    const { data } = await q.limit(PER * 3);
    const picks = (data || []).filter((e) => !seen.has(e.id)).slice(0, PER);
    if (!picks.length) continue;
    console.log(`\n══ ${b.label} ══`);
    for (const ev of picks) {
      seen.add(ev.id);
      try {
        const res = await enricher.callGemini(ev.name, ev.description || "", [], ev.umbrella_title || null);
        const bnd = resolveBounds(res.age_range);
        console.log(`#${ev.id} "${(ev.name || "").slice(0, 50)}"`);
        console.log(`   audience: ${res.audience}   emoji: ${res.emoji || "-"}`);
        console.log(`   age_range: ${JSON.stringify(res.age_range)}`);
        console.log(`   → "${formatAgeRangeLabel(res.age_range)}"  [${bnd.min_months}..${bnd.max_months}]   (DB now: aud=${ev.audience} [${ev.min_months}..${ev.max_months}])`);
      } catch (e) {
        if (isQuota(e.message)) { console.log(`   ⛔ 429 quota — stopping early.`); return; }
        console.log(`#${ev.id} ERROR ${String(e.message).slice(0, 70)}`);
      }
      await sleep(2500);
    }
  }
  console.log("\n(no writes made.)");
  process.exit(0);
})();
