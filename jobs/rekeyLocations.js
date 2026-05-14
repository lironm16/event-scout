// One-shot scan: every row in `locations` whose `key` no longer
// matches `normalizeKey(raw_address)` is reconciled.
//
// Why we need this:
//   When normalizeKey() is strengthened (see lib/locationStore.js
//   commit history) historical rows keyed by the old, weaker rules
//   suddenly drift from their canonical form. Two outcomes are
//   possible per drifted row:
//
//     (a) The canonical key has NO existing sibling — just rekey
//         the row. `events.location_key` auto-cascades via the
//         ON UPDATE CASCADE FK declared in sql/013, so events
//         keep pointing at the right place.
//
//     (b) The canonical key already exists — the drifted row is
//         a duplicate of the canonical sibling. Merge: redirect
//         this row's events into the sibling, then delete the
//         drifted row. We re-use jobs/mergeLocations.js logic in
//         spirit but inline it here so a single command does the
//         whole bulk pass.
//
// Safe to run multiple times. Pass `--dry-run` to see the plan
// without writing.
//
// Usage:
//   node jobs/rekeyLocations.js [--dry-run]

require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });
const supabase = require("../lib/supabase");
const { normalizeKey } = require("../lib/locationStore");

function parseArgs() {
  const args = process.argv.slice(2);
  return { dryRun: args.includes("--dry-run") };
}

async function fetchAllLocations() {
  // Pull the full table — locations rarely exceeds a few hundred
  // rows, an in-memory scan is simpler than paginating + correcter
  // when planning merges across keys.
  const { data, error } = await supabase
    .from("locations")
    .select("key, raw_address");
  if (error) throw new Error(`locations fetch failed: ${error.message}`);
  return data || [];
}

async function rekeyRow(oldKey, newKey, dryRun) {
  // Direct UPDATE on the PK works thanks to ON UPDATE CASCADE — the
  // FK from events.location_key follows automatically.
  if (dryRun) return;
  const { error } = await supabase
    .from("locations")
    .update({ key: newKey })
    .eq("key", oldKey);
  if (error) throw new Error(`rekey ${oldKey} → ${newKey} failed: ${error.message}`);
}

async function mergeIntoExisting(fromKey, toKey, dryRun) {
  if (dryRun) return;
  // Redirect events first — order matters because once we delete the
  // source location row, its FKs from events would set NULL via the
  // ON DELETE SET NULL declared in sql/013.
  const ev = await supabase
    .from("events")
    .update({ location_key: toKey })
    .eq("location_key", fromKey);
  if (ev.error) throw new Error(`events redirect failed: ${ev.error.message}`);

  const del = await supabase
    .from("locations")
    .delete()
    .eq("key", fromKey);
  if (del.error) throw new Error(`delete locations[${fromKey}] failed: ${del.error.message}`);
}

async function main() {
  const { dryRun } = parseArgs();
  const rows = await fetchAllLocations();
  console.log(`Scanning ${rows.length} rows in locations…`);

  const byKey = new Map(rows.map((r) => [r.key, r]));
  const drifted = [];
  for (const r of rows) {
    const canonical = normalizeKey(r.raw_address);
    if (canonical && canonical !== r.key) {
      drifted.push({ row: r, canonical });
    }
  }

  if (!drifted.length) {
    console.log("✓ No drifted rows. Nothing to do.");
    return;
  }

  console.log(`Found ${drifted.length} drifted row(s):\n`);
  let rekeys = 0;
  let merges = 0;
  for (const { row, canonical } of drifted) {
    const sibling = byKey.get(canonical);
    if (sibling && sibling.key !== row.key) {
      console.log(`  MERGE  "${row.key}"`);
      console.log(`     →   "${canonical}"  (canonical sibling exists)`);
      await mergeIntoExisting(row.key, canonical, dryRun);
      // Update local index so a SECOND drifted row with the same
      // canonical doesn't try to merge into a sibling that just
      // got deleted (unlikely but cheap to guard).
      byKey.delete(row.key);
      merges++;
    } else {
      console.log(`  REKEY  "${row.key}"`);
      console.log(`     →   "${canonical}"`);
      await rekeyRow(row.key, canonical, dryRun);
      // Update local index so a third row drifting onto the same
      // canonical sees this as a sibling.
      byKey.delete(row.key);
      byKey.set(canonical, { ...row, key: canonical });
      rekeys++;
    }
  }

  console.log("");
  console.log(`${rekeys} rekey(s), ${merges} merge(s).`);
  if (dryRun) console.log("--dry-run: no changes written.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[RekeyLocations] Fatal:", err.message);
    process.exit(1);
  });
