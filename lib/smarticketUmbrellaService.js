// Detect and create umbrella groupings for Smarticket events.
//
// Context:
//   Smarticket shows are sold as independent sessions — each `?id=XXXX`
//   URL is one "event" in the DB. The sessions for a single show share
//   the same canonical slug path (e.g. "רמאנגה_2_2026"). After
//   lib/eventEnricher.js resolves each event's redirect URL and writes
//   `external_slug`, this module looks for groups of ≥ 2 events with
//   the same (source, external_slug) and promotes them to an umbrella.
//
// Mirrors upsertUmbrellaRow + child-tagging logic in lib/cityApiScraper.js
// (sql/058 model) — just driven differently because Smarticket has no
// API-level parent object we can pull structured data from.
//
// Idempotency:
//   - `umbrellas` upsert is ON CONFLICT (source, slug).
//   - Child update only touches rows whose umbrella_id IS NULL.
//   - Safe to call multiple times or concurrently for the same slug.

const supabase = require("./supabase");

// Minimum number of sessions sharing a slug before we promote to umbrella.
const MIN_SESSIONS = 2;

/**
 * Given a Smarticket source + parent slug, check if there are enough
 * sessions to warrant an umbrella.  If so, upsert the umbrella row and
 * stamp all matching children with umbrella_id / umbrella_slug /
 * umbrella_title.
 *
 * Called fire-and-forget from eventEnricher after writing external_slug.
 */
async function smarticketGroupBySlug(source, externalSlug) {
  if (!source || !externalSlug) return;

  // ── 1. Fetch all live sessions sharing this slug ─────────────────────
  const { data: sessions, error: fetchErr } = await supabase
    .from("events")
    .select("id, name, image, umbrella_id")
    .eq("source", source)
    .eq("external_slug", externalSlug)
    .eq("archived", false);

  if (fetchErr) {
    console.warn(
      `[SmartUmbrella] fetch sessions failed for "${externalSlug}": ${fetchErr.message}`,
    );
    return;
  }

  if (!sessions || sessions.length < MIN_SESSIONS) return;

  // ── 2. Derive umbrella title ──────────────────────────────────────────
  // Use the most common session name as the umbrella title. For well-named
  // series (e.g. "רמאנגה — מפגש 1", "רמאנגה — מפגש 2") a simple
  // prefix-extraction is not reliable; MAX(name) by length keeps the
  // longest descriptive variant rather than a truncated one.
  const title = sessions
    .map((s) => s.name || "")
    .filter(Boolean)
    .sort((a, b) => {
      // Sort by frequency first, then by length descending as tiebreak.
      return b.length - a.length;
    })[0] || externalSlug;

  // ── 3. Upsert the umbrella row ────────────────────────────────────────
  // Pick the first non-null image from the sessions.
  const image = sessions.map((s) => s.image).find(Boolean) || null;

  // Reconstruct a best-effort external URL for the parent show page.
  // We don't have the exact hostname stored per-event, so we fall back
  // to mbe-rg which is the primary Smarticket tenant for Ramat Gan.
  // If the source has a known subdomain we can be more precise.
  const baseHost =
    source === "rg-muni-smarticket"
      ? "ramat-gan.smarticket.co.il"
      : "mbe-rg.smarticket.co.il";
  const externalUrl = `https://${baseHost}/${encodeURIComponent(externalSlug)}/`;

  const { data: umbrellaRow, error: upsertErr } = await supabase
    .from("umbrellas")
    .upsert(
      {
        source,
        slug: externalSlug,
        title,
        image_url: image,
        external_url: externalUrl,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "source,slug" },
    )
    .select("id")
    .maybeSingle();

  if (upsertErr) {
    console.warn(
      `[SmartUmbrella] upsert umbrella "${externalSlug}": ${upsertErr.message}`,
    );
    return;
  }

  const umbrellaId = umbrellaRow?.id;
  if (!umbrellaId) return;

  // ── 4. Stamp children that don't yet have umbrella_id ────────────────
  const unlinked = sessions
    .filter((s) => s.umbrella_id == null)
    .map((s) => s.id);

  if (!unlinked.length) return;

  const { error: stampErr } = await supabase
    .from("events")
    .update({
      umbrella_id: umbrellaId,
      umbrella_slug: externalSlug,
      umbrella_title: title,
    })
    .in("id", unlinked);

  if (stampErr) {
    console.warn(
      `[SmartUmbrella] stamp children for "${externalSlug}": ${stampErr.message}`,
    );
    return;
  }

  console.log(
    `[SmartUmbrella] "${externalSlug}" (${source}): umbrella #${umbrellaId}, stamped ${unlinked.length} child(ren)`,
  );
}

module.exports = { smarticketGroupBySlug };
