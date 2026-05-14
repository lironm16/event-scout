// Detect overlap between saved searches.
//
// Why:
//
// A user can easily end up with two near-duplicate watchers — typically
// one broad ("all events at גאולים") and one narrow ("kids events at
// גאולים"). The broad one already catches everything the narrow one
// would; keeping both means double notifications, wasted matching work,
// and a confusing "my searches" list. This module gives us a single
// pure-function answer ("are these two related, and which is broader?")
// that the bot's save flow + the per-cycle notifier can both consume.
//
// Subsumption is one-directional. We say "A subsumes B" when every event
// that would match B would ALSO match A — i.e. A's filters are at least
// as loose as B's on every dimension. Bidirectional subsumption =
// effectively identical (the only differences are wording-only). The
// fallback "overlap" bucket catches looser similarities (shared tokens
// or tags without strict subsumption) so the bot can still warn the
// user even when the relationship isn't a clean superset/subset.

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

const lower = (s) => String(s ?? "").toLowerCase().trim();

function tokensSet(snapshot) {
  return new Set(
    (snapshot?.tokens || []).map(lower).filter(Boolean),
  );
}

function tagsSet(snapshot) {
  return new Set(
    (snapshot?.filters?.watch_tag_names || []).map(lower).filter(Boolean),
  );
}

// Filters whose `null` / unset value means "no constraint" — A having
// it unset makes A more permissive on that axis.
function getF(snapshot, key) {
  const v = snapshot?.filters?.[key];
  if (v == null || v === "" || v === "any") return null;
  return v;
}

// ────────────────────────────────────────────────────────────────────
// Subsumption: does A "cover" B on every dimension?
// ────────────────────────────────────────────────────────────────────
//
// For each filter we encode "A is at least as loose as B":
//
//   tokens (AND-match on title)
//     A.tokens ⊆ B.tokens   — A demands fewer keywords, so A matches
//     ⇒ A looser              every event B matches plus more.
//
//   watch_tag_names (OR-match on event.tags)
//     A.tags ⊇ B.tags       — A allows MORE tag values to trigger,
//     ⇒ A looser              so every event matching any of B's tags
//                             also matches one of A's.
//
//   location_key, audience, format, proximity (equality)
//     A.unset OR A === B    — A unset = no venue/audience filter at
//     ⇒ A looser              all → matches anything; if A is set, it
//                             must match exactly for subsumption.
//
//   date_from, time_after  (lower bounds, "events at or after X")
//     A.unset OR A ≤ B       — A allowing earlier events than B.
//
//   date_to, time_before  (upper bounds)
//     A.unset OR A ≥ B       — A allowing later events than B.

function aSubsumesB(a, b) {
  // Tokens
  const aTok = tokensSet(a);
  const bTok = tokensSet(b);
  for (const t of aTok) {
    if (!bTok.has(t)) return false;
  }

  // Tag watchers
  const aTags = tagsSet(a);
  const bTags = tagsSet(b);
  if (bTags.size > 0) {
    for (const t of bTags) {
      if (!aTags.has(t)) return false;
    }
  } else if (aTags.size > 0) {
    // B has no tag watcher, A has one. A is then narrower on this axis
    // (A's matches require an event tag, B's accept anything). A can't
    // subsume B unless B has a SELECTIVE non-tag filter pinning down
    // the same scope — we don't try to reason about that here, just
    // bail: B is broader on this axis.
    return false;
  }

  // Equality filters
  for (const key of ["location_key", "audience", "format", "proximity"]) {
    const av = getF(a, key);
    const bv = getF(b, key);
    if (av == null) continue; // A unset → looser on this axis
    if (av !== bv) return false; // A set & differs → A is narrower / disjoint
  }

  // Lower-bound filters
  for (const key of ["date_from", "time_after"]) {
    const av = getF(a, key);
    if (av == null) continue;
    const bv = getF(b, key);
    if (bv == null) return false; // A constrained, B not → A is narrower
    if (av > bv) return false; // A starts later than B → A misses early events B catches
  }

  // Upper-bound filters
  for (const key of ["date_to", "time_before"]) {
    const av = getF(a, key);
    if (av == null) continue;
    const bv = getF(b, key);
    if (bv == null) return false;
    if (av < bv) return false; // A ends earlier → misses late events B catches
  }

  return true;
}

// ────────────────────────────────────────────────────────────────────
// Relationship classification.
// ────────────────────────────────────────────────────────────────────

const REL = {
  IDENTICAL: "identical",
  A_SUBSUMES_B: "a_subsumes_b", // A is broader, B is narrower
  B_SUBSUMES_A: "b_subsumes_a", // B is broader, A is narrower
  OVERLAP: "overlap",            // some signal in common, no clean subsumption
  DISTINCT: "distinct",
};

function relationship(a, b) {
  const aSub = aSubsumesB(a, b);
  const bSub = aSubsumesB(b, a);
  if (aSub && bSub) return REL.IDENTICAL;
  if (aSub) return REL.A_SUBSUMES_B;
  if (bSub) return REL.B_SUBSUMES_A;

  // Soft overlap fallback: any of these signals = "tell the user".
  // This catches cases like the same venue being watched once for
  // "מוזיקה" and once for "ל״ג בעומר" — neither subsumes the other but
  // they'll inevitably double-fire on a "מוזיקה ל״ג בעומר" event.
  const aTok = tokensSet(a);
  const bTok = tokensSet(b);
  const aTags = tagsSet(a);
  const bTags = tagsSet(b);

  const tokenOverlap =
    aTok.size > 0 && bTok.size > 0 && [...aTok].some((t) => bTok.has(t));
  const tagOverlap =
    aTags.size > 0 && bTags.size > 0 && [...aTags].some((t) => bTags.has(t));
  const sameVenue =
    getF(a, "location_key") &&
    getF(a, "location_key") === getF(b, "location_key");
  const sameAudience =
    getF(a, "audience") && getF(a, "audience") === getF(b, "audience");

  if (tokenOverlap || tagOverlap || (sameVenue && sameAudience)) {
    return REL.OVERLAP;
  }
  return REL.DISTINCT;
}

/**
 * Find every existing saved search that overlaps with `snapshot`.
 *
 * Returns a sorted array (most relevant first) of:
 *   {
 *     existing:     <full saved-search row>,
 *     relationship: REL.* enum value,
 *     // For UX: which is broader, if applicable.
 *     existing_is_broader: boolean,
 *     snapshot_is_broader: boolean,
 *   }
 *
 * Sort order: identical first (most actionable), then a_subsumes_b
 * (existing is broader → the new one is redundant), then b_subsumes_a
 * (new one would replace the existing), then plain overlap.
 */
function findOverlapsIn(snapshot, existingList) {
  const out = [];
  for (const ex of existingList || []) {
    if (ex?.archived) continue;
    const rel = relationship(snapshot, ex);
    if (rel === REL.DISTINCT) continue;
    // `relationship(snapshot, ex)` returns "a_subsumes_b" when SNAPSHOT
    // subsumes EX (a=snapshot, b=ex). So:
    //   A_SUBSUMES_B → snapshot is broader; ex is the narrow one being
    //                  superseded by what the user is about to save.
    //   B_SUBSUMES_A → ex is broader; the new snapshot is redundant
    //                  because ex would already catch its events.
    out.push({
      existing: ex,
      relationship: rel,
      existing_is_broader: rel === REL.B_SUBSUMES_A,
      snapshot_is_broader: rel === REL.A_SUBSUMES_B,
    });
  }
  const order = {
    [REL.IDENTICAL]: 0,
    [REL.A_SUBSUMES_B]: 1,
    [REL.B_SUBSUMES_A]: 2,
    [REL.OVERLAP]: 3,
  };
  out.sort((x, y) => order[x.relationship] - order[y.relationship]);
  return out;
}

module.exports = {
  aSubsumesB,
  relationship,
  findOverlapsIn,
  REL,
};
