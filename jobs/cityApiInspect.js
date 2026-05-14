// Inspection / verification CLI for the city-API duplicate-detection
// helpers in `lib/cityApi.js`. This is the "does Layer 1 + Layer 2
// actually work against the live municipal feed?" probe — it doesn't
// write anything anywhere and intentionally has no DB side effects.
//
// What it does:
//   1. Fetches the lobby JSON from `api-m.ramat-gan.muni.il`.
//   2. Collects every event reference across all arrays
//      (sliderEvents, closeEvents, eventLobbyCategories[].events) and
//      dedupes them by slug — the city site repeats events across
//      sections.
//   3. Runs Layer 1 (`classifyLobbyEvent`) on every event.
//   4. For each city-candidate, fetches the detail JSON and runs
//      Layer 2 (`classifyDetail`) — this is the umbrella check.
//   5. For each Layer-1 smarticket hit with a recoverable id, looks
//      it up in `events` to verify our cross-reference matches a row
//      we actually have. Mismatches are interesting (= bug, or = the
//      Smarticket scraper hasn't reached that id yet).
//   6. Prints a summary plus the first N rows in each bucket so a
//      human can eyeball obvious mistakes.
//
// Usage:
//   node jobs/cityApiInspect.js                # default: full feed
//   node jobs/cityApiInspect.js --no-detail    # skip Layer 2 fetches
//   node jobs/cityApiInspect.js --no-db        # skip DB cross-check
//   node jobs/cityApiInspect.js --limit 20     # cap candidates inspected
//   node jobs/cityApiInspect.js --json         # machine-readable output

require("dotenv").config({
  path: require("path").resolve(__dirname, "..", ".env"),
});

const {
  fetchLobby,
  fetchEventDetail,
  classifyLobbyEvent,
  classifyDetail,
  collectLobbyEvents,
} = require("../lib/cityApi");

const DETAIL_FETCH_GAP_MS = 250;
const SAMPLE_PER_BUCKET = 5;

function parseArgs(argv) {
  const opts = { detail: true, db: true, limit: null, json: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-detail") opts.detail = false;
    else if (a === "--no-db") opts.db = false;
    else if (a === "--json") opts.json = true;
    else if (a === "--limit") opts.limit = parseInt(argv[++i], 10) || null;
  }
  return opts;
}

async function dbLookupBatch(refs) {
  if (!refs.length) return new Map();
  const supabase = require("../lib/supabase");
  const out = new Map();
  // Group by source so we can use one IN-list per tenant. Cleaner
  // than a giant OR chain and lets PG use the index efficiently.
  const bySource = new Map();
  for (const r of refs) {
    if (!bySource.has(r.source)) bySource.set(r.source, []);
    bySource.get(r.source).push(r.smarticketId);
  }
  for (const [source, ids] of bySource) {
    const { data, error } = await supabase
      .from("events")
      .select("id, source, name, archived")
      .eq("source", source)
      .in("id", ids);
    if (error) {
      console.error(
        `[CityApiInspect] DB lookup failed for source=${source}: ${error.message}`,
      );
      continue;
    }
    for (const row of data || []) {
      out.set(`${row.source}:${row.id}`, row);
    }
  }
  return out;
}

function fmtRow(label, data, opts) {
  return opts.json ? null : `  ${label.padEnd(28)} ${data}`;
}

async function main() {
  const opts = parseArgs(process.argv);

  if (!opts.json) {
    console.log("[CityApiInspect] Fetching lobby JSON...");
  }
  const lobby = await fetchLobby();
  const allEvents = collectLobbyEvents(lobby);
  if (!opts.json) {
    console.log(`[CityApiInspect] Collected ${allEvents.length} unique events`);
  }

  // Layer 1
  const smarticketHits = [];
  const cityCandidates = [];
  const unknownSource = [];
  for (const e of allEvents) {
    const cls = classifyLobbyEvent(e);
    const enriched = { event: e, cls };
    if (cls.kind === "smarticket") {
      if (cls.source == null) unknownSource.push(enriched);
      else smarticketHits.push(enriched);
    } else {
      cityCandidates.push(enriched);
    }
  }

  // Optional DB cross-check on Layer 1 smarticket hits.
  // Only events with a recovered numeric id can be cross-checked.
  let dbMap = new Map();
  if (opts.db) {
    const refs = smarticketHits
      .filter((h) => h.cls.smarticketId != null)
      .map((h) => ({
        source: h.cls.source,
        smarticketId: h.cls.smarticketId,
      }));
    if (!opts.json) {
      console.log(
        `[CityApiInspect] Cross-checking ${refs.length} smarticket id(s) against DB...`,
      );
    }
    dbMap = await dbLookupBatch(refs);
  }

  // Layer 2: detail fetches for city-candidates.
  let layer2Targets = cityCandidates;
  if (opts.limit) layer2Targets = layer2Targets.slice(0, opts.limit);

  const cityOnly = [];
  const umbrella = [];
  const detailErrors = [];
  if (opts.detail && layer2Targets.length) {
    if (!opts.json) {
      console.log(
        `[CityApiInspect] Layer 2 detail fetch for ${layer2Targets.length} candidate(s)...`,
      );
    }
    for (let i = 0; i < layer2Targets.length; i++) {
      const cand = layer2Targets[i];
      try {
        const detail = await fetchEventDetail(cand.cls.slug);
        const verdict = classifyDetail(detail);
        cand.detail = verdict;
        if (verdict.cityOnly) cityOnly.push(cand);
        else umbrella.push(cand);
      } catch (err) {
        cand.detailError = err.message;
        detailErrors.push(cand);
      }
      if (i < layer2Targets.length - 1) {
        await new Promise((r) => setTimeout(r, DETAIL_FETCH_GAP_MS));
      }
      if (!opts.json && (i + 1) % 10 === 0) {
        console.log(
          `  …progress ${i + 1}/${layer2Targets.length}  (cityOnly=${cityOnly.length} umbrella=${umbrella.length} errors=${detailErrors.length})`,
        );
      }
    }
  }

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          totals: {
            collected: allEvents.length,
            smarticket: smarticketHits.length,
            unknownSource: unknownSource.length,
            cityCandidates: cityCandidates.length,
            cityOnly: cityOnly.length,
            umbrella: umbrella.length,
            detailErrors: detailErrors.length,
          },
          smarticket: smarticketHits.map((h) => ({
            title: h.event.title,
            source: h.cls.source,
            smarticketId: h.cls.smarticketId,
            slug: h.cls.slug,
            inDb: dbMap.has(`${h.cls.source}:${h.cls.smarticketId}`),
          })),
          cityOnly: cityOnly.map((c) => ({
            title: c.event.title,
            slug: c.cls.slug,
            scheduleSize: c.detail?.scheduleSize ?? 0,
          })),
          umbrella: umbrella.map((c) => ({
            title: c.event.title,
            slug: c.cls.slug,
            reasons: c.detail?.reasons || [],
            scheduleSize: c.detail?.scheduleSize ?? 0,
          })),
          unknownSource: unknownSource.map((u) => ({
            title: u.event.title,
            sourceId: u.cls.unknownSourceId,
            slug: u.cls.slug,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  // Pretty summary
  console.log("\n[CityApiInspect] Summary");
  console.log("───────────────────────────────────────");
  console.log(fmtRow("Collected events:", allEvents.length, opts));
  console.log(
    fmtRow(
      "Layer 1 smarticket hits:",
      `${smarticketHits.length} (already in our DB by definition)`,
      opts,
    ),
  );
  console.log(
    fmtRow("Layer 1 unknown sourceId:", unknownSource.length, opts),
  );
  console.log(
    fmtRow("Layer 1 city-candidates:", cityCandidates.length, opts),
  );
  if (opts.detail) {
    console.log(
      fmtRow("Layer 2 → city-only:", `${cityOnly.length} (ADD)`, opts),
    );
    console.log(
      fmtRow(
        "Layer 2 → umbrella:",
        `${umbrella.length} (SKIP — fans out to smarticket)`,
        opts,
      ),
    );
    console.log(fmtRow("Layer 2 errors:", detailErrors.length, opts));
  }

  if (opts.db && smarticketHits.length) {
    const withId = smarticketHits.filter((h) => h.cls.smarticketId != null);
    const matched = withId.filter((h) =>
      dbMap.has(`${h.cls.source}:${h.cls.smarticketId}`),
    );
    const missing = withId.filter(
      (h) => !dbMap.has(`${h.cls.source}:${h.cls.smarticketId}`),
    );
    console.log(
      fmtRow(
        "DB cross-check:",
        `${matched.length}/${withId.length} smarticket ids resolved in events table`,
        opts,
      ),
    );
    if (missing.length) {
      console.log(
        `\n  ⚠ ${missing.length} smarticket id(s) referenced by city feed but missing from our DB:`,
      );
      for (const m of missing.slice(0, SAMPLE_PER_BUCKET)) {
        console.log(
          `    - ${m.cls.source}#${m.cls.smarticketId}  "${m.event.title}"`,
        );
      }
      if (missing.length > SAMPLE_PER_BUCKET) {
        console.log(`    …and ${missing.length - SAMPLE_PER_BUCKET} more`);
      }
    }
  }

  // Sample listings — the most interesting bucket is "city-only"
  // since that's what we'd actually add to the DB.
  if (cityOnly.length) {
    console.log("\n  city-only candidates (sample):");
    for (const c of cityOnly.slice(0, SAMPLE_PER_BUCKET)) {
      console.log(`    + ${c.cls.slug.padEnd(40)} "${c.event.title}"`);
    }
    if (cityOnly.length > SAMPLE_PER_BUCKET) {
      console.log(`    …and ${cityOnly.length - SAMPLE_PER_BUCKET} more`);
    }
  }
  if (umbrella.length) {
    console.log("\n  umbrella parents (sample):");
    for (const u of umbrella.slice(0, SAMPLE_PER_BUCKET)) {
      const reasons = u.detail.reasons.join(",");
      console.log(
        `    × ${u.cls.slug.padEnd(40)} "${u.event.title}"  [${reasons}]`,
      );
    }
  }
  if (unknownSource.length) {
    console.log("\n  ⚠ unknown city sourceId (likely new tenant):");
    for (const u of unknownSource) {
      console.log(
        `    ? sourceId=${u.cls.unknownSourceId} "${u.event.title}"`,
      );
    }
  }
  if (detailErrors.length) {
    console.log("\n  detail-fetch errors:");
    for (const d of detailErrors.slice(0, SAMPLE_PER_BUCKET)) {
      console.log(`    ! ${d.cls.slug}: ${d.detailError}`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[CityApiInspect] Fatal:", err.message);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  });
