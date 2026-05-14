// Merge two TAG rows. Every event referencing the source id is
// rewritten to reference the destination id, duplicates within
// `tag_ids[]` are deduped, and the orphaned source row is deleted.
//
// Use when the LLM emits two near-synonymous tags ("התפתחות" /
// "התפתחותי", "משחקייה" / "משחקיה") that should be canonicalised.
//
// Usage:
//   node jobs/mergeLabels.js <from_id> <to_id> [--dry-run]
//
// History:
//   sql/032 turned the `labels` table into a tags-only dictionary
//   (audience and category became native ENUMs on `events`). This
//   script used to also rewrite events.audience_id / events.category_id
//   when the merged label was an audience or category — those branches
//   are gone because the columns no longer exist.
//
// Read-only sanity-check first (no writes) when --dry-run is passed.
require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

function parseArgs() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const positional = args.filter((a) => !a.startsWith("--"));
  if (positional.length !== 2) {
    console.error("Usage: node jobs/mergeLabels.js <from_id> <to_id> [--dry-run]");
    process.exit(2);
  }
  const [from, to] = positional.map((s) => parseInt(s, 10));
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) {
    console.error("from_id and to_id must be distinct integers.");
    process.exit(2);
  }
  return { from, to, dryRun };
}

async function loadLabel(id) {
  const { data, error } = await supabase
    .from("labels")
    .select("id, name")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`labels lookup failed: ${error.message}`);
  return data;
}

async function findReferencers(id) {
  // tag_ids[] is the only column referencing labels after sql/032.
  const tags = await supabase
    .from("events")
    .select("id, name, tag_ids")
    .contains("tag_ids", [id]);
  if (tags.error) throw new Error(`tag_ids scan failed: ${tags.error.message}`);
  return { tags: tags.data || [] };
}

async function rewriteTagIds(rows, from, to) {
  // Per-event replace + dedupe. We could do this in a single SQL with
  // array_replace + array_agg(DISTINCT), but Supabase JS doesn't
  // expose raw SQL — read each row, transform in memory, write back.
  for (const r of rows) {
    const next = [];
    const seen = new Set();
    for (const id of r.tag_ids || []) {
      const replaced = id === from ? to : id;
      if (!seen.has(replaced)) {
        seen.add(replaced);
        next.push(replaced);
      }
    }
    const { error } = await supabase
      .from("events")
      .update({ tag_ids: next })
      .eq("id", r.id);
    if (error) throw new Error(`update events.tag_ids #${r.id} failed: ${error.message}`);
  }
}

async function deleteLabel(id) {
  const { error } = await supabase.from("labels").delete().eq("id", id);
  if (error) throw new Error(`delete labels #${id} failed: ${error.message}`);
}

async function main() {
  const { from, to, dryRun } = parseArgs();

  const [src, dst] = await Promise.all([loadLabel(from), loadLabel(to)]);
  if (!src) throw new Error(`Source label #${from} not found.`);
  if (!dst) throw new Error(`Destination label #${to} not found.`);

  console.log(`Merging  #${src.id} "${src.name}"  →  #${dst.id} "${dst.name}"`);

  const refs = await findReferencers(from);
  console.log(`References to #${from}:`);
  console.log(`  tag_ids: ${refs.tags.length} event(s)`);

  if (dryRun) {
    console.log("\n--dry-run: no changes written.");
    return;
  }

  if (refs.tags.length) {
    console.log(`Rewriting tag_ids on ${refs.tags.length} event(s)...`);
    await rewriteTagIds(refs.tags, from, to);
  }

  await deleteLabel(from);
  console.log(`Deleted labels #${from}. Done.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[MergeLabels] Fatal:", err.message);
    process.exit(1);
  });
