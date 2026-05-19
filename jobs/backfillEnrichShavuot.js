#!/usr/bin/env node
// Targeted re-enrichment of shavuot-2026 umbrella children whose
// tag_ids were clobbered back to `[<cluster>]` by a scrape cycle
// running between the initial backfill and the upsert-merge fix in
// `lib/cityApiScraper.js`. Idempotent — re-running is harmless once
// the tags settle.

require("dotenv").config();
const supabase = require("./../lib/supabase");
const { enrichEventData } = require("./../lib/eventEnricher");

async function main() {
  const { data: rows, error } = await supabase
    .from("events")
    .select("id, name, source, tag_ids, description")
    .eq("umbrella_slug", "shavuot-2026")
    .eq("archived", false);
  if (error) throw error;
  const targets = rows.filter(
    (r) => (r.tag_ids || []).length <= 2 && (r.description || "").length >= 30,
  );
  console.log(`[shavuot-backfill] ${targets.length}/${rows.length} children need re-enrichment.`);
  for (let i = 0; i < targets.length; i++) {
    const r = targets[i];
    await supabase
      .from("events")
      .update({ description_hash: null, audience: null, category: null })
      .eq("id", r.id);
    const result = await enrichEventData({ id: r.id, name: r.name, source: r.source });
    console.log(
      `[shavuot-backfill] ${i + 1}/${targets.length} #${r.id} "${(r.name || "").slice(0, 40)}" → ${(result?.labels?.tags || []).join(", ") || "(no tags)"} (${result.source})`,
    );
  }
  console.log("[shavuot-backfill] done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
