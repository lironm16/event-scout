// Series-parent normalization (sql/086).
//
// Why this exists:
//   A recurring same-name Smarticket show ("ר\"געים משחקיה התפתחותית")
//   lives as N independent `events` rows that share NO external_slug, so
//   the slug-based grouping in lib/smarticketUmbrellaService.js never
//   collapsed them. The result: the full ~2KB description was DUPLICATED
//   on every one of the ~100+ occurrences (measured 431KB across 35
//   series, two ר"געים series = 93%).
//
//   This module promotes each such series to a "series-parent" umbrella
//   (umbrellas.series_key, sql/086) that stores the shared description
//   ONCE. Children link via events.umbrella_id and inherit the prose
//   through the read-path fallback in bot/matchingService.js
//   (description = child.description ?? umbrella_parent.description). The
//   child's own description is then NULLed.
//
// UI-safety (see sql/086): series children get umbrella_id but NOT
//   umbrella_slug/umbrella_title — so lib/eventSeries.js#seriesKey keeps
//   keying them on name+age (the "🔁 כל המופעים" recurring-series card),
//   never the programme-umbrella ("📋 כל אירועי …") card.
//
// Two entry points:
//   1. reconcileSeriesParents()  — batch reconciler. Creates parents,
//      links children, moves the description up, NULLs children. Run by
//      the Phase-4 backfill and periodically after each enrich cycle.
//   2. persistChildDescription() / isSeriesChild() — used by the enricher
//      so a freshly-fetched description for an already-linked child is
//      routed to the parent instead of re-duplicated onto the child.

const supabase = require("./supabase");
const { seriesKey } = require("./eventSeries");

// Same threshold as the slug-based umbrella service — a "series" needs
// at least two occurrences to be worth a parent row.
const MIN_OCCURRENCES = 2;

// A synthetic, deterministic slug for a series-parent umbrella. The
// umbrellas.slug column is NOT NULL + unique per (source, slug); series
// have no natural slug, so we derive a stable one from the seriesKey.
// Children are matched on series_key, never this slug.
function seriesSlug(key) {
  // Short, stable, filesystem/URL-safe. The raw key is human-readable
  // Hebrew with separators — keep it but prefix so it can never collide
  // with a real city/Smarticket slug.
  return `series:${key}`;
}

// Pick the description to store on the parent: the longest non-empty
// blurb among the occurrences (longest = least likely to be a truncated
// or partial fetch; also dodges the historical 2000-char cap when a
// later full fetch exists).
function bestDescription(rows) {
  let best = "";
  for (const r of rows) {
    const d = (r.description || "").trim();
    if (d.length > best.length) best = d;
  }
  return best || null;
}

/**
 * Is this event linked to a SERIES-parent umbrella (vs a programme
 * umbrella, vs none)? Returns { umbrellaId, parentDescription } or null.
 */
async function getSeriesParentFor(eventId) {
  const { data } = await supabase
    .from("events")
    .select("umbrella_id, umbrellas:umbrella_id(id, series_key, description)")
    .eq("id", eventId)
    .maybeSingle();
  const u = data?.umbrellas;
  if (!u || u.series_key == null) return null; // not a series child
  return { umbrellaId: u.id, parentDescription: u.description || null };
}

/**
 * Write a freshly-fetched description for a child occurrence WITHOUT
 * re-duplicating it. If the child is already linked to a series parent,
 * the prose goes to the parent (when the parent's is empty or shorter)
 * and the child's own column stays NULL. Otherwise it behaves like the
 * legacy write: set the child's description only when currently NULL.
 *
 * Returns true when something was written.
 */
async function persistChildDescription(eventId, description) {
  const desc = (description || "").trim();
  if (!desc) return false;

  const parent = await getSeriesParentFor(eventId);
  if (parent) {
    // Route to the parent; keep the child NULL.
    if (!parent.parentDescription || desc.length > parent.parentDescription.length) {
      await supabase
        .from("umbrellas")
        .update({ description: desc, updated_at: new Date().toISOString() })
        .eq("id", parent.umbrellaId);
    }
    // Defensive: ensure the child didn't keep a stale copy.
    await supabase.from("events").update({ description: null }).eq("id", eventId).not("description", "is", null);
    return true;
  }

  // Legacy path — singleton or not-yet-reconciled: write only when null.
  await supabase.from("events").update({ description: desc }).eq("id", eventId).is("description", null);
  return true;
}

/**
 * Batch reconciler. Groups active, non-umbrella events by seriesKey
 * (name + age), and for every group of ≥ MIN_OCCURRENCES:
 *   1. upsert a series-parent umbrella holding the shared description,
 *   2. link the children (events.umbrella_id) — NOT umbrella_slug/title,
 *   3. NULL the children's own description.
 *
 * @param {Object}  opts
 * @param {boolean} [opts.apply=false]  When false, only reports what it
 *   WOULD do (dry run) — no writes.
 * @returns {Promise<{series:number, children:number, freedBytes:number, groups:Array}>}
 */
async function reconcileSeriesParents({ apply = false } = {}) {
  // Pull every active event with the fields needed to group + dedup.
  let from = 0;
  const all = [];
  while (true) {
    const { data, error } = await supabase
      .from("events")
      .select("id, source, name, min_months, max_months, umbrella_slug, umbrella_id, image, description")
      .eq("archived", false)
      .range(from, from + 999);
    if (error) throw new Error(`reconcile fetch failed: ${error.message}`);
    all.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }

  // Group by seriesKey, but ONLY rows without a real programme umbrella
  // (umbrella_slug). Series children that we previously linked carry
  // umbrella_id but NOT umbrella_slug, so they re-group correctly here.
  const groups = new Map();
  for (const e of all) {
    if (e.umbrella_slug) continue; // real programme umbrella — leave alone
    const key = seriesKey(e);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }

  const report = { series: 0, children: 0, freedBytes: 0, groups: [] };

  for (const [key, rows] of groups) {
    if (rows.length < MIN_OCCURRENCES) continue;
    const source = rows[0].source;
    const desc = bestDescription(rows);
    if (!desc) continue; // nothing to dedup

    // Bytes reclaimed = every child copy beyond the one parent copy.
    const dupBytes = rows.reduce((s, r) => s + (r.description || "").length, 0) - desc.length;
    report.series += 1;
    report.children += rows.length;
    report.freedBytes += dupBytes;
    report.groups.push({ key, n: rows.length, dupKB: Math.round(dupBytes / 1024) });

    if (!apply) continue;

    // 1. Upsert the series-parent umbrella (match on source+series_key).
    const slug = seriesSlug(key);
    const title = rows.map((r) => r.name).find(Boolean) || key;
    const image = rows.map((r) => r.image).find(Boolean) || null;
    const { data: existingU } = await supabase
      .from("umbrellas")
      .select("id, description")
      .eq("source", source)
      .eq("series_key", key)
      .maybeSingle();

    let umbrellaId;
    if (existingU) {
      umbrellaId = existingU.id;
      // Keep the longest description.
      if (!existingU.description || desc.length > existingU.description.length) {
        await supabase
          .from("umbrellas")
          .update({ description: desc, image_url: image, updated_at: new Date().toISOString() })
          .eq("id", umbrellaId);
      }
    } else {
      const { data: created, error: insErr } = await supabase
        .from("umbrellas")
        .insert({ source, slug, series_key: key, title, description: desc, image_url: image })
        .select("id")
        .maybeSingle();
      if (insErr) {
        console.warn(`[SeriesParent] upsert "${key}": ${insErr.message}`);
        continue;
      }
      umbrellaId = created?.id;
    }
    if (!umbrellaId) continue;

    // 2. Link children that aren't linked yet (umbrella_id only).
    const toLink = rows.filter((r) => r.umbrella_id == null).map((r) => r.id);
    if (toLink.length) {
      const { error: linkErr } = await supabase
        .from("events")
        .update({ umbrella_id: umbrellaId })
        .in("id", toLink);
      if (linkErr) { console.warn(`[SeriesParent] link "${key}": ${linkErr.message}`); continue; }
    }

    // 3. NULL the children's own description (parent now holds it).
    const toNull = rows.filter((r) => (r.description || "").length).map((r) => r.id);
    if (toNull.length) {
      const { error: nullErr } = await supabase
        .from("events")
        .update({ description: null })
        .in("id", toNull);
      if (nullErr) console.warn(`[SeriesParent] null-desc "${key}": ${nullErr.message}`);
    }
  }

  return report;
}

module.exports = {
  reconcileSeriesParents,
  persistChildDescription,
  getSeriesParentFor,
  seriesSlug,
};
