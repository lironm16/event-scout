const supabase = require("./supabase");
const { todayISO, ADMIN_NAME_PATTERNS } = require("./timeContext");

/**
 * For every event in `expiredEventIds` that has at least one watcher:
 *   1. Extract the event's interest signals (name, category, tag_ids).
 *   2. Prepend those signals to `profiles.user_context.past_watch_signals`
 *      (capped at 20 entries, oldest drop off) for each watcher's profile.
 *   3. Delete all `event_watchers` rows for those event ids.
 *
 * Called just before the events themselves are archived so the FK join
 * still resolves. Silent — errors are logged but never re-thrown so they
 * can't break the main archive cycle.
 */
async function extractAndCleanWatchers(expiredEventIds) {
  if (!expiredEventIds?.length) return;

  // Fetch watcher rows joined to their event's interest signals.
  const { data: rows, error: fetchErr } = await supabase
    .from("event_watchers")
    .select("telegram_id, events:event_id(id, name, category, tag_ids)")
    .in("event_id", expiredEventIds);

  if (fetchErr) {
    console.error("[Archive] watcher signal fetch failed:", fetchErr.message);
    return;
  }

  // Group new signals by telegram_id.
  const byUser = {};
  for (const row of rows || []) {
    const ev = row.events;
    if (!ev) continue;
    (byUser[row.telegram_id] ||= []).push({
      name: ev.name,
      category: ev.category || null,
      tag_ids: ev.tag_ids || [],
    });
  }

  // Merge into each user's profile.user_context.past_watch_signals (max 20).
  for (const [telegramId, newSignals] of Object.entries(byUser)) {
    try {
      const { data: profile } = await supabase
        .from("profiles")
        .select("user_context")
        .eq("telegram_id", telegramId)
        .maybeSingle();

      const ctx = profile?.user_context || {};
      const existing = Array.isArray(ctx.past_watch_signals)
        ? ctx.past_watch_signals
        : [];
      const merged = [...newSignals, ...existing].slice(0, 20);

      await supabase
        .from("profiles")
        .update({ user_context: { ...ctx, past_watch_signals: merged } })
        .eq("telegram_id", telegramId);
    } catch (err) {
      console.error(
        `[Archive] signal save failed for ${telegramId}:`,
        err.message,
      );
    }
  }

  // Delete the stale watcher rows.
  const { error: delErr } = await supabase
    .from("event_watchers")
    .delete()
    .in("event_id", expiredEventIds);

  if (delErr) {
    console.error("[Archive] watcher delete failed:", delErr.message);
  } else if (rows?.length) {
    console.log(
      `[Archive] Cleaned ${rows.length} watcher row(s) across ${Object.keys(byUser).length} user(s).`,
    );
  }
}

/**
 * Mark every event whose date is strictly before today as archived.
 * Idempotent — safe to run on every bot boot and after every scrape.
 *
 * Before archiving, calls extractAndCleanWatchers() so that:
 *   - interest signals are saved to the watcher's profile, and
 *   - stale event_watcher rows are deleted.
 * This must run while the FK join from event_watchers → events still
 * resolves (i.e. before the UPDATE, not after).
 */
async function archivePastEvents() {
  const today = todayISO();

  // Find IDs first so we can pass them to watcher cleanup before
  // updating the rows.
  const { data: toArchive, error: selectErr } = await supabase
    .from("events")
    .select("id")
    .lt("date", today)
    .eq("archived", false);

  if (selectErr) {
    console.error("[Archive] Failed to find past events:", selectErr.message);
    return { archived: 0 };
  }

  const ids = (toArchive || []).map((r) => r.id);
  if (!ids.length) return { archived: 0 };

  // Extract interest signals and clean up watchers before archiving.
  await extractAndCleanWatchers(ids).catch((err) =>
    console.error("[Archive] extractAndCleanWatchers threw:", err.message),
  );

  // Now archive.
  const { data, error } = await supabase
    .from("events")
    .update({ archived: true })
    .in("id", ids)
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
  extractAndCleanWatchers,
  runCleanup,
};
