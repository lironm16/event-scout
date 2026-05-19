// Bridge between the buffer flush and the semantic matcher.
//
// The scheduler calls `annotateSemanticMatches(events, profile)`
// right after `filterAtFlush` and before handing off to the
// renderer. We mutate `event._semanticMatch` in place for any event
// that:
//   1. has no strict tag intersection with profile.interests, AND
//   2. has at least one novel non-suppressed label, AND
//   3. passes the Gemini "fits this profile" check.
//
// Suppressed labels (user clicked "📭 לא רלוונטי" on a previous
// card) are excluded from being SURFACED as the novel label, but
// don't drop the event itself — the user already passed all the
// hard filters upstream and we honour the "don't stop sending"
// policy. The only time suppression has bite is filtering which
// label appears in the "🆕 חדש בקטלוג: …" subtitle.

const labelStore = require("./labelStore");
const { evaluateSemanticFits } = require("./semanticEventMatcher");

// Normalize a string list of label names → Set<number> of label ids.
// Unknown names (typo / freshly-deleted from dictionary) are dropped
// silently — they can't match a tag_id anyway.
async function resolveLabelNamesToIds(names) {
  const out = new Set();
  if (!Array.isArray(names) || !names.length) return out;
  for (const name of names) {
    if (typeof name !== "string" || !name.trim()) continue;
    try {
      const id = await labelStore.getOrCreateLabel(name);
      if (id != null) out.add(id);
    } catch (err) {
      // Soft-fail per name. Resolution failures shouldn't abort the
      // annotator — worst case is we miss a strict match and the
      // event takes the semantic path anyway (or appears plain).
      console.warn(`[SemanticAnnotator] resolve "${name}" failed: ${err.message}`);
    }
  }
  return out;
}

// Pick which novel label to surface in the "🆕 חדש בקטלוג: <name>"
// subtitle. Strategy: the most-recently-created label among the
// novel set — that's the one most likely to be a NEW category the
// user actually hasn't seen yet. If created_at is missing on every
// row (e.g. fresh deploy before sql/051 ran), fall back to the
// lowest-id (oldest by insertion order).
async function pickSurfaceLabel(novelIds) {
  if (!novelIds.length) return null;
  const dict = await labelStore.fetchLabelDict(novelIds);
  // fetchLabelDict only returns {id → {name}}; created_at lives on
  // the labels table but isn't exposed by that helper. Query
  // directly to grab the freshness signal in one shot.
  const supabase = require("./supabase");
  const { data, error } = await supabase
    .from("labels")
    .select("id, name, created_at")
    .in("id", novelIds);
  if (error || !data?.length) {
    // Fallback: lowest id (treat as oldest by insertion order).
    const fallbackId = [...novelIds].sort((a, b) => a - b)[0];
    const row = dict.get(fallbackId);
    return row ? { label_id: fallbackId, label_name: row.name } : null;
  }
  data.sort((a, b) => {
    const ad = a.created_at ? new Date(a.created_at).getTime() : 0;
    const bd = b.created_at ? new Date(b.created_at).getTime() : 0;
    if (bd !== ad) return bd - ad;
    return a.id - b.id;
  });
  const top = data[0];
  return { label_id: top.id, label_name: top.name };
}

// Main entry. Mutates each matched event with `_semanticMatch`.
// Returns the same array for convenience (callers can chain).
async function annotateSemanticMatches(events, profile) {
  if (!Array.isArray(events) || !events.length) return events;
  const ctx = profile?.user_context || {};
  const interestNames = Array.isArray(ctx.interests) ? ctx.interests : [];
  const suppressedNames = Array.isArray(ctx.suppressed_labels)
    ? ctx.suppressed_labels
    : [];

  const interestIds = await resolveLabelNamesToIds(interestNames);
  const suppressedIds = await resolveLabelNamesToIds(suppressedNames);

  // Pre-filter to events that need Gemini judgement:
  //   - have tag_ids
  //   - no overlap with interests
  //   - have at least one novel non-suppressed label
  const candidates = [];
  const candidateNovelIds = new Map(); // event_id → [novel ids]
  for (const event of events) {
    const tagIds = Array.isArray(event.tag_ids) ? event.tag_ids : [];
    if (!tagIds.length) continue;
    const hasStrictMatch = tagIds.some((id) => interestIds.has(id));
    if (hasStrictMatch) continue;
    const novel = tagIds.filter(
      (id) => !interestIds.has(id) && !suppressedIds.has(id),
    );
    if (!novel.length) continue;
    candidates.push(event);
    candidateNovelIds.set(event.id, novel);
  }
  if (!candidates.length) return events;

  let fits;
  try {
    fits = await evaluateSemanticFits(profile, candidates);
  } catch (err) {
    console.warn(`[SemanticAnnotator] Gemini eval failed: ${err.message}`);
    return events;
  }
  if (!fits || !fits.size) return events;

  // Pick a single surface-label per matched event and attach. Done
  // sequentially because pickSurfaceLabel hits supabase per call;
  // candidate sets are typically tiny (< 10) so a flat loop is fine.
  for (const event of candidates) {
    if (!fits.has(event.id)) continue;
    const novel = candidateNovelIds.get(event.id);
    if (!novel?.length) continue;
    try {
      const surface = await pickSurfaceLabel(novel);
      if (surface) event._semanticMatch = surface;
    } catch (err) {
      console.warn(
        `[SemanticAnnotator] pickSurfaceLabel for event ${event.id} failed: ${err.message}`,
      );
    }
  }
  return events;
}

module.exports = {
  annotateSemanticMatches,
  // exported for unit tests
  resolveLabelNamesToIds,
  pickSurfaceLabel,
};
