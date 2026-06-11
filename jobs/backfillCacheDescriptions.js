// Backfill prose descriptions onto cache-hit siblings.
//
// Root cause: the enricher's hash cache (copyFromSource) used to clone only
// the STRUCTURED labels onto a sibling that shared a description_hash, never
// the prose `description`. Result: groups of identical events (e.g. the 7
// "סיור בחווה השיקומית טבע הקשר" rows sharing hash 659a…) where only the row
// that took the full Gemini path got a description, and the cache-hit
// siblings stayed null.
//
// copyFromSource is now fixed for new rows. This one-off repairs existing
// data: for every event with description null, if a sibling with the SAME
// description_hash HAS a non-null description, copy it over. No Gemini, no
// network — pure DB, idempotent, safe to re-run.
//
//   node jobs/backfillCacheDescriptions.js          # apply
//   DRY_RUN=1 node jobs/backfillCacheDescriptions.js # preview only

require("dotenv").config({ path: ".env.local" });
require("dotenv").config({ path: ".env" });

const supabase = require("../lib/supabase");

(async () => {
  const dry = !!process.env.DRY_RUN;

  // 1) All rows missing a description but carrying a hash (so a sibling
  //    lookup is possible). Pull in pages to avoid the 1000-row default cap.
  const missing = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("events")
      .select("id, name, description_hash")
      .is("description", null)
      .not("description_hash", "is", null)
      .range(from, from + 999);
    if (error) { console.error("query failed:", error.message); process.exit(1); }
    missing.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  console.log(`events missing description (with hash): ${missing.length}`);
  if (!missing.length) { console.log("nothing to do."); process.exit(0); }

  // 2) For each distinct hash, fetch one sibling that DOES have a description.
  const hashes = [...new Set(missing.map((e) => e.description_hash))];
  const descByHash = new Map();
  for (const hash of hashes) {
    const { data, error } = await supabase
      .from("events")
      .select("id, description")
      .eq("description_hash", hash)
      .not("description", "is", null)
      .limit(1)
      .maybeSingle();
    if (error) { console.warn(`hash ${hash}: lookup failed — ${error.message}`); continue; }
    if (data?.description) descByHash.set(hash, data.description);
  }
  console.log(`hashes with a usable sibling description: ${descByHash.size}/${hashes.length}`);

  // 3) Apply.
  let filled = 0, noSibling = 0;
  for (const ev of missing) {
    const desc = descByHash.get(ev.description_hash);
    if (!desc) { noSibling++; continue; }
    if (dry) {
      console.log(`would fill #${ev.id} "${(ev.name || "").slice(0, 40)}" ← ${desc.length}ch`);
      filled++;
      continue;
    }
    const { error } = await supabase.from("events").update({ description: desc }).eq("id", ev.id);
    if (error) { console.warn(`#${ev.id} update failed: ${error.message}`); continue; }
    filled++;
    console.log(`✓ #${ev.id} "${(ev.name || "").slice(0, 40)}" ← ${desc.length}ch`);
  }

  console.log(`\n${dry ? "[DRY] " : ""}done: filled=${filled}, no-sibling-description=${noSibling}`);
  process.exit(0);
})();
