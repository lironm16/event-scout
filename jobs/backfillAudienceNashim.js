#!/usr/bin/env node
// One-off: set audience='נשים' on women-only events (currently mis-tagged,
// most often as 'נוער' because the blurb says "נשים צעירות").
//
// Prereq: sql/074_audience_nashim.sql applied in Supabase.
//
//   node jobs/backfillAudienceNashim.js          # live
//   node jobs/backfillAudienceNashim.js --dry     # preview only

require("dotenv").config({ path: require("path").resolve(__dirname, "../.env.local"), override: true });
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

const supabase = require("../lib/supabase");

const DRY = process.argv.includes("--dry");

// Signals that the event is FOR women (not merely ABOUT women, like a
// "נשים בתנ״ך" lecture). Conservative on purpose.
const WOMEN_ONLY = [
  /\bלנשים\s+בלבד\b/, /\bנשים\s+בלבד\b/,
  /סדנ[הא][^.]{0,18}לנשים/, /מרחב[^.]{0,18}לנשים/,
  /קבוצ[הת][^.]{0,18}לנשים/, /מפגש[^.]{0,18}לנשים/, /חוג[^.]{0,18}לנשים/,
  /לנשים\s+צעירות/, /נשים\s+צעירות/,
  /\bאחיות\b/, /קבוצת\s+נשים/,
];
// Never override a clearly-kids audience.
const SKIP_AUDIENCE = new Set(["תינוקות", "ילדים", "לכל המשפחה"]);

function looksWomenOnly(text) {
  const t = String(text || "");
  return WOMEN_ONLY.some((re) => re.test(t));
}

(async () => {
  const { data: rows, error } = await supabase
    .from("events")
    .select("id, name, description, audience, min_months")
    .eq("archived", false)
    .neq("audience", "נשים");
  if (error) { console.error("fetch failed:", error.message); process.exit(1); }

  const hits = (rows || []).filter((r) => {
    if (SKIP_AUDIENCE.has(r.audience)) return false;
    return looksWomenOnly(`${r.name || ""}\n${r.description || ""}`);
  });

  console.log(`[Backfill] ${hits.length} women-only event(s) → audience='נשים'${DRY ? " (DRY)" : ""}`);
  let done = 0;
  for (const r of hits) {
    console.log(`  #${r.id} [${r.audience || "—"}] ${(r.name || "").slice(0, 48)}`);
    if (DRY) continue;
    const patch = { audience: "נשים" };
    if (!(r.min_months >= 216)) patch.min_months = 216; // adult floor
    const { error: uErr } = await supabase.from("events").update(patch).eq("id", r.id);
    if (uErr) console.error(`    ✗ ${uErr.message}`);
    else done++;
  }
  console.log(`[Backfill] done. updated=${done}/${hits.length}`);
  process.exit(0);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
