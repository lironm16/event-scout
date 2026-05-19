const supabase = require("./supabase");

async function addWatcher(telegramId, eventId, { ticketsNeeded } = {}) {
  const row = {
    event_id: parseInt(eventId, 10),
    telegram_id: String(telegramId),
  };
  if (ticketsNeeded != null) row.tickets_needed = ticketsNeeded;

  const { error } = await supabase
    .from("event_watchers")
    .upsert(row, { onConflict: "event_id,telegram_id" });

  if (error) throw new Error(`Add watcher failed: ${error.message}`);
}

async function setTicketsNeeded(telegramId, eventId, ticketsNeeded) {
  const { error } = await supabase
    .from("event_watchers")
    .update({ tickets_needed: ticketsNeeded })
    .eq("telegram_id", String(telegramId))
    .eq("event_id", parseInt(eventId, 10));

  if (error) throw new Error(`Set tickets_needed failed: ${error.message}`);
}

/**
 * Decrement `tickets_needed` by `by`. Returns the new remaining count, or
 * null if the watcher row didn't exist (or didn't have a quantity set).
 *
 * When the count reaches 0 the row is removed, since the user has nothing
 * left to wait for.
 */
async function decrementTicketsNeeded(telegramId, eventId, by) {
  const tg = String(telegramId);
  const ev = parseInt(eventId, 10);

  const { data: current, error: readErr } = await supabase
    .from("event_watchers")
    .select("tickets_needed")
    .eq("telegram_id", tg)
    .eq("event_id", ev)
    .maybeSingle();
  if (readErr) throw new Error(`Decrement read failed: ${readErr.message}`);
  if (!current) return null;
  if (current.tickets_needed == null) return null;

  const remaining = Math.max(current.tickets_needed - by, 0);

  if (remaining === 0) {
    await supabase
      .from("event_watchers")
      .delete()
      .eq("telegram_id", tg)
      .eq("event_id", ev);
    return 0;
  }

  const { error: writeErr } = await supabase
    .from("event_watchers")
    .update({ tickets_needed: remaining })
    .eq("telegram_id", tg)
    .eq("event_id", ev);
  if (writeErr) throw new Error(`Decrement write failed: ${writeErr.message}`);

  return remaining;
}

async function getWatcher(telegramId, eventId) {
  const { data } = await supabase
    .from("event_watchers")
    .select("event_id, tickets_needed, created_at")
    .eq("telegram_id", String(telegramId))
    .eq("event_id", parseInt(eventId, 10))
    .maybeSingle();
  return data || null;
}

async function removeWatcher(telegramId, eventId) {
  const { error } = await supabase
    .from("event_watchers")
    .delete()
    .eq("telegram_id", String(telegramId))
    .eq("event_id", parseInt(eventId, 10));

  if (error) throw new Error(`Remove watcher failed: ${error.message}`);
}

async function isWatching(telegramId, eventId) {
  const { data } = await supabase
    .from("event_watchers")
    .select("event_id")
    .eq("telegram_id", String(telegramId))
    .eq("event_id", parseInt(eventId, 10))
    .maybeSingle();
  return !!data;
}

/**
 * Returns hydrated event objects the user is watching.
 *
 * The venue text + coords come from the `locations` table via a nested JOIN.
 * Output shape mirrors `matchingService.flattenEvent` so downstream renderers
 * can keep treating `location` as a plain string and `_coords` as the
 * pre-resolved lat/lng.
 */
async function getWatchedEvents(telegramId) {
  const { data, error } = await supabase
    .from("event_watchers")
    .select(
      "event_id, created_at, tickets_needed, events!inner(id, name, date, start_time, end_time, image, tickets_left, location_key, locations:location_key(raw_address, lat, lng, found))"
    )
    .eq("telegram_id", String(telegramId))
    .eq("events.archived", false)
    .order("created_at", { ascending: false });

  if (error) throw new Error(`Watched events fetch failed: ${error.message}`);
  return (data || []).map((w) => {
    const ev = w.events || {};
    const loc = ev.locations || null;
    const coords =
      loc && loc.lat != null && loc.lng != null
        ? { lat: loc.lat, lng: loc.lng }
        : null;
    return {
      id: ev.id,
      name: ev.name,
      date: ev.date,
      start_time: ev.start_time,
      end_time: ev.end_time,
      image: ev.image,
      tickets_left: ev.tickets_left,
      location_key: ev.location_key,
      location: loc?.raw_address || null,
      _coords: coords,
      _locationFound: loc?.found ?? null,
      watched_at: w.created_at,
      tickets_needed: w.tickets_needed,
    };
  });
}

/**
 * For a given event_id, return all watchers (un-notified only), each with
 * their requested quantity context so the notifier can personalize.
 */
async function getWatchersForEvent(eventId) {
  const { data, error } = await supabase
    .from("event_watchers")
    .select("telegram_id, tickets_needed")
    .eq("event_id", parseInt(eventId, 10))
    .is("notified_at", null);

  if (error) throw new Error(`Watchers fetch failed: ${error.message}`);
  return data || [];
}

/**
 * Mark a watcher as notified (so we don't spam them on subsequent runs).
 */
async function markNotified(telegramId, eventId) {
  await supabase
    .from("event_watchers")
    .update({ notified_at: new Date().toISOString() })
    .eq("telegram_id", String(telegramId))
    .eq("event_id", parseInt(eventId, 10));
}

module.exports = {
  addWatcher,
  setTicketsNeeded,
  decrementTicketsNeeded,
  getWatcher,
  removeWatcher,
  isWatching,
  getWatchedEvents,
  getWatchersForEvent,
  markNotified,
};
