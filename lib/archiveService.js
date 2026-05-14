const supabase = require("./supabase");
const { todayISO, ADMIN_NAME_PATTERNS } = require("./timeContext");

/**
 * Mark every event whose date is strictly before today as archived.
 * Idempotent — safe to run on every bot boot and after every scrape.
 */
async function archivePastEvents() {
  const today = todayISO();
  const { data, error } = await supabase
    .from("events")
    .update({ archived: true })
    .lt("date", today)
    .eq("archived", false)
    .select("id");

  if (error) {
    console.error("[Archive] Failed to archive past events:", error.message);
    return { archived: 0 };
  }

  const count = data?.length || 0;
  if (count > 0) {
    console.log(`[Archive] Archived ${count} past event(s) (date < ${today})`);
  }
  return { archived: count };
}

/**
 * Permanently delete administrative / non-event records that occasionally
 * leak into the Smarticket feed (e.g. "השלמת תשלום לפעילויות רמתגנציק").
 * Idempotent — only deletes rows whose name matches the admin patterns.
 */
async function deleteAdminEntries() {
  let deleted = 0;
  for (const pattern of ADMIN_NAME_PATTERNS) {
    const ilike = `%${pattern.source.replace(/[%_]/g, "")}%`;
    const { data, error } = await supabase
      .from("events")
      .delete()
      .ilike("name", ilike)
      .select("id, name");

    if (error) {
      console.error("[Archive] Admin entry deletion failed:", error.message);
      continue;
    }
    if (data?.length) {
      for (const row of data) {
        console.log(`[Archive] Deleted admin entry: ${row.name} (id=${row.id})`);
      }
      deleted += data.length;
    }
  }
  return { deleted };
}

/**
 * Run the full cleanup pass: delete admin junk + archive past events.
 * Called on bot startup and after every scrape.
 */
async function runCleanup() {
  const [{ deleted }, { archived }] = await Promise.all([
    deleteAdminEntries(),
    archivePastEvents(),
  ]);
  return { deleted, archived };
}

module.exports = {
  archivePastEvents,
  deleteAdminEntries,
  runCleanup,
};
