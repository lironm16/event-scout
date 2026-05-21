#!/usr/bin/env node
/**
 * backfillFixWrongUmbrellaLinks.js
 *
 * Clears incorrectly stamped umbrella metadata from rg-muni events that
 * have their own dedicated city page.
 *
 * Root cause: `linkStandaloneIfExists` used to match any standalone event
 * by location+date and stamp the umbrella's metadata onto it — even when the
 * standalone already had a real named city page (external_slug without "__"
 * that differs from the umbrella's own slug). This caused, for example,
 * "2026-zoom-story-time" being grouped under "maaseh-bazoom-may" and
 * showing "📋 כל אירועי מעשה בזום" as its parent link.
 *
 * Detection rule (matches the guard now in linkStandaloneIfExists):
 *   - source = 'rg-muni'
 *   - umbrella_id IS NOT NULL          (was stamped)
 *   - external_slug does NOT contain "__"  (has own city page, not synthetic)
 *   - external_slug <> umbrella_slug   (belongs to a different page)
 *
 * Fix: set umbrella_id = NULL, umbrella_slug = NULL, umbrella_title = NULL.
 */

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

async function run() {
  // Fetch candidates in pages to avoid large result sets.
  let page = 0;
  const PAGE_SIZE = 200;
  let totalFixed = 0;

  while (true) {
    const { data: rows, error } = await supabase
      .from("events")
      .select("id, external_slug, umbrella_slug, umbrella_id, umbrella_title")
      .eq("source", "rg-muni")
      .not("umbrella_id", "is", null)
      .not("external_slug", "is", null)
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

    if (error) {
      console.error("[Backfill] fetch error:", error);
      process.exit(1);
    }
    if (!rows || rows.length === 0) break;

    // Note: cannot use Supabase LIKE with "__" because SQL treats "_" as a
    // single-character wildcard. Filter in JavaScript instead.
    //
    // A standalone has been wrongly stamped when ALL of:
    //   1. external_slug does NOT contain "__" (not a synthetic child slug)
    //   2. external_slug differs from umbrella_slug (different city page)
    const toFix = rows.filter(
      (r) =>
        !r.external_slug.includes("__") &&
        r.external_slug !== r.umbrella_slug,
    );

    if (toFix.length > 0) {
      console.log(
        `[Backfill] page ${page} — found ${toFix.length} wrong umbrella links:`,
      );
      for (const r of toFix) {
        console.log(
          `  #${r.id}  slug="${r.external_slug}"  wrongly under umbrella="${r.umbrella_slug}"`,
        );
      }

      const ids = toFix.map((r) => r.id);
      const { error: upErr } = await supabase
        .from("events")
        .update({ umbrella_id: null, umbrella_slug: null, umbrella_title: null })
        .in("id", ids);

      if (upErr) {
        console.error("[Backfill] update error:", upErr);
        process.exit(1);
      }
      totalFixed += toFix.length;
    }

    if (rows.length < PAGE_SIZE) break;
    page++;
  }

  console.log(`[Backfill] Done — cleared umbrella from ${totalFixed} events.`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
