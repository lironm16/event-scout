// Backfill Smarticket events that were scraped before the
// `external_slug` / umbrella-grouping feature existed.
//
// What it does:
//   1. Finds Smarticket events with `external_slug IS NULL`.
//   2. Re-fetches each event's detail page (follows the redirect chain)
//      to recover the canonical parent slug from the final URL.
//   3. Writes `external_slug` on the event row.
//   4. Runs smarticketGroupBySlug for each unique (source, slug) seen
//      during the run, creating or updating umbrella rows and stamping
//      umbrella_id / umbrella_slug / umbrella_title on all matching children.
//
// Usage:
//   node jobs/backfillSmarticketSlugs.js           # default: 50 events
//   node jobs/backfillSmarticketSlugs.js 200        # custom limit
//   node jobs/backfillSmarticketSlugs.js all        # process everything
//
// Idempotent:
//   - Only processes events where external_slug IS NULL.
//   - Slug write uses `.is("external_slug", null)` guard so a concurrent
//     write is not clobbered.
//   - smarticketGroupBySlug is itself idempotent (ON CONFLICT for the
//     umbrella row, IS NULL guard for children).

require("dotenv").config({
  path: require("path").resolve(__dirname, "..", ".env"),
});

const supabase = require("../lib/supabase");
const {
  fetchDetailHtml,
  extractParentSlug,
} = require("../lib/eventEnricher");
const { smarticketGroupBySlug } = require("../lib/smarticketUmbrellaService");

const DETAIL_FETCH_GAP_MS = 300;

function parseLimit(arg) {
  if (!arg || arg === "all") return null;
  const n = parseInt(arg, 10);
  if (!Number.isFinite(n) || n <= 0) return 50;
  return n;
}

async function fetchTargets(limit) {
  let q = supabase
    .from("events")
    .select("id, name, source")
    .neq("source", "rg-muni") // city events use a different slug mechanism
    .eq("archived", false)
    .is("external_slug", null)
    .order("id", { ascending: false });
  if (limit) q = q.limit(limit);
  const { data, error } = await q;
  if (error) throw new Error(`Target fetch failed: ${error.message}`);
  return data || [];
}

async function main() {
  const limit = parseLimit(process.argv[2]);

  console.log(
    `[BackfillSmarticketSlugs] Selecting up to ${limit ?? "ALL"} ` +
      `Smarticket events with external_slug IS NULL...`,
  );

  const targets = await fetchTargets(limit);
  console.log(`[BackfillSmarticketSlugs] ${targets.length} target(s) found.`);
  if (!targets.length) {
    console.log("[BackfillSmarticketSlugs] Nothing to do. ✓");
    return;
  }

  let processed = 0;
  let slugged = 0;
  let noSlug = 0;
  let errors = 0;

  // Collect unique (source, slug) pairs seen this run; run grouping once
  // per pair after the fetch loop so partial batches still trigger umbrella
  // logic even when a slug appears fewer than MIN_SESSIONS times in this
  // batch (prior events in the DB make up the count).
  const slugsSeen = new Map(); // "source::slug" → { source, slug }

  for (let i = 0; i < targets.length; i++) {
    const event = targets[i];
    processed++;
    try {
      const { finalUrl } = await fetchDetailHtml(event.id, event.name, event.source);
      const parentSlug = extractParentSlug(finalUrl);

      if (!parentSlug) {
        noSlug++;
        console.log(
          `[BackfillSmarticketSlugs] (${i + 1}/${targets.length}) #${event.id} no slug from "${finalUrl ?? "null"}" — skip`,
        );
      } else {
        // Write external_slug (only if still NULL — race-safe).
        await supabase
          .from("events")
          .update({ external_slug: parentSlug })
          .eq("id", event.id)
          .is("external_slug", null);

        slugged++;
        console.log(
          `[BackfillSmarticketSlugs] (${i + 1}/${targets.length}) #${event.id} → "${parentSlug}"`,
        );

        const key = `${event.source}::${parentSlug}`;
        if (!slugsSeen.has(key)) {
          slugsSeen.set(key, { source: event.source, slug: parentSlug });
        }
      }
    } catch (err) {
      errors++;
      console.error(
        `[BackfillSmarticketSlugs] #${event.id} failed: ${err.message}`,
      );
    }

    if (processed % 10 === 0) {
      console.log(
        `  …progress ${processed}/${targets.length}  (slugged=${slugged} noSlug=${noSlug} errors=${errors})`,
      );
    }

    if (i + 1 < targets.length) {
      await new Promise((r) => setTimeout(r, DETAIL_FETCH_GAP_MS));
    }
  }

  // ── Run umbrella grouping for every unique slug we encountered ────────
  console.log(
    `\n[BackfillSmarticketSlugs] Running umbrella grouping for ${slugsSeen.size} unique slug(s)…`,
  );

  let umbrellaCount = 0;
  for (const { source, slug } of slugsSeen.values()) {
    try {
      await smarticketGroupBySlug(source, slug);
      umbrellaCount++;
    } catch (err) {
      console.warn(
        `[BackfillSmarticketSlugs] grouping "${slug}" failed: ${err.message}`,
      );
    }
  }

  console.log(
    `\n[BackfillSmarticketSlugs] Done. ` +
      `processed=${processed}  slugged=${slugged}  noSlug=${noSlug}  errors=${errors}  ` +
      `uniqueSlugs=${slugsSeen.size}  umbrellasPassed=${umbrellaCount}`,
  );
}

main().catch((err) => {
  console.error("[BackfillSmarticketSlugs] Fatal:", err);
  process.exit(1);
});
