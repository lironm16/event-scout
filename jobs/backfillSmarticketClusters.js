// One-off backfill: attach the Smarticket "breadcrumb_category" cluster
// (e.g. "שבת משפחה קהילה") as a real tag on existing smarticket events.
//
// Why this is needed: prior to the cluster-as-tag fix, smarticket events
// were tagged ONLY with Gemini's semantic output (שבועות, מוזיקה, …),
// never with the curator-defined navigation cluster the user actually
// remembers from the site. The agent's `search_events({ tags: ["שבת קהילה"] })`
// therefore returned nothing for events grouped under that cluster.
// New events ingested after the fix get the cluster tag automatically
// via `enrichEvent` → `withSmarticketCluster`; this job covers the
// already-enriched rows.
//
// Usage:
//   node jobs/backfillSmarticketClusters.js           # default limit 50
//   node jobs/backfillSmarticketClusters.js 200       # custom limit
//   node jobs/backfillSmarticketClusters.js all       # process everything
//   node jobs/backfillSmarticketClusters.js dry 50    # dry-run (no writes)
//
// The job is idempotent: rows whose tag_ids already contain a label
// whose normalized name matches the page cluster are skipped.

require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });

const { createClient } = require("@supabase/supabase-js");
const labelStore = require("../lib/labelStore");
const {
  fetchDetailHtml,
  extractSmarticketCluster,
} = require("../lib/eventEnricher");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

// Politeness gap between detail-page fetches. Matches the value used
// by lib/eventEnricher and jobs/backfillLocations so we don't trip
// Smarticket's anti-scrape heuristics when run alongside the regular
// enrichment loop.
const DETAIL_FETCH_GAP_MS = 250;

function parseArgs(argv) {
  let dry = false;
  let limit = 50;
  for (const a of argv) {
    if (a === "dry") dry = true;
    else if (a === "all") limit = null;
    else {
      const n = parseInt(a, 10);
      if (Number.isFinite(n) && n > 0) limit = n;
    }
  }
  return { dry, limit };
}

async function fetchTargets(limit) {
  // Only smarticket-shaped tenants have a `breadcrumb_category` HTML
  // element. The city scraper writes tag_ids directly from the API
  // payload, so it's already covered there. We pick the most recent
  // events first — those are the ones a user is most likely to be
  // searching for right now.
  let q = supabase
    .from("events")
    .select("id, name, source, tag_ids")
    .eq("archived", false)
    .neq("source", "rg-muni")
    .order("id", { ascending: false });
  if (limit) q = q.limit(limit);
  const { data, error } = await q;
  if (error) throw new Error(`Target fetch failed: ${error.message}`);
  return data || [];
}

async function eventAlreadyHasCluster(eventTagIds, clusterName) {
  if (!Array.isArray(eventTagIds) || !eventTagIds.length) return false;
  const target = labelStore.normalizeName(clusterName);
  if (!target) return false;
  // Resolve the event's existing tag_ids back to names in one call.
  // We can't go through getLabelsForEvent because we already have
  // the row — fetch the labels directly.
  const { data: labels, error } = await supabase
    .from("labels")
    .select("name")
    .in("id", eventTagIds);
  if (error) {
    console.warn(`[Backfill] label lookup failed:`, error.message);
    return false;
  }
  return (labels || []).some(
    (l) => labelStore.normalizeName(l.name) === target,
  );
}

async function attachClusterTag(eventId, currentTagIds, clusterName) {
  const labelId = await labelStore.getOrCreateLabel(clusterName);
  if (labelId == null) {
    throw new Error(`getOrCreateLabel returned null for "${clusterName}"`);
  }
  if (Array.isArray(currentTagIds) && currentTagIds.includes(labelId)) {
    // Defensive — eventAlreadyHasCluster should have caught this, but
    // the label could have been merged/renamed mid-run.
    return { added: false, labelId };
  }
  const nextTagIds = [...new Set([...(currentTagIds || []), labelId])];
  const { error } = await supabase
    .from("events")
    .update({ tag_ids: nextTagIds })
    .eq("id", eventId);
  if (error) {
    throw new Error(`update tag_ids failed: ${error.message}`);
  }
  return { added: true, labelId };
}

async function main() {
  const { dry, limit } = parseArgs(process.argv.slice(2));
  console.log(
    `[Backfill] mode=${dry ? "DRY-RUN" : "WRITE"} limit=${limit ?? "ALL"}`,
  );

  if (!(await labelStore.isSchemaReady())) {
    throw new Error("labels schema not ready — run sql/026 first.");
  }

  const targets = await fetchTargets(limit);
  console.log(`[Backfill] ${targets.length} target(s) found.`);
  if (!targets.length) return;

  let scanned = 0;
  let alreadyTagged = 0;
  let attached = 0;
  let skippedNoCluster = 0;
  let fetchFailed = 0;

  for (let i = 0; i < targets.length; i++) {
    const ev = targets[i];
    scanned++;
    try {
      const { html } = await fetchDetailHtml(ev.id, ev.name, ev.source);
      const cluster = extractSmarticketCluster(html);
      if (!cluster) {
        skippedNoCluster++;
        console.log(
          `[Backfill] (${i + 1}/${targets.length}) #${ev.id} no cluster on page — skip`,
        );
      } else if (await eventAlreadyHasCluster(ev.tag_ids, cluster)) {
        alreadyTagged++;
        console.log(
          `[Backfill] (${i + 1}/${targets.length}) #${ev.id} cluster "${cluster}" already tagged`,
        );
      } else if (dry) {
        console.log(
          `[Backfill] (${i + 1}/${targets.length}) #${ev.id} would attach "${cluster}" (DRY-RUN)`,
        );
      } else {
        const { added, labelId } = await attachClusterTag(
          ev.id,
          ev.tag_ids,
          cluster,
        );
        if (added) attached++;
        console.log(
          `[Backfill] (${i + 1}/${targets.length}) #${ev.id} attached "${cluster}" (label #${labelId})`,
        );
      }
    } catch (err) {
      fetchFailed++;
      console.warn(
        `[Backfill] (${i + 1}/${targets.length}) #${ev.id} FAILED: ${err.message}`,
      );
    }

    if (i + 1 < targets.length) {
      await new Promise((r) => setTimeout(r, DETAIL_FETCH_GAP_MS));
    }
  }

  console.log("\n[Backfill] Summary:");
  console.log(`  scanned:         ${scanned}`);
  console.log(`  attached:        ${attached}${dry ? " (would attach)" : ""}`);
  console.log(`  already-tagged:  ${alreadyTagged}`);
  console.log(`  no-cluster:      ${skippedNoCluster}`);
  console.log(`  fetch-failed:    ${fetchFailed}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[Backfill] Fatal:", err.message);
    process.exit(1);
  });
