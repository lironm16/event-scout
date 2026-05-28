// Remove "גיל הזהב" discovery tags — audience `ותיקים` + access
// `community-seniors` already encode senior targeting.
//
// Usage: node jobs/backfillRemoveGilHazahavTag.js [--dry-run]

require("dotenv").config({
  path: require("path").resolve(__dirname, "..", ".env"),
});

const supabase = require("../lib/supabase");

const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  const { data: label, error: labelErr } = await supabase
    .from("labels")
    .select("id, name")
    .eq("name", "גיל הזהב")
    .maybeSingle();
  if (labelErr) throw new Error(labelErr.message);
  if (!label) {
    console.log("[BackfillGilHazahav] No גיל הזהב label in DB.");
    return;
  }

  const { data: rows, error } = await supabase
    .from("events")
    .select("id, name, tag_ids")
    .eq("archived", false)
    .contains("tag_ids", [label.id]);
  if (error) throw new Error(error.message);

  console.log(`[BackfillGilHazahav] ${(rows || []).length} row(s) with tag${DRY_RUN ? " (dry-run)" : ""}`);
  let updated = 0;
  for (const row of rows || []) {
    const cleaned = (row.tag_ids || []).filter((id) => id !== label.id);
    if (DRY_RUN) {
      console.log(`  #${row.id} ${(row.name || "").slice(0, 50)} → remove tag`);
      updated++;
      continue;
    }
    const { error: upErr } = await supabase
      .from("events")
      .update({ tag_ids: cleaned })
      .eq("id", row.id);
    if (upErr) console.warn(`  #${row.id} failed: ${upErr.message}`);
    else updated++;
  }
  console.log(`[BackfillGilHazahav] Done. Updated ${updated}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
