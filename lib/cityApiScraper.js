// Scraper for the Ramat Gan municipality JSON API
// (`api-m.ramat-gan.muni.il`). The detection layer lives in
// `lib/cityApi.js`; this file is the IO orchestrator that turns
// "list of city-only events" into upserted rows in `events`.
//
// What it does NOT do (by design):
//   - Fire ticket-restock notifications. City events are free /
//     unmetered (`tickets_left = NULL`), so the back-in-stock
//     detector in api/check.js doesn't apply. Saved-search matches
//     still fire — see api/check.js for that wiring.
//   - Run Gemini enrichment. The city CMS hands us human-curated
//     audience and category labels, plus cluster[] tags. Gemini
//     would just spend quota duplicating that.
//   - Touch the locations table directly. We delegate to
//     `ensureLocationKey` exactly like the Smarticket scraper does,
//     so the geocoder's pending-resolve cycle picks up city venues
//     transparently.
//
// Idempotency:
//   The `(source, external_slug)` UNIQUE index in sql/038 means a
//   re-scrape upserts the same row — the synthetic `id` is a
//   deterministic hash of the slug. Re-running the scrape is safe
//   and cheap; nothing accumulates duplicates.
//
// Failure containment:
//   One bad detail-fetch (404, transient 5xx, malformed JSON) does
//   NOT abort the run. We log loud and skip the event; the next
//   cycle retries. The whole scraper is best-effort: if the lobby
//   fetch itself fails, we throw so the caller can fold the failure
//   into the broader scrape's error reporting.

// Load .env BEFORE requiring `./supabase` — the supabase client
// constructs at import time and throws if SUPABASE_URL is missing.
// When this module is loaded as a library by api/check.js, dotenv
// has already run via that file's first line; this guard only matters
// for direct CLI invocation (`node lib/cityApiScraper.js`).
if (require.main === module) {
  require("dotenv").config({
    path: require("path").resolve(__dirname, "..", ".env"),
  });
}

const supabase = require("./supabase");
const {
  fetchLobby,
  fetchEventDetail,
  collectLobbyEvents,
  classifyLobbyEvent,
  classifyDetail,
  extractCitySchedule,
  buildCityEventRow,
  buildCityChildEventRow,
} = require("./cityApi");
const { ensureLocationKey } = require("./locationResolver");
const { resolveMany } = require("./labelStore");

// Pace the detail fetches. The city API is fast (~200ms per call)
// and unrate-limited as far as we know, but politeness helps and
// keeps us under any unannounced limit. 250ms matches the Smarticket
// detail-page pacing in `lib/eventEnricher.js`.
const DETAIL_FETCH_GAP_MS = 250;

async function fetchDetailSafe(slug, logger) {
  try {
    return await fetchEventDetail(slug);
  } catch (err) {
    logger.warn(
      `[CityApi] detail fetch failed for "${slug}": ${err.message}`,
    );
    return null;
  }
}

async function upsertCityEventRow(row, logger) {
  // Strip the helper fields before sending to Supabase. The
  // `_rawAddress` and `_tagNames` keys are buildCityEventRow's
  // contract for "more work to do here" — we resolve them now.
  const { _rawAddress, _tagNames, ...persistable } = row;

  if (_rawAddress) {
    try {
      const key = await ensureLocationKey(_rawAddress);
      if (key) persistable.location_key = key;
    } catch (err) {
      logger.warn(
        `[CityApi] #${row.id} ensureLocationKey("${_rawAddress}") failed: ${err.message}`,
      );
    }
  }

  if (Array.isArray(_tagNames) && _tagNames.length) {
    try {
      const tagIds = await resolveMany(_tagNames);
      if (tagIds.length) persistable.tag_ids = tagIds;
    } catch (err) {
      logger.warn(
        `[CityApi] #${row.id} tag resolution failed: ${err.message}`,
      );
    }
  }

  // Stamp scrape-touched timestamps. last_changed_at is intentionally
  // NOT set here — the city scraper has no semantic equivalent of
  // "tickets_left moved", and stamping last_changed_at on every row
  // every cycle would lie about meaningful change. The DB column
  // simply stays NULL until/unless we add per-field change detection
  // for city events later.
  const now = new Date().toISOString();
  persistable.last_checked = now;
  persistable.last_updated = now;

  // Upsert by `(source, external_slug)` — the partial UNIQUE index
  // from sql/038. This guarantees:
  //   1. Re-scraping is a no-op for unchanged rows (only timestamps
  //      bump).
  //   2. A hypothetical hash collision against an existing rg-muni
  //      row would update THAT row (because the slug match wins),
  //      which is what we want. A collision against a Smarticket
  //      row can't happen because the index includes `source`.
  const { error } = await supabase
    .from("events")
    .upsert(persistable, { onConflict: "source,external_slug" });

  if (error) {
    logger.error(
      `[CityApi] #${row.id} upsert failed: ${error.message}`,
    );
    return false;
  }
  return true;
}

// Mark a (source='rg-muni', external_slug=slug) row as archived.
// Used when a single-row parent event gets fanned out into N child
// rows — the parent's slug is no longer a real event but the row
// may already exist in the DB from earlier (pre-fan-out) cycles.
// Idempotent: the `.eq("archived", false)` clause means subsequent
// runs are no-ops; the `.select("id")` is purely for logging.
async function archiveCityEventBySlug(slug, logger) {
  if (!slug) return false;
  const { data, error } = await supabase
    .from("events")
    .update({ archived: true })
    .eq("source", "rg-muni")
    .eq("external_slug", slug)
    .eq("archived", false)
    .select("id");
  if (error) {
    logger.warn(
      `[CityApi] archive parent slug=${slug} failed: ${error.message}`,
    );
    return false;
  }
  if (data && data.length > 0) {
    logger.log(
      `[CityApi] archived umbrella parent slug=${slug} (id=${data[0].id})`,
    );
  }
  return true;
}

/**
 * Scrape one cycle of the municipal lobby API.
 *
 * @param {Object} [opts]
 * @param {Console} [opts.logger=console] override for tests.
 * @param {boolean} [opts.dryRun=false] when true, skip the upsert
 *   step but still run Layer 1 + Layer 2 fully — useful for
 *   verification before flipping the switch.
 * @returns {Promise<{
 *   collected:number,
 *   smarticket:number,
 *   cityCandidates:number,
 *   cityOnly:number,
 *   umbrella:number,
 *   multiSessionParents:number,
 *   multiSessionChildren:number,
 *   detailErrors:number,
 *   upserted:number,
 *   upsertErrors:number,
 * }>}
 */
async function scrapeCityApi(opts = {}) {
  const logger = opts.logger || console;
  const dryRun = !!opts.dryRun;

  const lobby = await fetchLobby();
  const events = collectLobbyEvents(lobby);
  logger.log(
    `[CityApi] collected ${events.length} lobby events (slider + close + categorised, deduped)`,
  );

  // Layer 1
  const smarticketHits = [];
  const candidates = [];
  for (const e of events) {
    const cls = classifyLobbyEvent(e);
    if (cls.kind === "smarticket") {
      smarticketHits.push({ event: e, cls });
    } else {
      candidates.push({ event: e, cls });
    }
  }
  logger.log(
    `[CityApi] layer 1: ${smarticketHits.length} smarticket-backed (skip), ${candidates.length} city-candidate(s)`,
  );

  // Layer 2 + upsert
  let cityOnly = 0;
  let umbrella = 0;
  let multiSessionParents = 0; // umbrella parents fanned out to children
  let multiSessionChildren = 0; // total child rows produced
  let detailErrors = 0;
  let upserted = 0;
  let upsertErrors = 0;

  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i];
    const detail = await fetchDetailSafe(cand.cls.slug, logger);
    if (!detail) {
      detailErrors++;
      // Still pace — we fired an HTTP request even on failure.
      if (i < candidates.length - 1) {
        await new Promise((r) => setTimeout(r, DETAIL_FETCH_GAP_MS));
      }
      continue;
    }

    const verdict = classifyDetail(detail);
    if (!verdict.cityOnly) {
      umbrella++;
    } else {
      cityOnly++;
    }

    // Fan-out is independent of cityOnly/umbrella classification.
    //
    // BEFORE: fan-out only ran when classifyDetail said cityOnly=true.
    // That worked for pure city-only umbrellas (e.g. `active-garden-2026`,
    // 11 sessions, all non-Smarticket), but broke for MIXED umbrellas
    // like `shavuot-2026`: 27 schedule items where ~15 link to
    // Smarticket AND ~11 are pure city-only (`registerLink: null`
    // with `eventInfo`/`location` populated, or external non-Smarticket
    // links like bina.org.il). The Smarticket footprint flipped
    // classifyDetail to cityOnly=false → fan-out skipped → all 11
    // city-only children were silently dropped on the floor. The
    // Smarticket children were ingested separately by their tenant
    // scrapers (mbe-rg, ramat-gan) but without any backlink to the
    // umbrella, so searching for "שבועות" missed half the cluster.
    //
    // The fix: ALWAYS look for city-only children in the schedule
    // and fan them out. `extractCitySchedule` already filters out
    // Smarticket entries (returns only non-Smarticket children), so
    // we don't double-ingest with the tenant scrapers. When the
    // umbrella is "pure" Smarticket (every child has a Smarticket
    // link), extractCitySchedule returns [] and we don't write
    // anything new — same as before.
    const citySessions = extractCitySchedule(detail);
    // Threshold = 1: even a single child carries richer per-session
    // data than the parent's placeholder fields ("רחבי העיר",
    // content.date is the campaign-start date, not the first
    // session). Storing the child is strictly better than the
    // parent in that case too.
    if (citySessions && citySessions.length >= 1) {
      multiSessionParents++;
      if (dryRun) {
        logger.log(
          `[CityApi] dry-run multi-session: parent "${cand.cls.slug}" (cityOnly=${verdict.cityOnly}) → ${citySessions.length} non-smarticket child session(s)`,
        );
      } else {
        let childrenWritten = 0;
        for (const child of citySessions) {
          try {
            const childRow = buildCityChildEventRow(
              cand.event,
              detail,
              child,
            );
            const ok = await upsertCityEventRow(childRow, logger);
            if (ok) {
              upserted++;
              childrenWritten++;
              multiSessionChildren++;
            } else {
              upsertErrors++;
            }
          } catch (err) {
            upsertErrors++;
            logger.error(
              `[CityApi] "${cand.cls.slug}" child upsert threw: ${err.message}`,
            );
          }
        }
        // Archive the parent slug if a row already exists from a
        // pre-fan-out scrape. No-op (idempotent) on subsequent
        // runs because the WHERE clause filters out archived rows.
        try {
          await archiveCityEventBySlug(cand.cls.slug, logger);
        } catch (err) {
          logger.warn(
            `[CityApi] archive parent "${cand.cls.slug}" failed: ${err.message}`,
          );
        }
        if (childrenWritten > 0) {
          logger.log(
            `[CityApi] fan-out parent="${cand.cls.slug}" (cityOnly=${verdict.cityOnly}) → wrote ${childrenWritten} child session(s)`,
          );
        }
      }
    } else if (verdict.cityOnly) {
      // Single-session city event — original path. Only runs for
      // genuinely city-only events with no schedule[] (or empty
      // schedule[]). Mixed umbrellas with cityOnly=false fall
      // through to nothing here, which is correct: the Smarticket
      // children are handled by the tenant scrapers and the
      // non-Smarticket children were just fanned out above. The
      // parent row itself shouldn't exist as a single event in
      // that case.
      try {
        const row = buildCityEventRow(cand.event, detail);
        if (dryRun) {
          if (cityOnly <= 3) {
            // Print the first few full rows so the operator can sanity-
            // check field values (id range, audience map, image URL,
            // raw address) without spelunking the whole feed.
            const { _rawAddress, _tagNames, ...persistable } = row;
            logger.log(
              `[CityApi] dry-run sample #${cityOnly}:`,
              { ...persistable, _rawAddress, _tagNames },
            );
          }
        } else {
          const ok = await upsertCityEventRow(row, logger);
          if (ok) upserted++;
          else upsertErrors++;
        }
      } catch (err) {
        upsertErrors++;
        logger.error(
          `[CityApi] "${cand.cls.slug}" buildRow/upsert threw: ${err.message}`,
        );
      }
    } else {
      // Mixed umbrella (cityOnly=false) with NO non-Smarticket
      // children — the entire schedule is Smarticket-backed. The
      // tenant scrapers cover those children. Nothing to do here;
      // the parent slug isn't a real event in its own right. If a
      // pre-fan-out row exists from an earlier cycle (the umbrella
      // started as cityOnly and gained a Smarticket child later),
      // archive it now so it stops appearing in searches.
      try {
        await archiveCityEventBySlug(cand.cls.slug, logger);
      } catch (err) {
        logger.warn(
          `[CityApi] archive parent "${cand.cls.slug}" failed: ${err.message}`,
        );
      }
    }

    if (i < candidates.length - 1) {
      await new Promise((r) => setTimeout(r, DETAIL_FETCH_GAP_MS));
    }
  }

  logger.log(
    `[CityApi] layer 2: ${cityOnly} city-only (${multiSessionParents} multi-session → ${multiSessionChildren} child rows), ${umbrella} umbrella(skip), ${detailErrors} fetch error(s)`,
  );
  if (!dryRun) {
    logger.log(
      `[CityApi] upsert: ${upserted} ok, ${upsertErrors} failed`,
    );
  }

  return {
    collected: events.length,
    smarticket: smarticketHits.length,
    cityCandidates: candidates.length,
    cityOnly,
    umbrella,
    multiSessionParents,
    multiSessionChildren,
    detailErrors,
    upserted,
    upsertErrors,
  };
}

module.exports = {
  scrapeCityApi,
};

if (require.main === module) {
  const dryRun = process.argv.includes("--dry-run");
  scrapeCityApi({ dryRun })
    .then((stats) => {
      console.log("[CityApi] done:", stats);
      process.exit(0);
    })
    .catch((err) => {
      console.error("[CityApi] fatal:", err.message);
      if (process.env.DEBUG) console.error(err.stack);
      process.exit(1);
    });
}
