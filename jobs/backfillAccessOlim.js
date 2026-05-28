#!/usr/bin/env node
// One-off backfill: add `community-olim` to events.access where text signals
// new-immigrant / olim audience (see lib/access.js). Additive merge like
// backfillAccessRussian.js.
//
// Prereq: sql/069_access_olim.sql

require("dotenv").config();
const supabase = require("../lib/supabase");
const { classifyAllAccessForEvent } = require("../lib/access");

async function main() {
  const { data: rows, error } = await supabase
    .from("events")
    .select("id, name, description, umbrella_title, access")
    .eq("archived", false);
  if (error) {
    console.error("fetch failed:", error.message);
    process.exit(1);
  }

  const updates = [];
  for (const r of rows) {
    const scopes = classifyAllAccessForEvent({
      name: r.name,
      description: [r.umbrella_title, r.description].filter(Boolean).join(" \n "),
    });
    if (!scopes?.includes("community-olim")) continue;

    const existing = Array.isArray(r.access) ? r.access : [r.access || "open"];
    const merged = Array.from(new Set([...existing, "community-olim"]));
    const finalScopes = merged.some((s) => s !== "open")
      ? merged.filter((s) => s !== "open")
      : merged;

    const existingKey = [...existing].sort().join(",");
    const targetKey = [...finalScopes].sort().join(",");
    if (existingKey === targetKey) continue;

    updates.push({ id: r.id, name: r.name, existing, target: finalScopes });
  }

  console.log(`[BackfillOlim] ${updates.length} events to update.`);
  if (!updates.length) return;

  let ok = 0;
  let err = 0;
  for (const u of updates) {
    const { error: upErr } = await supabase
      .from("events")
      .update({ access: u.target })
      .eq("id", u.id);
    if (upErr) {
      err++;
      console.error(`#${u.id} failed:`, upErr.message);
    } else {
      ok++;
      console.log(
        `[BackfillOlim] #${u.id} "${(u.name || "").slice(0, 60)}" ${u.existing.join(",")} → ${u.target.join(",")}`,
      );
    }
  }
  console.log(`[BackfillOlim] done ok=${ok} err=${err}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
