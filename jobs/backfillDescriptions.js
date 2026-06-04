// One-off backfill: populate events.description for non-archived rows that
// have an empty description, by re-fetching the source detail page.
//
//   - rg-muni  → cityApi.fetchEventDetail(external_slug) + extractCityDescription
//                (skips synthetic umbrella-child slugs `parent__date__…` to
//                 avoid bleeding the parent's prose onto children)
//   - smarticket (mbe-rg / ramat-gan) → fetchDetailHtml + extractDescription
//
// Idempotent: only writes when the row is currently empty AND a non-trivial
// description was extracted. Many mbe-rg booking pages legitimately have none.
//
//   node jobs/backfillDescriptions.js            # live
//   node jobs/backfillDescriptions.js --dry       # report only, no writes
//   node jobs/backfillDescriptions.js --limit=20  # cap rows processed

require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env.local"), override: true });
require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });

const supabase = require("../lib/supabase");
const cityApi = require("../lib/cityApi");
const { fetchDetailHtml, extractDescription } = require("../lib/eventEnricher");

const DRY = process.argv.includes("--dry");
const LIMIT = (() => {
  const a = process.argv.find((x) => x.startsWith("--limit="));
  return a ? parseInt(a.split("=")[1], 10) : Infinity;
})();
const DELAY_MS = 1300; // gentle pace — smarticket burst-throttles faster bursts
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function extractFor(ev) {
  if (ev.source === "rg-muni") {
    // Synthetic umbrella-child slug → the detail API returns the PARENT's
    // text; skip so we don't mislabel children.
    if (!ev.external_slug || ev.external_slug.includes("__")) return "";
    try {
      const detail = await cityApi.fetchEventDetail(ev.external_slug);
      return cityApi.extractCityDescription(detail) || "";
    } catch {
      return "";
    }
  }
  // Smarticket-backed (mbe-rg, ramat-gan, …)
  try {
    const { html } = await fetchDetailHtml(ev.id, ev.name, ev.source);
    return (html && extractDescription(html)) || "";
  } catch {
    return "";
  }
}

(async () => {
  const { data, error } = await supabase
    .from("events")
    .select("id, name, source, external_slug, description")
    .eq("archived", false);
  if (error) throw new Error(error.message);

  const empty = (data || []).filter((e) => !e.description || !e.description.trim());
  console.log(`[backfill] ${empty.length} non-archived events with empty description${DRY ? " (DRY RUN)" : ""}`);

  let filled = 0, stillEmpty = 0, processed = 0;
  const bySource = {};
  for (const ev of empty) {
    if (processed >= LIMIT) break;
    processed++;
    const desc = await extractFor(ev);
    await sleep(DELAY_MS);
    bySource[ev.source] = bySource[ev.source] || { filled: 0, empty: 0 };
    if (desc && desc.trim().length > 40) {
      filled++;
      bySource[ev.source].filled++;
      if (DRY) {
        console.log(`  WOULD FILL #${ev.id} [${ev.source}] ${ev.name.slice(0, 35)} → ${desc.slice(0, 70)}…`);
      } else {
        const { error: uErr } = await supabase
          .from("events")
          .update({ description: desc })
          .eq("id", ev.id);
        if (uErr) console.warn(`  write #${ev.id} failed: ${uErr.message}`);
        else if (filled % 10 === 0) console.log(`  …filled ${filled} so far`);
      }
    } else {
      stillEmpty++;
      bySource[ev.source].empty++;
    }
  }

  console.log(`\n[backfill] done. processed=${processed} filled=${filled} stillEmpty=${stillEmpty}`);
  console.log("[backfill] by source:", JSON.stringify(bySource, null, 1));
  process.exit(0);
})().catch((e) => {
  console.error("[backfill] FATAL", e.message);
  process.exit(1);
});
