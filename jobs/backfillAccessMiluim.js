#!/usr/bin/env node
// One-off backfill: stamp `access='community-miluim'` onto events
// that were ingested BEFORE the title-based classifier in
// api/check.js#upsertEvents (sql/057 era) landed.
//
// Two selection paths, OR'd together so we catch both:
//
//   1. Title regex — same regex the live scraper now uses. Picks
//      up the 3 explicit "למילואימניקים.ות" Smarticket titles on
//      ramat-gan.
//   2. Tag membership — events whose tag_ids[] include the
//      "מילואימניקים" label (id 357 in production, looked up by
//      name so dev/preview DBs work too). This is how we catch
//      events with opaque military-slang titles like "פק״ל קפה
//      וקראש" (#3740) — the title doesn't shout the audience but
//      the enricher tagged it correctly months ago.
//
// Idempotent: only rows that aren't already 'community-miluim' are
// updated. Re-running prints "0 rows" once the world is consistent.
//
// Prereq: sql/057_access_miluim.sql MUST be applied first, otherwise
// the UPDATE rejects with `invalid input value for enum access_t`.

require("dotenv").config();
const supabase = require("../lib/supabase");
const { classifyAccessForEvent } = require("../lib/access");

async function resolveMiluimLabelId() {
  // Lookup by canonical name so we don't hardcode a numeric id that
  // differs between environments (dev DB ≠ prod DB).
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

async function main() {
  const labelId = await resolveMiluimLabelId();
  if (labelId) {
    console.log(`[Backfill] resolved 'מילואימניקים' label id = ${labelId}`);
  } else {
    console.log(`[Backfill] no 'מילואימניקים' label in DB — tag path will be skipped.`);
  }

  // Pull every non-archived event so we can apply both rules in JS.
  // It's small (~hundreds of rows) and lets us reuse the exact same
  // classifier the live scraper runs — drift between the two would
  // be a regression waiting to happen.
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
    if (r.access === "community-miluim") continue; // already set
    const titleHit = classifyAccessForEvent({ name: r.name }) === "community-miluim";
    const tagHit = labelId && Array.isArray(r.tag_ids) && r.tag_ids.includes(labelId);
    if (titleHit || tagHit) {
      updates.push({ id: r.id, name: r.name, via: titleHit ? "title" : "tag" });
    }
  }
  console.log(`[Backfill] ${updates.length} events to update.`);
  if (!updates.length) return;

  // Update one at a time so a single-row enum failure surfaces with
  // its id instead of taking the whole batch down. The volume here
  // is tiny (single digits at the start; dozens at most after a few
  // months) — no need for bulk optimisation.
  let ok = 0,
    err = 0;
  for (const u of updates) {
    const { error: upErr } = await supabase
      .from("events")
      .update({ access: "community-miluim" })
      .eq("id", u.id);
    if (upErr) {
      console.error(`[Backfill] #${u.id} failed: ${upErr.message}`);
      err++;
      continue;
    }
    console.log(
      `[Backfill] #${u.id} (${u.via}) "${(u.name || "").slice(0, 60)}" → community-miluim`,
    );
    ok++;
  }
  console.log(`[Backfill] done. ok=${ok} err=${err}`);
}

main().catch((e) => {
  console.error("[Backfill] fatal:", e);
  process.exit(1);
});
