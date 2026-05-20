// Backfill: remove audience-subtype tags ("צעירים", "גיל הזהב") from
// family / kids / babies / teens events where they were incorrectly added.
//
// Root cause: extractAudienceSubtypeTags (lib/cityApi.js) was emitting
// "צעירים" whenever the CMS audienceType[] array contained "צעירים"
// with fewer than 4 distinct age buckets — even if the primary audience
// resolved to 'ילדים' or 'לכל המשפחה'. This resulted in children's
// theater shows (e.g. "גינה פעילה" events) carrying a "צעירים" tag.
//
// The upstream bug is fixed. This script removes the tag retroactively
// from existing rows.
//
// Scope: rg-muni events only (Smarticket events don't use
// extractAudienceSubtypeTags). Audience values that should NOT carry
// subtype tags: ילדים, לכל המשפחה, תינוקות, בני נוער.
//
// Usage:
//   node jobs/backfillRemoveSubtypeTagsFromFamilyEvents.js
//
// Idempotent: safe to re-run.

require("dotenv").config({
  path: require("path").resolve(__dirname, "..", ".env"),
});

const supabase = require("../lib/supabase");

const NON_ADULT_AUDIENCES = ["ילדים", "לכל המשפחה", "תינוקות", "נוער"];
const SUBTYPE_TAG_NAMES = ["צעירים", "גיל הזהב"];

async function resolveTagIds(names) {
  const { data, error } = await supabase
    .from("labels")
    .select("id, name")
    .in("name", names);
  if (error) throw new Error(`Label lookup failed: ${error.message}`);
  return (data || []).map((r) => ({ id: r.id, name: r.name }));
}

async function main() {
  console.log("[BackfillSubtypeTags] Resolving subtype label IDs...");
  const subtypeTags = await resolveTagIds(SUBTYPE_TAG_NAMES);
  if (!subtypeTags.length) {
    console.log("[BackfillSubtypeTags] No subtype labels found in DB. Nothing to do.");
    return;
  }
  const subtypeIds = subtypeTags.map((t) => t.id);
  console.log(
    `[BackfillSubtypeTags] Subtype tag IDs: ${subtypeTags.map((t) => `${t.id}="${t.name}"`).join(", ")}`,
  );

  console.log("[BackfillSubtypeTags] Fetching rg-muni family/kids events with subtype tags...");
  const { data: rows, error } = await supabase
    .from("events")
    .select("id, name, audience, tag_ids")
    .eq("source", "rg-muni")
    .eq("archived", false)
    .in("audience", NON_ADULT_AUDIENCES)
    .overlaps("tag_ids", subtypeIds);

  if (error) throw new Error(`Fetch failed: ${error.message}`);
  console.log(`[BackfillSubtypeTags] ${(rows || []).length} event(s) to fix.`);
  if (!rows?.length) {
    console.log("[BackfillSubtypeTags] Nothing to do. ✓");
    return;
  }

  let updated = 0;
  let errors = 0;

  for (const row of rows) {
    const cleaned = (row.tag_ids || []).filter((id) => !subtypeIds.includes(id));
    const removed = (row.tag_ids || []).filter((id) => subtypeIds.includes(id));
    const removedNames = removed.map((id) => subtypeTags.find((t) => t.id === id)?.name || id);

    const { error: upErr } = await supabase
      .from("events")
      .update({ tag_ids: cleaned })
      .eq("id", row.id);

    if (upErr) {
      errors++;
      console.error(`  ✗ #${row.id} "${row.name}": ${upErr.message}`);
    } else {
      updated++;
      console.log(
        `  ✓ #${row.id} "${(row.name || "").slice(0, 50)}" (${row.audience}) — removed: ${removedNames.join(", ")}`,
      );
    }
  }

  console.log("\n[BackfillSubtypeTags] Summary:");
  console.log(`  fixed:   ${updated}`);
  console.log(`  errors:  ${errors}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[BackfillSubtypeTags] Fatal:", err.message);
    process.exit(1);
  });
