#!/usr/bin/env node
// One-off backfill: stamp the "צעירים" (young-adults / 18-35) tag onto
// events that the city CMS or Smarticket editor clearly targeted at
// young adults BUT didn't propagate to our `tag_ids` (most often
// because they pre-date the `extractAudienceSubtypeTags` path or
// were imported from Smarticket whose audience hints live in
// min_months/max_months, not in an audienceType array).
//
// Why a NEW backfill instead of widening the regex/heuristics in the
// live scraper: most adult events in our DB default to
// min_months=216 (18y) without actually being young-targeted —
// they're senior lectures, generic community programming, "for any
// adult". Reading min_months alone would tag ~200 senior lectures
// as young. The signal that's actually reliable is an EXPLICIT max
// age in the young/early-mid bracket: an editor who set
// max_months <= 540 (~45y) made a deliberate choice to cap the
// upper bound, which only happens for events meaningfully targeted
// at the 18-35/40 cohort. Without an explicit upper bound, we
// stay silent.
//
// Selection (conservative):
//   - audience='מבוגרים' AND
//   - min_months IS NOT NULL AND min_months >= 216 (adult start) AND
//   - min_months <  420 (under 35 — so a 35+ event like the
//                        white party (#22323 / min=420) stays
//                        OUT) AND
//   - max_months IS NOT NULL AND max_months >= 216 AND
//                        max_months <= 540 (explicit cap in
//                        young / early-mid range, ≤ 45) AND
//   - tag_ids does NOT already include the 'צעירים' label
//
// Idempotent: re-running prints "0 events to tag" once the world is
// consistent. Re-runnable at any time — when new events land that
// match the rule (e.g. the next Smarticket import of a young-adult
// workshop), the next backfill pass picks them up.
//
// What this DOES NOT do:
//   - Tag events whose `audience` is NULL or family/kids/teens —
//     the cohort is defined within the adults audience.
//   - Tag events with min_months=420 exactly — that's the 35+ floor
//     and we explicitly exclude it (the user said "white party
//     stays as 35+, not young").
//   - Touch events that ALREADY carry the tag (kept idempotent).

require("dotenv").config();
const supabase = require("../lib/supabase");

async function resolveYoungLabelId() {
  const { data, error } = await supabase
    .from("labels")
    .select("id, name")
    .eq("name", "צעירים")
    .maybeSingle();
  if (error) {
    console.error("[Backfill] label lookup failed:", error.message);
    return null;
  }
  return data?.id || null;
}

async function main() {
  const youngId = await resolveYoungLabelId();
  if (!youngId) {
    console.error("[Backfill] no 'צעירים' label found in DB; aborting.");
    process.exit(1);
  }
  console.log(`[Backfill] resolved 'צעירים' label id = ${youngId}`);

  // Single SQL window covering the conservative rule. Volume is tiny
  // (single digits expected at steady state), so we read the rows,
  // do the contains-check in JS, and emit per-row UPDATEs — easier
  // to log and safer than a bulk SQL operation that hides which
  // rows changed.
  const { data: rows, error } = await supabase
    .from("events")
    .select("id, name, audience, min_months, max_months, tag_ids")
    .eq("audience", "מבוגרים")
    .eq("archived", false)
    .gte("min_months", 216)
    .lt("min_months", 420)
    .gte("max_months", 216)
    .lte("max_months", 540);
  if (error) {
    console.error("[Backfill] fetch failed:", error.message);
    process.exit(1);
  }

  const toUpdate = [];
  for (const r of rows || []) {
    const existing = Array.isArray(r.tag_ids) ? r.tag_ids : [];
    if (existing.includes(youngId)) continue;
    toUpdate.push({
      id: r.id,
      name: r.name,
      newTagIds: [...existing, youngId],
      min_months: r.min_months,
      max_months: r.max_months,
    });
  }
  console.log(`[Backfill] ${toUpdate.length} events to tag.`);
  if (!toUpdate.length) return;

  let ok = 0,
    err = 0;
  for (const u of toUpdate) {
    const { error: upErr } = await supabase
      .from("events")
      .update({ tag_ids: u.newTagIds })
      .eq("id", u.id);
    if (upErr) {
      console.error(`[Backfill] #${u.id} failed: ${upErr.message}`);
      err++;
      continue;
    }
    console.log(
      `[Backfill] #${u.id} (min ${u.min_months}, max ${u.max_months}) "${(u.name || "").slice(0, 55)}" → +צעירים`,
    );
    ok++;
  }
  console.log(`[Backfill] done. ok=${ok} err=${err}`);
}

main().catch((e) => {
  console.error("[Backfill] fatal:", e);
  process.exit(1);
});
