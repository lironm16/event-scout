#!/usr/bin/env node
// One-off backfill: stamp `access='community-seniors'` onto events
// that were ingested BEFORE the umbrella-aware classifier landed.
//
// Background: the city CMS publishes senior-targeted programming
// under umbrellas like "lectures-for-age-60-and-over" titled
// "מגוון הרצאות מרתקות לאזרחים ותיקים ברחבי העיר". The pre-fix
// `mapAccess` only inspected `category.name` / `cluster[].name` /
// `venueName` — none of which carried the senior signal for these
// umbrellas. As a result every child ended up `access='open'` and
// leaked into general "what's on?" searches for users who aren't
// part of the seniors community.
//
// Selection strategy: re-run the SAME classifier the fixed scraper
// uses (`classifyAccessForEvent` on event name) AND look at the
// umbrella linkage in the events table. We catch:
//
//   1. Events whose own `name` matches the regex (rare; the seniors
//      regex deliberately doesn't fire on bare "ותיקים" — see
//      lib/access.js for the false-positive analysis).
//   2. Events whose `umbrella_title` matches — the umbrella aboard
//      carries the audience signal even when each child's title
//      is innocuous ("פנינים על חג השבועות", "ערב בינגו").
//   3. Events whose `umbrella_slug` contains "for-age-60-and-over"
//      — the city CMS's most reliable senior marker.
//
// Idempotent: only rows that aren't already 'community-seniors' get
// updated. Re-running prints "0 rows" once the world is consistent.
//
// Prereq: sql/039_events_access.sql (community-seniors enum value)
// must already be applied — it was, months ago.

require("dotenv").config();
const supabase = require("../lib/supabase");
const { classifyAccessFromText } = require("../lib/access");

async function main() {
  // Pull every non-archived event with its umbrella linkage so we
  // can apply all three rules in JS using the canonical classifier.
  // Volume is small (low thousands max); JS-side scan keeps this
  // script simple and reuses the production classifier verbatim.
  const { data: rows, error } = await supabase
    .from("events")
    .select("id, name, access, umbrella_title, umbrella_slug")
    .eq("archived", false);
  if (error) {
    console.error("fetch failed:", error.message);
    process.exit(1);
  }

  const updates = [];
  for (const r of rows) {
    if (r.access === "community-seniors") continue; // already set
    // Build the text we feed the classifier: name + umbrella_title
    // + umbrella_slug. Same shape the live scraper now considers
    // (own text + umbrella context).
    const probeText = [r.name, r.umbrella_title, r.umbrella_slug]
      .filter(Boolean)
      .join(" ");
    const hit = classifyAccessFromText(probeText);
    if (hit === "community-seniors") {
      // Distinguish source for the log — useful when sanity-checking
      // a backfill run ("does it pick up the right things?").
      let via = "name";
      if (classifyAccessFromText(r.name) !== "community-seniors") {
        via = r.umbrella_title && classifyAccessFromText(r.umbrella_title) === "community-seniors"
          ? "umbrella_title"
          : "umbrella_slug";
      }
      updates.push({ id: r.id, name: r.name, via });
    }
  }
  console.log(`[Backfill] ${updates.length} events to update.`);
  if (!updates.length) return;

  // Per-row updates so a single bad row doesn't take the batch down.
  // Volume is tiny — dozens at most.
  let ok = 0,
    err = 0;
  for (const u of updates) {
    const { error: upErr } = await supabase
      .from("events")
      .update({ access: "community-seniors" })
      .eq("id", u.id);
    if (upErr) {
      console.error(`[Backfill] #${u.id} failed: ${upErr.message}`);
      err++;
      continue;
    }
    console.log(
      `[Backfill] #${u.id} (${u.via}) "${(u.name || "").slice(0, 60)}" → community-seniors`,
    );
    ok++;
  }
  console.log(`[Backfill] done. ok=${ok} err=${err}`);
}

main().catch((e) => {
  console.error("[Backfill] fatal:", e);
  process.exit(1);
});
