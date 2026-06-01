#!/usr/bin/env node
// One-off backfill: add `community-miluim` to events.access where the
// title (or מילואימניקים tag) signals a reservist-community event.
//
// Two selection paths, OR'd together:
//   1. Title regex — same rules as lib/access.js (live scraper).
//   2. Tag membership — tag_ids[] includes the "מילואימניקים" label.
//
// events.access is access_t[] (sql/060). Updates are additive merges,
// never scalar strings — see backfillAccessRussian.js / backfillAccessOlim.js.
//
// Prereq: sql/057_access_miluim.sql (enum value) + sql/060_access_array.sql.

require("dotenv").config();
const supabase = require("../lib/supabase");
const { classifyAllAccessForEvent } = require("../lib/access");

async function resolveMiluimLabelId() {
  const { data, error } = await supabase
    .from("labels")
    .select("id, name")
    .eq("name", "מילואימניקים")
    .maybeSingle();
  if (error) {
    console.warn(`[Backfill] label lookup failed: ${error.message}`);
    return null;
  }
  return data?.id || null;
}

function hasMiluimScope(access) {
  const arr = Array.isArray(access) ? access : [access || "open"];
  return arr.includes("community-miluim");
}

async function main() {
  const labelId = await resolveMiluimLabelId();
  if (labelId) {
    console.log(`[Backfill] resolved 'מילואימניקים' label id = ${labelId}`);
  } else {
    console.log(`[Backfill] no 'מילואימניקים' label in DB — tag path will be skipped.`);
  }

  const { data: rows, error } = await supabase
    .from("events")
    .select("id, name, access, tag_ids")
    .eq("archived", false);
  if (error) {
    console.error("fetch failed:", error.message);
    process.exit(1);
  }

  const updates = [];
  for (const r of rows) {
    if (hasMiluimScope(r.access)) continue;

    const titleHit = classifyAllAccessForEvent({ name: r.name })?.includes(
      "community-miluim",
    );
    const tagHit =
      labelId && Array.isArray(r.tag_ids) && r.tag_ids.includes(labelId);
    if (!titleHit && !tagHit) continue;

    const existing = Array.isArray(r.access) ? r.access : [r.access || "open"];
    const merged = Array.from(new Set([...existing, "community-miluim"]));
    const finalScopes = merged.some((s) => s !== "open")
      ? merged.filter((s) => s !== "open")
      : merged;

    const existingKey = [...existing].sort().join(",");
    const targetKey = [...finalScopes].sort().join(",");
    if (existingKey === targetKey) continue;

    updates.push({
      id: r.id,
      name: r.name,
      via: titleHit ? "title" : "tag",
      existing,
      target: finalScopes,
    });
  }

  console.log(`[Backfill] ${updates.length} events to update.`);
  if (!updates.length) return;

  let ok = 0;
  let err = 0;
  for (const u of updates) {
    const { error: upErr } = await supabase
      .from("events")
      .update({ access: u.target })
      .eq("id", u.id);
    if (upErr) {
      console.error(`[Backfill] #${u.id} failed: ${upErr.message}`);
      err++;
      continue;
    }
    console.log(
      `[Backfill] #${u.id} (${u.via}) "${(u.name || "").slice(0, 60)}" ` +
        `${u.existing.join(",")} → ${u.target.join(",")}`,
    );
    ok++;
  }
  console.log(`[Backfill] done. ok=${ok} err=${err}`);
}

main().catch((e) => {
  console.error("[Backfill] fatal:", e);
  process.exit(1);
});
