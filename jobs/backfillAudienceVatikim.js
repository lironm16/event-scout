#!/usr/bin/env node
// One-off: set audience='ותיקים' on senior-targeted rows still marked 'מבוגרים'.
//
// Prereq: sql/070_audience_vatikim.sql

require("dotenv").config({ path: require("path").resolve(__dirname, "../.env.local"), override: true });
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

const supabase = require("../lib/supabase");
const labelStore = require("../lib/labelStore");
const {
  shouldPromoteToVatikim,
  isSixtyPlusMonths,
} = require("../lib/seniorAudience");

function shouldUpgradeToVatikim(row, tagNames) {
  if (row.audience === "ותיקים") return false;
  if (["תינוקות", "ילדים", "נוער", "הורים"].includes(row.audience)) return false;
  return shouldPromoteToVatikim({
    ...row,
    tags: tagNames,
  });
}

async function main() {
  const { data: rows, error } = await supabase
    .from("events")
    .select(
      "id, name, audience, access, umbrella_title, umbrella_slug, tag_ids, min_months",
    )
    .eq("archived", false)
    .neq("audience", "ותיקים");
  if (error) {
    console.error("fetch failed:", error.message);
    process.exit(1);
  }

  const allTagIds = new Set();
  for (const r of rows || []) for (const id of r.tag_ids || []) allTagIds.add(id);
  const dict = await labelStore.fetchLabelDict([...allTagIds]);

  const updates = [];
  for (const r of rows || []) {
    const tagNames = (r.tag_ids || []).map((id) => dict.get(id)?.name).filter(Boolean);
    if (!shouldUpgradeToVatikim(r, tagNames)) continue;
    updates.push(r);
  }

  console.log(`[Backfill] ${updates.length} rows to set audience=ותיקים`);
  let done = 0;
  for (const r of updates) {
    const patch = { audience: "ותיקים" };
    if (!isSixtyPlusMonths(r.min_months)) patch.min_months = 720;
    const { error: uErr } = await supabase
      .from("events")
      .update(patch)
      .eq("id", r.id);
    if (uErr) {
      console.error(`[Backfill] #${r.id} failed: ${uErr.message}`);
      continue;
    }
    done++;
    if (done <= 10) {
      console.log(`  #${r.id} "${(r.name || "").slice(0, 55)}"`);
    }
  }
  if (done > 10) console.log(`  … and ${done - 10} more`);
  console.log(`[Backfill] done: ${done}/${updates.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
