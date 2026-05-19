#!/usr/bin/env node
// One-off backfill: re-enrich rg-muni events that have a rich
// `description` but only 1-2 tags (almost certainly just the
// scraper-time cluster name). Driven by the 2026-05 shavuot-2026
// regression — every child of an umbrella received [<cluster_id>]
// and then Gemini either replaced it with semantic tags (clobbering
// the cluster) or wasn't called again because `description_hash`
// was already populated. The post-fix `withPreservedClusters` merges
// both layers, so re-enrichment now produces the full tag set.
//
// Selection:
//   - source = 'rg-muni'
//   - archived = false
//   - tag_ids count <= 2
//   - description IS NOT NULL AND length >= 60 chars (anything
//     shorter is unlikely to give Gemini enough to derive new
//     topical tags, and re-enriching is wasted quota).
//
// Side effects: clears `description_hash`, `audience`, `category`
// before calling `enrichEventData` so the cache+pending logic
// re-enters Gemini. The cluster tag is preserved by the enricher
// (sql/056-era patch).

require("dotenv").config();
const supabase = require("../lib/supabase");
const { enrichEventData } = require("../lib/eventEnricher");

const PACE_MS = 200; // gap between events to be polite to Gemini quota.

async function main() {
  const { data: rows, error } = await supabase
    .from("events")
    .select("id, name, source, tag_ids, description, category")
    .eq("source", "rg-muni")
    .eq("archived", false)
    .not("description", "is", null);
  if (error) {
    console.error("fetch failed:", error.message);
    process.exit(1);
  }
  const candidates = rows.filter(
    (r) =>
      (r.description || "").length >= 50 &&
      ((r.tag_ids || []).length <= 2 || !r.category),
  );
  console.log(`[Backfill] found ${candidates.length} under-tagged rg-muni rows.`);
  let ok = 0,
    err = 0;
  for (let i = 0; i < candidates.length; i++) {
    const r = candidates[i];
    try {
      // Only clear `description_hash` so the next enrichment pass
      // re-enters the cache lookup path (or, on cache miss, Gemini).
      // Critically, DON'T null out `audience`/`category` here —
      // Gemini occasionally hands back null for those slots under
      // load, and the enricher's preservation logic
      // (applyLabels/copyFromSource) only kicks in if there's still
      // a previous value on the row to keep. Wiping them first
      // defeats that safety net and is exactly what produced the
      // "cat: null" regression across rg-muni events in the May-2026
      // backfill runs.
      //
      // tag_ids is intentionally NOT cleared either: the enricher
      // reads it back as `siteLabels` (the scraper-time cluster
      // tags) and merges them with Gemini's output. Wiping would
      // mean `siteLabels = []` and the cluster name would be
      // permanently lost on the re-enrichment hop.
      await supabase
        .from("events")
        .update({ description_hash: null })
        .eq("id", r.id);
      const result = await enrichEventData({
        id: r.id,
        name: r.name,
        source: r.source,
      });
      const tags = (result?.labels?.tags || []).join(", ");
      console.log(
        `[Backfill] ${i + 1}/${candidates.length} #${r.id} "${(r.name || "").slice(0, 40)}" → ${tags || "(no tags)"} (${result.source})`,
      );
      ok++;
    } catch (e) {
      console.error(`[Backfill] #${r.id} failed: ${e.message}`);
      err++;
    }
    if (i + 1 < candidates.length) {
      await new Promise((r) => setTimeout(r, PACE_MS));
    }
  }
  console.log(`[Backfill] done. ok=${ok} err=${err}`);
}

main().catch((e) => {
  console.error("[Backfill] fatal:", e);
  process.exit(1);
});
