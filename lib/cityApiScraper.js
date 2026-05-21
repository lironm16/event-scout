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
  extractSlug,
  resolveImageUrl,
} = require("./cityApi");
const { ensureLocationKey } = require("./locationResolver");
const { resolveMany } = require("./labelStore");
const { extractVenueFromText } = require("./addressNormalizer");
const { DEFAULT_CITY } = require("./geocodingDefaults");

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

// Upsert an umbrellas row from the parent's lobby entry + detail
// payload, and return the row's `id`. Idempotent: re-running with
// the same (source, slug) updates the display fields (title,
// image_url, external_url) in case the curator edited them, but
// preserves the inheritance `default_*` columns (those are
// maintained either by the initial sql/058 backfill — MODE over
// existing children — or by a periodic refresh job we'll add later).
//
// Why we don't write defaults here:
//   The parent payload's own audience / category fields are a
//   curator-tagged hint but they routinely lie about specific
//   children. The canonical case is the "מגוון הרצאות לאזרחים
//   ותיקים" umbrella: parent says category=lectures, but one or
//   two children inside it are bingo nights / parties. MODE() over
//   the actual children is a more accurate signal than the
//   parent's marketing label. We let the SQL-side refresh own
//   that derivation so the scraper can stay dumb.
//
// Returns null on any error / missing slug — the child build path
// then stamps `umbrella_id: null`, falling back to the legacy
// `umbrella_slug` text join until the umbrella row appears.
async function upsertUmbrellaRow(lobbyEntry, detailJson, source, logger) {
  const parentUrl = lobbyEntry?.detailsLink?.url || null;
  const slug = extractSlug(parentUrl);
  if (!slug) {
    logger.warn(
      `[CityApi] upsertUmbrella: cannot extract slug from "${parentUrl}"`,
    );
    return null;
  }
  const title =
    lobbyEntry?.title || detailJson?.content?.title || slug;
  const imagePath =
    detailJson?.content?.media?.link ||
    lobbyEntry?.eventBackground?.link ||
    detailJson?.content?.media?.linkMobile ||
    lobbyEntry?.eventBackground?.linkMobile ||
    null;
  // Normalise the umbrella's external URL the same way the bot's
  // "פרטים" link does — relative slugs get the city domain so the
  // value stored in `umbrellas.external_url` is directly clickable.
  const externalUrl = parentUrl
    ? parentUrl.startsWith("http")
      ? parentUrl
      : `https://www.ramat-gan.muni.il${parentUrl}`
    : null;

  const payload = {
    source,
    slug,
    title,
    image_url: resolveImageUrl(imagePath),
    external_url: externalUrl,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from("umbrellas")
    .upsert(payload, { onConflict: "source,slug" })
    .select("id")
    .maybeSingle();
  if (error) {
    logger.warn(
      `[CityApi] upsertUmbrella failed for "${slug}": ${error.message}`,
    );
    return null;
  }
  return data?.id || null;
}

// When an umbrella child event also has a standalone dedicated page on the
// city website, both paths produce a row in our DB:
//
//   1. The lobby scraper creates a rich standalone row (own slug,
//      image, description, accurate start time).
//   2. The umbrella schedule creates a synthetic child row
//      (slug = "<parent>__<date>__<locId>__<hour>", minimal data).
//
// Keeping both causes duplicate cards in search results for the same
// physical event. This function detects the collision and merges:
//
//   - Find a standalone event with (source='rg-muni', date, location_key)
//     where the slug is NOT the synthetic "__"-based format.
//   - If found, stamp umbrella_id / umbrella_slug / umbrella_title onto
//     the standalone (so it gains the series context) and return true.
//   - The caller then skips inserting the synthetic child and adds its
//     slug to loserSlugs so any pre-existing DB row is purged.
//
// Guard: we require location_key to be non-null (the location must be
// resolvable and specific — not "רחבי העיר"). Without a location we
// can't reliably distinguish a collision from two different events at
// different venues on the same day.
async function linkStandaloneIfExists(row, logger) {
  const rawAddress = row._rawAddress;
  if (!rawAddress) return false;

  let locationKey;
  try {
    locationKey = await ensureLocationKey(rawAddress);
  } catch {
    return false;
  }
  if (!locationKey) return false;

  // Look for a standalone event: same source, same date, same resolved
  // venue, and no umbrella assigned yet.
  // Using `umbrella_id IS NULL` is more reliable than a slug-pattern
  // check because SQL LIKE treats `_` as a wildcard; without careful
  // escaping `%__%` matches every string, not just synthetic slugs.
  const { data: candidates, error } = await supabase
    .from("events")
    .select("id, external_slug, umbrella_id")
    .eq("source", "rg-muni")
    .eq("date", row.date)
    .eq("location_key", locationKey)
    .is("umbrella_id", null);

  if (error || !candidates || candidates.length === 0) return false;

  // If multiple standalone events share the same location+date (rare but
  // possible: morning workshop + evening concert), bail out conservatively
  // — we can't determine which one to link without fuzzy name matching.
  if (candidates.length > 1) {
    logger.log(
      `[CityApi] linkStandalone: ${candidates.length} standalones at ` +
        `"${locationKey}" on ${row.date} — skipping merge to avoid false join`,
    );
    return false;
  }

  const standalone = candidates[0];

  // Don't hijack a standalone that already has its own real named city
  // page — e.g. "2026-zoom-story-time" appearing in the schedule of
  // "maaseh-bazoom-may". The standalone IS a first-class event; stamping
  // an unrelated umbrella onto it would make "📋 כל אירועי X" point to
  // the wrong parent.
  //
  // Synthetic slugs always contain "__" (buildCityChildEventRow convention).
  // A slug without "__" that differs from the umbrella's own slug means
  // this standalone has its own dedicated city page — leave it alone.
  const standaloneHasOwnPage =
    standalone.external_slug &&
    !standalone.external_slug.includes("__") &&
    standalone.external_slug !== row.umbrella_slug;
  if (standaloneHasOwnPage) {
    logger.log(
      `[CityApi] linkStandalone: "${standalone.external_slug}" has its own ` +
        `city page — skipping umbrella stamp from "${row.umbrella_slug}"`,
    );
    return false;
  }

  const { error: upErr } = await supabase
    .from("events")
    .update({
      umbrella_id:    row.umbrella_id,
      umbrella_slug:  row.umbrella_slug,
      umbrella_title: row.umbrella_title,
    })
    .eq("id", standalone.id);

  if (upErr) {
    logger.warn(
      `[CityApi] linkStandalone: failed to link #${standalone.id} ` +
        `"${standalone.external_slug}" → umbrella "${row.umbrella_slug}": ${upErr.message}`,
    );
    return false;
  }

  logger.log(
    `[CityApi] linkStandalone: merged "${standalone.external_slug}" ` +
      `→ umbrella "${row.umbrella_slug}" (synthetic child skipped)`,
  );
  return true;
}

async function upsertCityEventRow(row, logger) {
  // Strip the helper fields before sending to Supabase. The
  // `_rawAddress` and `_tagNames` keys are buildCityEventRow's
  // contract for "more work to do here" — we resolve them now.
  const { _rawAddress, _tagNames, ...persistable } = row;

  // Resolve venue → location_key.
  // Primary path: _rawAddress from CMS JSON fields.
  // Fallback: ask Gemini to extract venue from description when CMS had none.
  let resolvedAddress = _rawAddress || null;
  if (!resolvedAddress && persistable.description) {
    try {
      const extracted = await extractVenueFromText(
        persistable.name || "",
        persistable.description,
        { city: DEFAULT_CITY },
      );
      if (extracted) {
        logger.log(`[CityApi] #${row.id} venue extracted from description: "${extracted}"`);
        resolvedAddress = extracted;
      }
    } catch (err) {
      logger.warn(`[CityApi] #${row.id} extractVenueFromText failed: ${err.message}`);
    }
  }
  if (resolvedAddress) {
    try {
      const key = await ensureLocationKey(resolvedAddress);
      if (key) persistable.location_key = key;
    } catch (err) {
      logger.warn(
        `[CityApi] #${row.id} ensureLocationKey("${resolvedAddress}") failed: ${err.message}`,
      );
    }
  }

  // Read the existing row ONCE up-front. We need it for two
  // preservation passes that both run unconditionally on every
  // city-event upsert:
  //
  //   1. tag_ids merge — combine scraper-time cluster tags
  //      (`_tagNames`) with semantic tags the enricher has already
  //      written (Gemini output). Without this every 3-minute scrape
  //      clobbers Gemini's tags down to just the cluster name.
  //
  //   2. category / audience preservation — `mapCategory` / `mapAudience`
  //      return `null` for the vast majority of city events (the city
  //      CMS labels are coarser than our enum), so writing a fresh
  //      `null` here would erase the enricher-derived category/audience
  //      from Gemini on every cycle. Only overwrite when the scraper
  //      genuinely has a value to provide.
  //
  // One SELECT per upsert (~10ms locally) is the right tradeoff at
  // ~200 rows per cycle.
  let existingRow = null;
  try {
    const { data } = await supabase
      .from("events")
      .select("tag_ids, category, audience, access")
      .eq("source", row.source)
      .eq("external_slug", row.external_slug)
      .maybeSingle();
    existingRow = data || null;
  } catch (err) {
    logger.warn(
      `[CityApi] #${row.id} existing-row read failed: ${err.message}`,
    );
  }

  if (Array.isArray(_tagNames) && _tagNames.length) {
    try {
      const scrapedTagIds = await resolveMany(_tagNames);
      if (scrapedTagIds.length) {
        const existingIds = Array.isArray(existingRow?.tag_ids)
          ? existingRow.tag_ids
          : [];
        if (existingIds.length === 0) {
          persistable.tag_ids = scrapedTagIds;
        } else {
          const seen = new Set(existingIds);
          const merged = [...existingIds];
          for (const id of scrapedTagIds) {
            if (!seen.has(id)) {
              seen.add(id);
              merged.push(id);
            }
          }
          persistable.tag_ids = merged;
        }
      }
    } catch (err) {
      logger.warn(
        `[CityApi] #${row.id} tag resolution failed: ${err.message}`,
      );
    }
  }

  // Don't blank-out enricher-set category/audience when the scraper's
  // own mappers returned null. The scrape value, if non-null, IS
  // authoritative (the city editor explicitly chose it) and wins; a
  // null from the scraper means "I have no opinion" and should be
  // preserved as-is in the DB.
  if ((persistable.category == null) && existingRow?.category) {
    delete persistable.category;
  }
  if ((persistable.audience == null) && existingRow?.audience) {
    delete persistable.audience;
  }

  // Don't downgrade `access` from a community scope back to ['open'].
  // events.access is now access_t[] — an array. The classifier returns
  // ['open'] when it sees no community signal, which is a WEAKER
  // statement than the community scopes already in the DB (set by a
  // backfill, manual SQL edit, or a previous scraper cycle with more
  // context). We preserve the existing value in three race classes:
  //   1. Classifier upgrades: backfill set rows to ['community-seniors']
  //      using umbrella context; the still-deployed older scraper
  //      returns ['open']. Without this guard every cycle erases it.
  //   2. Manual ops edits via Supabase SQL editor.
  //   3. A future enricher that decides access from description /
  //      external sources — its writes mustn't be erased on the next cycle.
  // A genuine upgrade (incoming has community scopes) is always written.
  const incomingIsOpenOnly =
    Array.isArray(persistable.access) &&
    persistable.access.length === 1 &&
    persistable.access[0] === "open";
  const existingHasCommunity =
    Array.isArray(existingRow?.access) &&
    existingRow.access.some((s) => s !== "open");
  if (incomingIsOpenOnly && existingHasCommunity) {
    delete persistable.access;
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
// Remove a parent umbrella row from the events table. We DELETE
// (not "archive") because the parent slug is not a real attendable
// event — it's the city site's marketing aggregator page that fans
// out to N actual sessions ("שישי ישראלי" → one row per venue/date).
// Keeping it around as archived clutters DB views and historical
// queries with rows that never represented anything the user could
// actually attend.
//
// Foreign-key safety: all `events.id` references (`event_feedback`,
// `event_watchers`, `low_stock_notifications`, `ticket_history`,
// `saved_search_event_views`) cascade or set-null on delete (see
// sql/006, sql/018, sql/022, sql/033, sql/044, sql/047). Whatever
// dependent rows existed against the parent slug were orphans
// anyway (the parent was already archived, so no live tickets /
// watchers / feedback can target it), and CASCADE cleans them up.
//
// If the DELETE somehow fails (e.g. a new FK without ON DELETE is
// added later and references the parent id), we fall back to
// archive=true so the cycle still makes progress — the operator
// will see the warning in the scrape log and can investigate.
async function deleteCityEventBySlug(slug, logger) {
  if (!slug) return false;
  const { data, error } = await supabase
    .from("events")
    .delete()
    .eq("source", "rg-muni")
    .eq("external_slug", slug)
    .select("id");
  if (error) {
    logger.warn(
      `[CityApi] delete parent slug=${slug} failed: ${error.message}; falling back to archive`,
    );
    // Fallback path: keep the row but mark archived so it stops
    // appearing in search results. Same behaviour as the previous
    // implementation. The next cycle will retry the DELETE.
    const { error: archErr } = await supabase
      .from("events")
      .update({ archived: true })
      .eq("source", "rg-muni")
      .eq("external_slug", slug)
      .eq("archived", false);
    if (archErr) {
      logger.warn(
        `[CityApi] archive fallback for slug=${slug} also failed: ${archErr.message}`,
      );
      return false;
    }
    return true;
  }
  if (data && data.length > 0) {
    logger.log(
      `[CityApi] deleted umbrella parent slug=${slug} (id=${data[0].id})`,
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
  let crossUmbrellaDeduped = 0; // duplicate child events dropped across umbrellas

  // Cross-umbrella dedup buffer (May-2026 user report). The city site
  // publishes the SAME physical event under MULTIPLE umbrella
  // categories — e.g. "הפנינג שבועות" appears in both `shavuot-2026`
  // (broader "all shavuot in Ramat Gan") and
  // `shavuot-at-the-community-centers` (subset). Each umbrella's
  // fan-out builds its own child row with a different
  // `external_slug` (parentSlug__date__locId__hour), so a naive
  // upsert produces N rows for 1 physical event — searches and the
  // newsletter then show duplicates.
  //
  // We defer all multi-session upserts here and dedup at the end of
  // the run by a physical-event fingerprint (date + start_time +
  // distinguishing child title + raw venue). On a collision we keep
  // the row whose umbrella has the MOST children in this run — that
  // umbrella is the broader category, so its `umb:` view is the most
  // informative landing page for the child.
  const pendingChildren = []; // [{ row, parentSlug }]
  const parentChildCounts = new Map(); // umbrella_slug → count seen this run
  const parentDeletesPending = new Set(); // slugs to remove after fan-out completes

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
        // Phase 2 of the umbrella normalisation (sql/058): before
        // building any children, upsert the umbrella row itself so
        // the FK target exists. We stamp the returned id on every
        // child below so the child→umbrella relationship is a real
        // FK reference instead of relying on the legacy text-join
        // through `umbrella_slug`. On failure (umbrellaId = null)
        // the child row falls back to `umbrella_slug` only — the
        // legacy path still works, we just lose the FK linkage for
        // this cycle until the next successful upsert.
        const umbrellaId = await upsertUmbrellaRow(
          cand.event,
          detail,
          "rg-muni",
          logger,
        );

        // Build all children for this parent and BUFFER them — the
        // actual upsert + parent-delete runs at the end of the
        // scrape, after we've seen every umbrella and can resolve
        // cross-umbrella collisions deterministically.
        let buffered = 0;
        for (const child of citySessions) {
          try {
            const childRow = buildCityChildEventRow(
              cand.event,
              detail,
              child,
              umbrellaId,
            );
            pendingChildren.push({ row: childRow, parentSlug: cand.cls.slug });
            buffered++;
          } catch (err) {
            upsertErrors++;
            logger.error(
              `[CityApi] "${cand.cls.slug}" child build threw: ${err.message}`,
            );
          }
        }
        parentChildCounts.set(cand.cls.slug, buffered);
        // The parent slug page is the marketing aggregator and
        // not a real attendable event — we'll have N child rows
        // covering the actual sessions, so the parent row (if it
        // exists from a pre-fan-out cycle) needs to go. Defer the
        // delete to the post-loop phase so we keep all DB writes
        // batched together; idempotent on subsequent cycles
        // because there's nothing left to delete.
        parentDeletesPending.add(cand.cls.slug);
        if (buffered > 0) {
          logger.log(
            `[CityApi] fan-out parent="${cand.cls.slug}" (cityOnly=${verdict.cityOnly}) → buffered ${buffered} child session(s)`,
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
      // delete it so it stops polluting historical queries.
      try {
        await deleteCityEventBySlug(cand.cls.slug, logger);
      } catch (err) {
        logger.warn(
          `[CityApi] delete parent "${cand.cls.slug}" failed: ${err.message}`,
        );
      }
    }

    if (i < candidates.length - 1) {
      await new Promise((r) => setTimeout(r, DETAIL_FETCH_GAP_MS));
    }
  }

  // ── Cross-umbrella dedup + buffered child upserts ──────────────
  //
  // Fingerprint = the physical-event identity, independent of which
  // umbrella surfaced it:
  //
  //   (date, start_time, distinguishing_title, _rawAddress)
  //
  // `distinguishing_title` is the child's own label — i.e. `name`
  // when it differs from `umbrella_title` (the shavuot case where
  // each child is a separate sub-event), or "" when `name` echoes
  // the umbrella verbatim (active-garden case: the umbrella IS the
  // activity, and date+venue alone identify a physical session).
  // Using `name` directly would over-segment the active-garden case
  // — two umbrellas surfacing the same recurring activity would
  // never collide because their `name` would equal their distinct
  // umbrella titles.
  //
  // Collisions are resolved by parent-count: the umbrella with MORE
  // children in this run is the broader / more useful category to
  // attach the surviving row to, so a user tapping "📋 כל אירועי…"
  // from a search result sees the full sibling list rather than the
  // tighter subset. Ties are broken by lexicographic parent slug
  // (deterministic, no other signal).
  // Track "loser" external_slugs so we can purge stale rows that a
  // previous scrape (pre-dedup) wrote to the DB. Without this, the
  // new code only inserts the winning row; the duplicate rows from
  // the smaller umbrella remain forever (their external_slug is
  // never re-emitted, so the (source, external_slug) upsert never
  // touches them).
  const loserSlugs = [];
  if (!dryRun && pendingChildren.length) {
    const byFingerprint = new Map();
    function distinguishingTitleOf(row) {
      const name = (row.name || "").trim();
      const umbrella = (row.umbrella_title || "").trim();
      return name && name !== umbrella ? name : "";
    }
    function fingerprintOf(row) {
      return [
        row.date || "nodate",
        row.start_time || "nohour",
        distinguishingTitleOf(row),
        row._rawAddress || "",
      ].join("||");
    }
    for (const item of pendingChildren) {
      const fp = fingerprintOf(item.row);
      const existing = byFingerprint.get(fp);
      if (!existing) {
        byFingerprint.set(fp, item);
        continue;
      }
      const existingCount = parentChildCounts.get(existing.parentSlug) ?? 0;
      const candidateCount = parentChildCounts.get(item.parentSlug) ?? 0;
      const candidateWins =
        candidateCount > existingCount ||
        (candidateCount === existingCount &&
          item.parentSlug < existing.parentSlug);
      const loser = candidateWins ? existing : item;
      if (candidateWins) {
        byFingerprint.set(fp, item);
      }
      crossUmbrellaDeduped++;
      loserSlugs.push(loser.row.external_slug);
      logger.log(
        `[CityApi] dedup: "${item.row.name}" ` +
          `@ ${item.row.date} ${item.row.start_time} — kept "${
            candidateWins ? item.parentSlug : existing.parentSlug
          }" over "${candidateWins ? existing.parentSlug : item.parentSlug}"`,
      );
    }
    for (const { row, parentSlug } of byFingerprint.values()) {
      try {
        // Before creating a synthetic child row, check whether the same
        // physical event already has a richer standalone page in the DB.
        // If so, link the umbrella onto that row instead of duplicating.
        const linked = await linkStandaloneIfExists(row, logger);
        if (linked) {
          loserSlugs.push(row.external_slug); // purge any stale synthetic row
          upserted++;
          multiSessionChildren++;
          continue;
        }
        const ok = await upsertCityEventRow(row, logger);
        if (ok) {
          upserted++;
          multiSessionChildren++;
        } else {
          upsertErrors++;
        }
      } catch (err) {
        upsertErrors++;
        logger.error(
          `[CityApi] "${parentSlug}" child upsert threw: ${err.message}`,
        );
      }
    }
    // Purge loser rows already living in the DB from previous
    // pre-dedup scrapes. One bulk DELETE per run — even with 100s
    // of umbrellas the slug list is small.
    if (loserSlugs.length) {
      const { error: delErr } = await supabase
        .from("events")
        .delete()
        .eq("source", "rg-muni")
        .in("external_slug", loserSlugs);
      if (delErr) {
        logger.warn(
          `[CityApi] purge of ${loserSlugs.length} loser slug(s) failed: ${delErr.message}`,
        );
      } else {
        logger.log(
          `[CityApi] purged ${loserSlugs.length} pre-dedup duplicate row(s) from DB`,
        );
      }
    }
  }

  // Parent-slug deletions run AFTER child upserts so a transient
  // failure to upsert children doesn't leave a state with no
  // parent and no children for that umbrella. The deletes are
  // idempotent — re-running picks up any that failed.
  if (!dryRun) {
    for (const slug of parentDeletesPending) {
      try {
        await deleteCityEventBySlug(slug, logger);
      } catch (err) {
        logger.warn(
          `[CityApi] delete parent "${slug}" failed: ${err.message}`,
        );
      }
    }
  }

  logger.log(
    `[CityApi] layer 2: ${cityOnly} city-only (${multiSessionParents} multi-session → ${multiSessionChildren} child rows after dedup, ${crossUmbrellaDeduped} duplicates dropped), ${umbrella} umbrella(skip), ${detailErrors} fetch error(s)`,
  );
  if (!dryRun) {
    logger.log(
      `[CityApi] upsert: ${upserted} ok, ${upsertErrors} failed`,
    );

    // Refresh umbrellas.default_* from the freshly-upserted children.
    // Cheap (~10 umbrellas × ~100 children each) and keeps brand-new
    // umbrellas — and drifting modal classifications — in sync without
    // a separate cron job. Best-effort: a failure here doesn't void
    // the scrape (children were already written), it just delays the
    // next default refresh until the following cycle.
    try {
      const { refreshUmbrellaDefaults } = require("../jobs/refreshUmbrellaDefaults");
      const { umbrellasUpdated } = await refreshUmbrellaDefaults({ verbose: false });
      logger.log(`[CityApi] umbrella defaults refreshed: ${umbrellasUpdated} row(s)`);
    } catch (err) {
      logger.warn(`[CityApi] umbrella defaults refresh failed: ${err.message}`);
    }
  }

  return {
    collected: events.length,
    smarticket: smarticketHits.length,
    cityCandidates: candidates.length,
    cityOnly,
    umbrella,
    multiSessionParents,
    multiSessionChildren,
    crossUmbrellaDeduped,
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
