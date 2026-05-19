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
const { classifyAccessFromText } = require("../lib/access");

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
    if (r.access === "community-russian") continue;
    // Don't downgrade a more-specific community classification.
    // Only touch `open` or NULL.
    if (r.access && r.access !== "open") continue;
    // Concat all the text the live classifier would see. Order
    // matters only for `classifyAccessFromText`'s first-match
    // semantics — and within the function we run the same regex
    // chain, so the order across fields is irrelevant here.
    const blob = [r.name, r.umbrella_title, r.description]
      .filter(Boolean)
      .join(" \n ");
    if (classifyAccessFromText(blob) === "community-russian") {
      updates.push({ id: r.id, name: r.name });
    }
  }
  console.log(`[Backfill] ${updates.length} events to update.`);
  if (!updates.length) return;

  let ok = 0;
  let err = 0;
  for (const u of updates) {
    const { error: upErr } = await supabase
      .from("events")
      .update({ access: "community-russian" })
      .eq("id", u.id);
    if (upErr) {
      console.error(`[Backfill] #${u.id} failed: ${upErr.message}`);
      err++;
      continue;
    }
    console.log(
      `[Backfill] #${u.id} "${(u.name || "").slice(0, 60)}" → community-russian`,
    );
    ok++;
  }
  console.log(`[Backfill] done. ok=${ok} err=${err}`);
}

main().catch((e) => {
  console.error("[Backfill] fatal:", e);
  process.exit(1);
});
