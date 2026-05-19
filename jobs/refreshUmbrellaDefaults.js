// Recompute `umbrellas.default_audience` / `default_category` /
// `default_access` from the MODE of each umbrella's current
// children. Idempotent — safe to run anytime, multiple times.
//
// Why this exists:
//   Phase 2 of the umbrella normalisation (sql/058) introduced an
//   `umbrellas` table with three "inheritance hint" columns. The
//   initial backfill in sql/058 populated them from MODE() over
//   children at migration time, and the scraper's
//   `upsertUmbrellaRow` populates the umbrella's IDENTITY fields
//   (title, image, external_url) every cycle — but it
//   intentionally leaves the default_* columns alone so it doesn't
//   trample manually-curated overrides.
//
//   That leaves two cases where defaults can go stale:
//     1. A brand-new umbrella appears (the scraper inserts a row
//        with NULL defaults).
//     2. Children's actual classification drifts over time (e.g.
//        a curator re-tags audience for ten Shavuot children;
//        Gemini settles on a new modal category for an umbrella).
//
//   This job catches up both. Cheap (~10 umbrellas × ~100 children
//   each), one UPDATE per umbrella that actually changed.
//
// Logic:
//   For each umbrella with at least one child:
//     - default_audience = MODE(child.audience WHERE NOT NULL)
//     - default_category = MODE(child.category WHERE NOT NULL)
//     - default_access   = MODE(child.access   WHERE NOT NULL AND <> 'open')
//   We exclude 'open' from the access mode because it's the column
//   default — promoting it to an umbrella default would falsely
//   declare "this umbrella is for the general public" when really
//   most children just haven't been classified into a community
//   scope yet. The community-* values are the meaningful signal.
//
// Usage:
//   node -r dotenv/config jobs/refreshUmbrellaDefaults.js

if (require.main === module) {
  require("dotenv").config({
    path: require("path").resolve(__dirname, "..", ".env"),
  });
}

const supabase = require("../lib/supabase");

function modeOf(counter) {
  let best = null;
  let bestCount = 0;
  for (const [value, count] of counter) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

async function refreshUmbrellaDefaults({ verbose = true } = {}) {
  const { data: children, error: readErr } = await supabase
    .from("events")
    .select("umbrella_id, audience, category, access")
    .eq("archived", false)
    .not("umbrella_id", "is", null);
  if (readErr) throw new Error(`refresh: read failed: ${readErr.message}`);

  // bucket → umbrella_id → { aud: Map<v,c>, cat: Map<v,c>, acc: Map<v,c> }
  const buckets = new Map();
  for (const e of children || []) {
    if (!buckets.has(e.umbrella_id)) {
      buckets.set(e.umbrella_id, {
        aud: new Map(),
        cat: new Map(),
        acc: new Map(),
      });
    }
    const b = buckets.get(e.umbrella_id);
    if (e.audience) b.aud.set(e.audience, (b.aud.get(e.audience) || 0) + 1);
    if (e.category) b.cat.set(e.category, (b.cat.get(e.category) || 0) + 1);
    if (e.access && e.access !== "open") {
      b.acc.set(e.access, (b.acc.get(e.access) || 0) + 1);
    }
  }

  let updated = 0;
  const now = new Date().toISOString();
  for (const [id, b] of buckets) {
    const aud = modeOf(b.aud);
    const cat = modeOf(b.cat);
    const acc = modeOf(b.acc);
    const { error: wrErr } = await supabase
      .from("umbrellas")
      .update({
        default_audience: aud,
        default_category: cat,
        default_access: acc,
        updated_at: now,
      })
      .eq("id", id);
    if (wrErr) {
      console.warn(`[RefreshUmbrellas] #${id} write failed: ${wrErr.message}`);
      continue;
    }
    updated++;
    if (verbose) {
      console.log(
        `  #${id}: aud=${aud || "-"}  cat=${cat || "-"}  acc=${acc || "-"}  (n=${
          (b.aud.size && [...b.aud.values()].reduce((a, c) => a + c, 0)) ||
          (b.cat.size && [...b.cat.values()].reduce((a, c) => a + c, 0)) ||
          (b.acc.size && [...b.acc.values()].reduce((a, c) => a + c, 0)) ||
          0
        } children)`,
      );
    }
  }

  // Garbage-collect orphan umbrellas. The cross-umbrella dedup in
  // `lib/cityApiScraper.js` can produce these: `upsertUmbrellaRow`
  // runs eagerly for every parent that fans out, but the dedup
  // step that follows can hand all of an umbrella's children to a
  // sibling umbrella (slug X "loses" to slug Y on every collision).
  // The losing umbrella's row remains with zero children attached,
  // never appearing in `buckets` above. Without this sweep those
  // rows accumulate forever, polluting `SELECT FROM umbrellas` and
  // the eventual Phase 3 "umbrella feed" pages.
  //
  // Safe to delete: no events reference them (umbrella_id FK is
  // ON DELETE SET NULL, and at this point there are none to nullify
  // anyway). If the same parent slug appears in a future scrape and
  // wins this time, `upsertUmbrellaRow` recreates the row fresh.
  const { data: allUmbs, error: listErr } = await supabase
    .from("umbrellas")
    .select("id");
  let orphansDeleted = 0;
  if (!listErr && allUmbs) {
    const childrenIds = new Set(buckets.keys());
    const orphanIds = allUmbs
      .filter((u) => !childrenIds.has(u.id))
      .map((u) => u.id);
    if (orphanIds.length) {
      const { error: delErr } = await supabase
        .from("umbrellas")
        .delete()
        .in("id", orphanIds);
      if (delErr) {
        console.warn(
          `[RefreshUmbrellas] orphan cleanup failed: ${delErr.message}`,
        );
      } else {
        orphansDeleted = orphanIds.length;
        if (verbose && orphansDeleted) {
          console.log(`  cleaned up ${orphansDeleted} orphan umbrella(s)`);
        }
      }
    }
  }

  return {
    umbrellasUpdated: updated,
    totalUmbrellas: buckets.size,
    orphansDeleted,
  };
}

if (require.main === module) {
  refreshUmbrellaDefaults()
    .then(({ umbrellasUpdated, totalUmbrellas, orphansDeleted }) => {
      console.log(
        `\nDone. Updated ${umbrellasUpdated} / ${totalUmbrellas} umbrellas, deleted ${orphansDeleted} orphan(s).`,
      );
      process.exit(0);
    })
    .catch((err) => {
      console.error(`refresh failed: ${err.message}`);
      process.exit(1);
    });
}

module.exports = { refreshUmbrellaDefaults };
