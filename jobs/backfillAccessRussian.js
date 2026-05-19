#!/usr/bin/env node
// One-off backfill: stamp `access='community-russian'` onto events
// whose titles / descriptions / umbrella titles contain Russian
// (Cyrillic) text. Counterpart to backfillAccessMiluim.js — same
// shape, different signal.
//
// Why this is needed:
//   The sql/059 migration only adds the ENUM value. Existing rows
//   (the ~10 Cyrillic-titled events on `mbe-rg` / `ramat-gan` that
//   already live in the DB) stay at access='open' until something
//   actively re-classifies them. The live scraper handles new
//   inserts via lib/access.js, but it won't revisit old rows whose
//   incoming payload hasn't changed.
//
// Signal: the same Cyrillic regex lib/access.js uses, applied via
// `classifyAccessFromText` against name / description / umbrella_title.
// This is intentionally broader than backfillAccessMiluim's
// title-only check because Russian-community events sometimes have
// Hebrew titles ("ערב מוזיקלי") with Cyrillic flyer text only in
// the description — we want to catch those too.
//
// Idempotent: only rows that aren't already 'community-russian'
// AND whose current access is 'open' get touched. We deliberately
// SKIP rows already classified as a different community
// (community-lgbtq, community-seniors, etc.) — if a Russian event
// is ALSO LGBTQ, the existing classification is the one a human
// chose / the title-first regex picked, and overwriting it would
// be a regression. Pre-existing community classifications win.
//
// Prereq: sql/059_access_russian.sql MUST be applied first.

require("dotenv").config();
const supabase = require("../lib/supabase");
const { classifyAllAccessForEvent } = require("../lib/access");

// events.access is now access_t[] (sql/060). This backfill is
// ADDITIVE-ONLY — it never removes community scopes that were set
// by other means (umbrella analysis, tag lookup, manual SQL edits).
//
// Algorithm per row:
//   1. Classify the text → get the computed scopes (or [] if 'open').
//   2. If computed is empty (classifier saw no community signal) → skip.
//   3. Merge computed INTO the existing array (union, deduplicated).
//   4. If merged == existing → skip (already up to date).
//   5. Otherwise update the row.
//
// Why additive: events like #3740 "פק״ל קפה וקראש" were tagged
// community-miluim via label lookup (the title doesn't spell it out),
// and #83892538 via the umbrella/cluster path. The text classifier
// won't detect those — if we let it overwrite we'd erase them.

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
    const newScopes = classifyAllAccessForEvent({
      name: r.name,
      description: [r.umbrella_title, r.description].filter(Boolean).join(" \n "),
    });
    // No community signal detected — don't touch this row.
    if (!newScopes) continue;

    // Normalize existing to an array.
    const existing = Array.isArray(r.access)
      ? r.access
      : [r.access || "open"];

    // Union: add new scopes to existing, keeping all existing ones.
    const merged = Array.from(new Set([...existing, ...newScopes]));
    // Remove 'open' when real community scopes are present — an event
    // can't be both community-gated AND public at the same time.
    const finalScopes =
      merged.some((s) => s !== "open")
        ? merged.filter((s) => s !== "open")
        : merged;

    const existingKey = [...existing].sort().join(",");
    const targetKey = [...finalScopes].sort().join(",");
    if (existingKey === targetKey) continue;

    updates.push({ id: r.id, name: r.name, existing, target: finalScopes });
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
      `[Backfill] #${u.id} "${(u.name || "").slice(0, 55)}" ${JSON.stringify(u.existing)} → ${JSON.stringify(u.target)}`,
    );
    ok++;
  }
  console.log(`[Backfill] done. ok=${ok} err=${err}`);
}

main().catch((e) => {
  console.error("[Backfill] fatal:", e);
  process.exit(1);
});
