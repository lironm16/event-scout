// One-off / periodic: delete location rows no longer referenced by ANY event.
//
// Locations are created by the scraper (ensureLocationKey) alongside an event.
// When events are archived away or deleted, their location can be left dangling
// — measured ~54 orphans of 294. They serve no purpose (nothing renders or
// filters off them) and just bloat the venue table + autocomplete sources.
//
// Safe: deletes ONLY locations whose `key` appears in NO events.location_key.
// (events keeps the text in location_key, but display/coords come from the JOIN;
// a row with a key no event points at can never surface.)
//
// Usage:
//   node jobs/cleanOrphanLocations.js          # dry run (count + sample)
//   node jobs/cleanOrphanLocations.js --apply   # delete the orphans

require("dotenv").config();
const supabase = require("./../lib/supabase");

async function allRows(table, col) {
  let from = 0, out = [];
  while (true) {
    const { data, error } = await supabase.from(table).select(col).range(from, from + 999);
    if (error) throw new Error(`${table} fetch: ${error.message}`);
    out.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return out;
}

(async () => {
  const apply = process.argv.includes("--apply");
  const locs = await allRows("locations", "key, raw_address");
  const used = new Set(allRowsToKeys(await allRows("events", "location_key")));
  const orphans = locs.filter((l) => l.key && !used.has(l.key));

  console.log(`locations: ${locs.length} | referenced by events: ${used.size} | ORPHANS: ${orphans.length}`);
  if (!apply) {
    orphans.slice(0, 15).forEach((l) => console.log("  ", l.key, "|", (l.raw_address || "").slice(0, 45)));
    console.log("(dry run — pass --apply to delete)");
    return;
  }
  const keys = orphans.map((l) => l.key);
  let done = 0;
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    const { error } = await supabase.from("locations").delete().in("key", chunk);
    if (error) { console.error("delete chunk failed:", error.message); process.exit(1); }
    done += chunk.length;
  }
  console.log(`✓ deleted ${done} orphan location(s).`);
})().catch((e) => { console.error(e); process.exit(1); });

function allRowsToKeys(rows) {
  return rows.map((e) => e.location_key).filter(Boolean);
}
