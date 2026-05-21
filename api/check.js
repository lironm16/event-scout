require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });
const axios = require("axios");
const { Telegraf } = require("telegraf");
const { createClient } = require("@supabase/supabase-js");
const { isFutureOrToday, isAdminEntry, isServiceEntry, isTestEntry } = require("../lib/timeContext");
const { runCleanup } = require("../lib/archiveService");
const { ensureLocationKey, resolvePending } = require("../lib/locationResolver");
const { formatHebrewDate, formatTimeRange, rtlLine } = require("../lib/eventFormat");
const { normalizeImageUrl } = require("../lib/imageUrl");
const { TENANTS, getBookingUrl } = require("../lib/sourceUrls");
const { classifyAllAccessForEvent } = require("../lib/access");
const sentry = require("../lib/sentry");
// Idempotent — early-returns if already initialized by the parent
// process (the bot). Lets `npm run check` standalone also report.
sentry.init();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const bot = process.env.TELEGRAM_TOKEN
  ? new Telegraf(process.env.TELEGRAM_TOKEN)
  : null;

const LOOKAHEAD_DAYS = 45;

function buildDateRange() {
  const today = new Date();
  const end = new Date(today);
  end.setDate(end.getDate() + LOOKAHEAD_DAYS);
  return {
    start: today.toISOString().split("T")[0],
    end: end.toISOString().split("T")[0],
  };
}

// Pull events from a single tenant's calendar endpoint. Smarticket has
// historically returned `result` as either an array OR an object with
// numeric string keys (silently flipped mid-2026); we accept both and
// downgrade unrecognised shapes to "empty list with a warning" so an
// upstream schema flip doesn't take the whole pipeline down.
async function fetchTenantEvents(tenant, { start, end }) {
  const url = `${tenant.calendarUrl}?start=${start}&end=${end}`;
  const { data } = await axios.get(url, {
    headers: { "User-Agent": "EventScout/1.0", Accept: "application/json" },
    timeout: 20_000,
  });

  if (data?.success === false) {
    throw new Error(
      `Smarticket API error (${tenant.source}): ${data.description || "unknown"}`,
    );
  }

  let resultArr = null;
  if (Array.isArray(data?.result)) {
    resultArr = data.result;
  } else if (data?.result && typeof data.result === "object") {
    const values = Object.values(data.result);
    if (values.length && values.every((v) => v && typeof v === "object" && "id" in v)) {
      resultArr = values;
    }
  }

  if (!resultArr) {
    let detail;
    if (data && typeof data === "object") {
      detail = `keys=[${Object.keys(data).slice(0, 8).join(", ")}]`;
      if (data.result && typeof data.result === "object") {
        detail += ` resultKeys=[${Object.keys(data.result).slice(0, 4).join(", ")}]`;
      }
    } else if (typeof data === "string") {
      detail = `string ${data.length}b (head=${data.slice(0, 80).replace(/\s+/g, " ")})`;
    } else {
      detail = `type=${typeof data}`;
    }
    console.warn(
      `[Scrape] ${tenant.source}: unrecognised result shape — treating as empty. ${detail}`,
    );
    return [];
  }

  // Stamp the source onto every row right at the fetch boundary. This
  // is the ONLY place that knows which tenant produced which event;
  // every downstream consumer reads `e.source` instead of inferring.
  for (const e of resultArr) {
    e.source = tenant.source;
  }
  return resultArr;
}

// Multi-tenant fetch. Each tenant is queried in parallel; if one fails
// we keep going with whatever the others returned (one broken feed
// shouldn't blackout the bot for everyone).
//
// IMPORTANT: this function only handles SMARTICKET-shaped tenants —
// the ones with a `calendarUrl` returning numeric-id ticket events.
// Other tenant kinds (e.g. `kind: "city"` → rg-muni) have entirely
// different ingestion paths (lib/cityApiScraper.js for the city
// municipal API) and MUST be skipped here. Pre-filter on `kind`
// rather than guarding inside fetchTenantEvents — that way every
// `TENANTS[i]` index aligns with `settled[i]` without an off-by-one.
async function fetchEvents() {
  const range = buildDateRange();
  const smarticketTenants = TENANTS.filter((t) => t.kind === "smarticket");

  const settled = await Promise.allSettled(
    smarticketTenants.map((t) => fetchTenantEvents(t, range)),
  );

  const events = [];
  settled.forEach((r, i) => {
    const tenant = smarticketTenants[i];
    if (r.status === "fulfilled") {
      console.log(`[Scrape] ${tenant.source}: ${r.value.length} events`);
      events.push(...r.value);
    } else {
      console.error(`[Scrape] ${tenant.source}: fetch FAILED — ${r.reason?.message || r.reason}`);
      // Sentry alert: a Smarticket feed going down is silent
      // otherwise — the rest of the pipeline carries on, the user
      // just sees stale/missing events. Worth a page. The dedupe
      // by (code, source) means we get one alert per outage, not
      // one per cycle.
      // severity=error (was warning) — a feed going dark blacks out
      // a whole tenant's results for every user, not a per-user UX
      // glitch. Sentry will surface it under the "Errors" filter and
      // any "new issue" alert rule will page louder than a warning.
      sentry.captureAlert({
        severity: "error",
        code: "scrape_fetch_failed",
        message: `Smarticket fetch failed for ${tenant.source}`,
        error: r.reason instanceof Error ? r.reason : null,
        context: { source: tenant.source, kind: tenant.kind },
      });
    }
  });

  return events;
}

async function getStoredEvents(eventIds) {
  // Pull the venue text from the joined `locations` row instead of a
  // standalone `events.location` column. We also pull `source` so that
  // back-in-stock notifications can render against the right tenant
  // (image base / booking URL) without re-deriving from the upsert
  // payload — see api/check.js's image_url construction.
  const { data, error } = await supabase
    .from("events")
    .select(
      "id, source, tickets_left, location_key, image, locations:location_key(raw_address)"
    )
    .in("id", eventIds);

  if (error) throw new Error(`Supabase select failed: ${error.message}`);
  return new Map(
    data.map((e) => [
      e.id,
      {
        id: e.id,
        source: e.source,
        tickets_left: e.tickets_left,
        location_key: e.location_key,
        location: e.locations?.raw_address || null,
        image: e.image,
      },
    ])
  );
}

// Pick the best image path the calendar API gives us, as a RELATIVE
// path (no host). Storage is host-agnostic by design — `normalizeImageUrl`
// at read time joins the right tenant base for Telegram. Storing
// relative makes the field portable across tenant-host migrations and
// keeps the value as the canonical identifier rather than a fully
// hydrated URL.
//
// Source preference (best → fallback):
//   1. `image` — the full-resolution upload filename (e.g.
//      "upld6a0422b3adf61158455812.jpg"). Lives under `/uploads/`.
//      For event #22397 this file is ~1.5 MB, compared to ~3 KB for
//      `thumbnail_calendar` — a 500× quality difference that visibly
//      degrades every bot message rendering the event. Telegram's
//      sendPhoto accepts URLs up to ~10 MB, so the full upload is
//      safely in range.
//   2. `thumbnail_calendar` — the calendar-grid thumbnail under
//      `/uploads/thumbs/`. Tiny (~3 KB) and meant for the smarticket
//      calendar grid cell. Kept only as a fallback for the rare event
//      where `image` is missing — better something than nothing.
//
// Returns:
//   `"/uploads/..."` relative path on success.
//   `null`           when neither field is populated.
//
// `tenants` resolution is intentionally pushed to read time via
// `normalizeImageUrl(stored, event)` callers — see lib/imageUrl.js.
function pickImagePath(event) {
  const fullImage = typeof event?.image === "string" ? event.image.trim() : "";
  if (fullImage) {
    if (fullImage.startsWith("http://") || fullImage.startsWith("https://")) {
      // Already absolute — strip the host so storage stays relative.
      // Defensive: legacy upstream shapes occasionally inline the host.
      try {
        const u = new URL(fullImage);
        return u.pathname;
      } catch {
        // Malformed absolute URL; fall through to thumb fallback.
      }
    } else {
      return fullImage.startsWith("/") ? fullImage : `/uploads/${fullImage}`;
    }
  }
  const thumb = event?.thumbnail_calendar;
  if (!thumb) return null;
  if (thumb.startsWith("http://") || thumb.startsWith("https://")) {
    try {
      return new URL(thumb).pathname;
    } catch {
      return null;
    }
  }
  return thumb.startsWith("/") ? thumb : `/uploads/thumbs/${thumb}`;
}

function enrichFromStored(events, stored) {
  for (const event of events) {
    const prev = stored.get(event.id);
    event._location = prev?.location || null;
    event._location_key = prev?.location_key || null;
    event._image = prev?.image || null;
  }
}

function detectTicketsBackInStock(incoming, stored) {
  const backInStock = [];

  for (const event of incoming) {
    const prev = stored.get(event.id);
    const ticketsLeft = event.website_left_tickets_count;
    if (prev && prev.tickets_left === 0 && ticketsLeft > 0) {
      backInStock.push({
        id: event.id,
        source: event.source,
        name: event.name,
        date: event.start_date,
        start_time: event.start_time,
        end_time: event.end_time,
        tickets_left: ticketsLeft,
        location: event._location,
        image_url: event._image || pickImagePath(event),
      });
    }
  }

  return backInStock;
}

/**
 * Brand-new events (id not in `stored`) that arrived already with stock.
 * The saved-search notifier wants to know about these so a user who saved
 * "סיור עששיות" hears about a tour scheduled tomorrow even though no one
 * had ever subscribed to that specific event.
 */
function detectNewWithStock(incoming, stored) {
  const newOnes = [];
  for (const event of incoming) {
    if (stored.has(event.id)) continue;
    const ticketsLeft = event.website_left_tickets_count;
    if (!ticketsLeft || ticketsLeft <= 0) continue;
    newOnes.push({
      id: event.id,
      source: event.source,
      name: event.name,
      date: event.start_date,
      start_time: event.start_time,
      end_time: event.end_time,
      tickets_left: ticketsLeft,
      location: event._location,
      image_url: event._image || pickImagePath(event),
    });
  }
  return newOnes;
}

// Lead the message with the event name + accurate count so push-notification
// previews are informative (not alarmy) and never misleading. Singular vs
// plural is honored explicitly: "כרטיס אחד" / "N כרטיסים".
function ticketsCountPhrase(n) {
  if (n === 1) return "התפנה כרטיס אחד";
  return `התפנו ${n} כרטיסים`;
}

function buildWhatsAppMessage(event) {
  const url = getBookingUrl(event);
  const lines = [
    `🎫 ${ticketsCountPhrase(event.tickets_left)} — ${event.name}`,
    `📅 ${formatHebrewDate(event.date)}`,
  ];
  const timeStr = formatTimeRange(event.start_time, event.end_time);
  if (timeStr) lines.push(rtlLine(`🕐 ${timeStr}`));
  if (event.location) lines.push(`📍 ${event.location}`);
  lines.push(``, url);
  return lines.join("\n");
}

async function sendWhatsApp(eventData) {
  const phone = process.env.WHATSAPP_PHONE;
  const apikey = process.env.WHATSAPP_KEY;
  if (!phone || !apikey) return;

  const message = buildWhatsAppMessage(eventData);
  await axios.get("https://api.callmebot.com/whatsapp.php", {
    params: { phone, text: encodeURIComponent(message), apikey },
  });
  console.log("  [WhatsApp] notification sent");
}

// Legacy single-recipient WhatsApp broadcast.
//
// The Telegram side of this used to live here too, but it was a global
// ping to TELEGRAM_CHAT_ID for every back-in-stock event regardless of
// whether anyone subscribed to it — it predated the per-user watcher /
// saved-search system and was just noise once those existed. WhatsApp
// is kept because it remains a useful out-of-band heartbeat for the bot
// owner (no inline keyboards / DB context needed there). All Telegram
// notifications now flow through System B exclusively:
//   - notifyWatchers          → users who followed a specific event
//   - notifySavedSearchMatch  → users whose saved search matches
async function sendNotifications(eventData) {
  try {
    await sendWhatsApp(eventData);
  } catch (err) {
    console.error("  [Notification] WhatsApp failed:", err.message);
  }
}

function buildWatcherMessage(event, firstName, watcher = {}) {
  const greeting = firstName ? `${firstName}, ` : "";
  const lines = [
    `🎫 ${ticketsCountPhrase(event.tickets_left)} — ${event.name}`,
    `${greeting}האירוע שעקבת אחריו חזר למלאי 🎉`,
  ];
  if (event.date) lines.push(`📅 ${formatHebrewDate(event.date)}`);
  const timeStr = formatTimeRange(event.start_time, event.end_time);
  if (timeStr) lines.push(rtlLine(`🕐 ${timeStr}`));
  if (event.location) lines.push(`📍 ${event.location}`);

  const needed = watcher.tickets_needed;
  if (needed != null) {
    const available = event.tickets_left ?? 0;
    if (available >= needed) {
      lines.push(`📋 ביקשת ${needed} — יש מספיק במלאי 🎯`);
    } else {
      lines.push(`📋 ביקשת ${needed} — נמצאו ${available} בלבד.`);
    }
  }

  return lines.join("\n");
}

/**
 * Build the inline keyboard for the watcher notification: a booking link
 * + one "✅ קניתי N" button per quantity from 1 up to min(needed, available).
 *
 * If the user didn't tell us how many they need, fall back to the original
 * single "לרכישה" button — there's nothing to decrement against.
 */
function watcherKeyboard(event, ticketsNeeded, ticketsLeft) {
  const eventId = event.id;
  const rows = [
    [{ text: "🎟️ לרכישה", url: getBookingUrl(event) }],
  ];

  if (ticketsNeeded != null) {
    const cap = Math.min(ticketsNeeded, ticketsLeft ?? ticketsNeeded);
    if (cap >= 1) {
      const buyButtons = [];
      for (let n = 1; n <= cap && n <= 6; n++) {
        buyButtons.push({ text: `✅ קניתי ${n}`, callback_data: `bg:${eventId}:${n}` });
      }
      // Split into rows of up to 3 buttons so the labels don't get truncated.
      for (let i = 0; i < buyButtons.length; i += 3) {
        rows.push(buyButtons.slice(i, i + 3));
      }
    }
  }

  rows.push([{ text: "🔕 בטל מעקב", callback_data: `unw:${eventId}` }]);
  return { inline_keyboard: rows };
}

async function notifyWatchers(event) {
  if (!bot) return;
  const { getWatchersForEvent, markNotified } = require("../lib/watchService");
  let watchers = [];
  try {
    watchers = await getWatchersForEvent(event.id);
  } catch (err) {
    console.error("  [Watchers] fetch failed:", err.message);
    return;
  }
  if (!watchers.length) return;

  console.log(`  [Watchers] notifying ${watchers.length} user(s) about "${event.name}"`);

  const telegramIds = watchers.map((w) => w.telegram_id);
  const { data: profiles } = await supabase
    .from("profiles")
    .select("telegram_id, first_name")
    .in("telegram_id", telegramIds);
  const nameByTg = new Map((profiles || []).map((p) => [p.telegram_id, p.first_name]));

  for (const w of watchers) {
    const tg = w.telegram_id;
    const message = buildWatcherMessage(event, nameByTg.get(tg), {
      tickets_needed: w.tickets_needed,
    });
    const reply_markup = watcherKeyboard(event, w.tickets_needed, event.tickets_left);
    try {
      const photoUrl = normalizeImageUrl(event.image_url, event);
      if (photoUrl) {
        try {
          await bot.telegram.sendPhoto(tg, photoUrl, { caption: message, reply_markup });
        } catch {
          await bot.telegram.sendMessage(tg, message, { reply_markup });
        }
      } else {
        await bot.telegram.sendMessage(tg, message, { reply_markup });
      }
      await markNotified(tg, event.id);
      console.log(`    ✓ notified ${tg}`);
    } catch (err) {
      console.error(`    ✗ failed to notify ${tg}: ${err.message}`);
    }
  }
}

// Compare the set of Smarticket IDs seen in this scrape cycle against
// every non-archived Smarticket event whose date falls within the same
// 45-day window. Any event that is in the DB but absent from the feed
// has been deleted on Smarticket's side and should be archived.
//
// Also archives any Smarticket event with date IS NULL — these are
// payment/placeholder rows that Smarticket exposes as events but have
// no real date. isFutureOrToday() already filters them from new upserts;
// this call cleans up any that slipped through in earlier scrape cycles.
//
// The window guard is essential: events beyond LOOKAHEAD_DAYS are simply
// not yet returned by the calendar API — we must not archive them.
//
// Called at the end of upsertEvents so the seenIds set is already fully
// populated (after all filter/skip decisions).
async function archiveDroppedSmartTicketEvents(seenIds, range) {
  const smarticketSources = TENANTS.filter((t) => t.kind === "smarticket").map(
    (t) => t.source,
  );
  if (!smarticketSources.length) return 0;

  const toArchive = new Set();

  // ── 1. In-window events missing from this cycle's feed ───────────────
  if (seenIds.size) {
    const { data: dropped, error } = await supabase
      .from("events")
      .select("id")
      .in("source", smarticketSources)
      .eq("archived", false)
      .gte("date", range.start)
      .lte("date", range.end)
      .not("id", "in", `(${[...seenIds].join(",")})`);

    if (error) {
      console.warn(`[Check] archiveDropped: candidate query failed — ${error.message}`);
    } else {
      (dropped || []).forEach((r) => toArchive.add(r.id));
    }
  }

  // ── 2. Events with no date (payment/fake rows) ────────────────────────
  const { data: dateless, error: datelessErr } = await supabase
    .from("events")
    .select("id")
    .in("source", smarticketSources)
    .eq("archived", false)
    .is("date", null);

  if (datelessErr) {
    console.warn(`[Check] archiveDropped: dateless query failed — ${datelessErr.message}`);
  } else {
    (dateless || []).forEach((r) => toArchive.add(r.id));
  }

  // ── 3. Ghost events: enrichment ran but no time/slug/url ─────────────
  // These are course-enrollment or payment placeholders that Smarticket
  // exposes with a date in the API but shows as "ללא תאריך" on the
  // website. After enrichment they still have no start_time, no
  // external_slug, and no external_url — they are not actionable.
  const { data: ghosts, error: ghostErr } = await supabase
    .from("events")
    .select("id")
    .in("source", smarticketSources)
    .eq("archived", false)
    .is("start_time", null)
    .is("external_slug", null)
    .is("external_url", null)
    .not("enrichment_last_attempt", "is", null);

  if (ghostErr) {
    console.warn(`[Check] archiveDropped: ghost query failed — ${ghostErr.message}`);
  } else {
    (ghosts || []).forEach((r) => toArchive.add(r.id));
  }

  if (!toArchive.size) return 0;

  const ids = [...toArchive];
  const { error: archiveErr } = await supabase
    .from("events")
    .update({ archived: true })
    .in("id", ids);

  if (archiveErr) {
    console.warn(`[Check] archiveDropped: update failed — ${archiveErr.message}`);
    return 0;
  }

  console.log(
    `[Check] Archived ${ids.length} dropped/dateless/ghost Smarticket event(s): ${ids.join(", ")}`,
  );
  return ids.length;
}

async function upsertEvents(events) {
  const now = new Date().toISOString();
  let skippedPast = 0;
  let skippedAdmin = 0;
  let skippedService = 0;
  let skippedTest = 0;

  const rows = [];
  for (const e of events) {
    if (isAdminEntry(e.name)) {
      skippedAdmin++;
      continue;
    }
    if (isServiceEntry(e)) {
      skippedService++;
      continue;
    }
    if (isTestEntry(e)) {
      skippedTest++;
      continue;
    }
    if (!isFutureOrToday(e.start_date)) {
      skippedPast++;
      continue;
    }

    const ticketsLeft = e.website_left_tickets_count;
    const row = {
      id: e.id,
      name: e.name,
      date: e.start_date,
      start_time: e.start_time,
      end_time: e.end_time,
      tickets_left: ticketsLeft,
      is_sold_out: ticketsLeft === 0,
      archived: false,
      // `e.source` is stamped by `fetchTenantEvents`. Falling back to
      // the DB DEFAULT 'mbe-rg' on a missing tag would silently swallow
      // a programming error elsewhere, so we crash instead.
      source: e.source || (() => {
        throw new Error(`upsertEvents: event #${e.id} missing source tag`);
      })(),
      last_checked: now,
      last_updated: now,
    };

    // Community-access classification (title-driven). Only emit a
    // value when the classifier has a POSITIVE signal — null means
    // "I have no opinion, don't touch the column". This preserves:
    //   * Manual classifications set via the SQL console.
    //   * Prior cycle's positive classification when the title was
    //     temporarily edited / shortened (Smarticket titles do drift
    //     and we don't want a brief edit to clear `community-miluim`).
    // First-insert still gets the right value because the row is
    // brand-new, the DB default 'open' kicks in, and the classifier's
    // hit (when there is one) overrides it on the same upsert.
    //
    // We classify off the title only here (description isn't part of
    // the calendar JSON we just fetched; the enricher pulls it from
    // detail pages separately). For miluim/pride/disabilities events
    // the title carries the signal consistently across both Smarticket
    // tenants — verified against the 4 known reservist events on
    // ramat-gan.smarticket.co.il in the 2026-05 cycle.
    // Returns an array of all matching community scopes (e.g.
    // ['community-lgbtq', 'community-russian']) or null when the
    // title carries no community signal (don't overwrite existing).
    const access = classifyAllAccessForEvent({ name: e.name });
    if (access) row.access = access;

    // Preserve the venue FK on existing events. The text itself lives on
    // locations.raw_address — we never write venue text to events anymore.
    if (e._location_key) {
      row.location_key = e._location_key;
    } else if (e._location) {
      // Legacy / first-seen path: the prior version had text, no FK yet.
      row.location_key = await ensureLocationKey(e._location);
    }

    // Image source-of-truth waterfall:
    //   1. _image — we already had a value on the previous cycle; keep
    //      it. Cheap and avoids stomping a value the enricher may
    //      have written from a detail-page scrape.
    //   2. The calendar JSON itself (see pickImagePath — prefers the
    //      full-resolution `image` upload over the 3 KB
    //      `thumbnail_calendar` grid thumb). Coverage isn't perfect —
    //      mbe-rg fills it ~93% of the time, ramat-gan ~43% — but
    //      using it as the seed means the row renders immediately on
    //      first scrape instead of waiting for a homepage-enrichment
    //      pass that may never arrive (ramat-gan paginates its
    //      homepage to ~20 events, so most events are never visible
    //      there).
    //   3. null — display falls back to text-only. Enricher can fill
    //      in later from the per-event detail page.
    //
    // Stored format is RELATIVE (`/uploads/…`). The render layer
    // (`lib/imageUrl.js#normalizeImageUrl`) joins the tenant base at
    // read time — see callers in `lib/savedSearchNotifier.js` and the
    // bot's photo dispatcher.
    if (e._image) {
      row.image = e._image;
    } else {
      const seedImage = pickImagePath(e);
      if (seedImage) row.image = seedImage;
    }
    rows.push(row);
  }

  if (skippedPast || skippedAdmin || skippedService || skippedTest) {
    console.log(
      `[Check] Filtered out ${skippedPast} past + ${skippedAdmin} admin + ${skippedService} service + ${skippedTest} test entr(ies) before upsert`
    );
  }
  if (!rows.length) return 0;

  // Snapshot the existing tickets_left BEFORE the upsert so we can tell
  // which rows actually moved this cycle. We use that to bump
  // `last_changed_at` selectively — `last_updated`/`last_checked` always
  // bump (they mean "scraper touched this row"), but `last_changed_at`
  // is the truthful "value moved" stamp callers like the bot rely on.
  const ids = rows.map((r) => r.id);
  const { data: existing, error: existingErr } = await supabase
    .from("events")
    .select("id, tickets_left")
    .in("id", ids);
  if (existingErr) {
    // Non-fatal: if the lookup fails we still want to write the new
    // numbers. We just won't be able to update `last_changed_at` for
    // genuinely-changed rows this cycle. The next successful cycle
    // will catch up.
    console.warn(
      `[Check] tickets_left snapshot read failed (${existingErr.message}); ` +
        `last_changed_at will not be updated this cycle`,
    );
  }
  const previousTickets = new Map(
    (existing || []).map((r) => [r.id, r.tickets_left]),
  );

  // `defaultToNull: false` is REQUIRED here. With the default
  // (`true`), supabase-js unions every key seen across all rows in
  // the batch and explicitly sends NULL for any key a row omitted.
  // That breaks the `access` column specifically:
  //   * `events.access` is `access_t[] NOT NULL DEFAULT '{open}'`
  //     (sql/039 + sql/060).
  //   * We deliberately OMIT `access` from rows where the title-
  //     classifier had no positive signal — the goal is "let the DB
  //     default kick in on INSERT, preserve the existing value on
  //     UPDATE" (see the rationale on line 484 above).
  //   * Once ANY row in the batch carries a community-* value
  //     (e.g. a 'community-miluim' miluim party), the batch
  //     suddenly serialises EVERY OTHER row's missing access as
  //     `NULL`, the DB rejects it with `null value in column
  //     "access" of relation "events" violates not-null
  //     constraint`, and the whole scrape cycle fails.
  // `defaultToNull: false` switches the serialiser to omit missing
  // columns — INSERT gets the DB default, UPDATE keeps the prior
  // value, exactly what the comment further up promises.
  //
  // Same pattern protects any FUTURE per-row optional column we
  // add (image, min_months, audience, …): omitting a column from a
  // single row no longer leaks NULL across the batch.
  const { error } = await supabase.from("events").upsert(rows, {
    onConflict: "id",
    defaultToNull: false,
  });
  if (error) throw new Error(`Supabase upsert failed: ${error.message}`);

  // Now update last_changed_at only for rows whose tickets_left moved
  // (or for brand-new rows we never saw before). Treat NULL → number as
  // a change too — better to over-stamp once than to lie about a row
  // never having changed. A separate UPDATE keeps the upsert payload
  // clean (no NULLing of last_changed_at on unchanged rows).
  const changedIds = rows
    .filter((r) => {
      if (!previousTickets.has(r.id)) return true; // brand new
      const prev = previousTickets.get(r.id);
      return prev !== r.tickets_left;
    })
    .map((r) => r.id);

  if (changedIds.length) {
    const { error: chErr } = await supabase
      .from("events")
      .update({ last_changed_at: now })
      .in("id", changedIds);
    if (chErr) {
      // The column might not exist yet on a freshly-cloned env that
      // hasn't applied sql/029. Log loud and continue — the rest of
      // the row is already saved correctly.
      console.warn(
        `[Check] last_changed_at bump skipped (${chErr.message}); ` +
          `apply sql/029_last_changed_at.sql to enable.`,
      );
    } else if (changedIds.length > 1) {
      console.log(`[Check] last_changed_at bumped on ${changedIds.length} rows`);
    }
  }

  // Archive events that were in the DB but absent from the calendar
  // response this cycle — they've been deleted on Smarticket's side.
  // We pass the same date range used to fetch so we only touch events
  // that should have appeared had they still existed.
  const range = buildDateRange();
  const seenIds = new Set(rows.map((r) => r.id));
  await archiveDroppedSmartTicketEvents(seenIds, range);

  return rows.length;
}

// Lightweight wrapper around the city-municipal scraper. Failures are
// swallowed: the city feed is independent of Smarticket, and a transient
// outage there must not cascade into the main scrape (where ticket
// availability and back-in-stock notifications live). Stats are
// returned for the cycle summary log; on failure the caller still
// gets a sensible "0 across the board" record.
async function runCityApiScrape() {
  try {
    const { scrapeCityApi } = require("../lib/cityApiScraper");
    return await scrapeCityApi();
  } catch (err) {
    console.error(`[CityApi] scrape failed: ${err.message}`);
    return null;
  }
}

async function check() {
  console.log(`[${new Date().toISOString()}] Fetching data from Smarticket...`);

  const events = await fetchEvents();
  console.log(`Fetched ${events.length} events`);

  const eventIds = events.map((e) => e.id);
  const stored = await getStoredEvents(eventIds);

  enrichFromStored(events, stored);

  const backInStock = detectTicketsBackInStock(events, stored);
  const newWithStock = detectNewWithStock(events, stored);

  if (backInStock.length > 0) {
    console.log(`\nTickets back in stock for ${backInStock.length} event(s):`);
    for (const event of backInStock) {
      await sendNotifications(event);
      await notifyWatchers(event);
    }
  }

  // Low-stock urgency push — per May-2026 spec, fire immediately
  // when an event crosses to ≤10 tickets (transition, not steady-
  // state). Deduped per (event_id, telegram_id) via
  // low_stock_notifications. Audience: per-event watchers + saved-
  // search topic matches. Broader profile-interest matches fall to
  // the weekly newsletter (lib/newsletterScheduler.js) instead, to
  // keep these urgent alerts narrowly targeted.
  if (bot) {
    try {
      const {
        detectLowStockTransitions,
        notifyLowStockMatchesFor,
      } = require("../lib/lowStockNotifier");
      const lowStock = detectLowStockTransitions(events, stored);
      if (lowStock.length) {
        console.log(`\nLow-stock transitions: ${lowStock.length} event(s)`);
        const stats = await notifyLowStockMatchesFor(lowStock, bot.telegram);
        if (stats.matched) {
          console.log(
            `[LowStock] ${stats.notified}/${stats.matched} push(es) sent.`,
          );
        }
      }
    } catch (err) {
      console.error("[LowStock] notifier error:", err.message);
    }
  }

  const upserted = await upsertEvents(events);
  console.log(`Synced ${upserted} events to Supabase`);

  const cleanup = await runCleanup();
  console.log(`Cleanup: deleted=${cleanup.deleted}, archived=${cleanup.archived}`);

  // Resolve any locations rows that are still pending (newly inserted stubs
  // from this run, or stragglers from prior runs). Each unique venue is hit
  // exactly once over the lifetime of the cache.
  try {
    const stats = await resolvePending();
    if (stats.pending) {
      console.log(
        `Locations: resolved ${stats.resolved}/${stats.pending} (failed=${stats.failed})`
      );
    }
  } catch (err) {
    console.error("[Locations] resolve failed:", err.message);
  }

  // City-municipal scrape runs in parallel-friendly fashion AFTER the
  // Smarticket upsert + cleanup. Why after, not in parallel:
  //   - We don't want city-events fighting Smarticket for the geocoder
  //     pending-resolve cycle on first boot.
  //   - The newly-inserted city events feed into the same saved-search
  //     notifier below, so they need to be in the table before that
  //     query runs.
  // The city scraper has its own internal Layer 1/2 detection (see
  // lib/cityApi.js) and DOES NOT add any event the Smarticket scrape
  // already accounts for.
  const cityStats = await runCityApiScrape();
  if (cityStats) {
    console.log(
      `[CityApi] cycle: collected=${cityStats.collected} smarticket=${cityStats.smarticket} cityOnly=${cityStats.cityOnly} multiSession=${cityStats.multiSessionParents}/${cityStats.multiSessionChildren} umbrella=${cityStats.umbrella} upserted=${cityStats.upserted} (fetchErr=${cityStats.detailErrors} writeErr=${cityStats.upsertErrors})`,
    );
  }

  // Newsletter enqueue — May-2026 v2 spec replaced the weekly
  // digest with an immediate-with-5-min-buffer model. After every
  // scrape (Smarticket + city) completes, we ask the scheduler to
  // pull newly-arrived events (events.first_seen_at within the
  // lookback window) and enqueue each for any qualifying user.
  // The scheduler's own 30s flush tick then delivers buffers whose
  // 5-min window has elapsed.
  //
  // Low-stock pushes (above) bypass this — they fire IMMEDIATELY
  // with no buffer wait, per the spec's "low-stock = priority"
  // requirement.
  if (bot) {
    try {
      const scheduler = require("../lib/newsletterScheduler");
      await scheduler.enqueueAfterScrape();
    } catch (err) {
      console.error("[Newsletter] enqueue error:", err.message);
    }
  }

  // Evening-before reminders for ⭐ event interests.
  // Only fires during 18:00–22:00 Jerusalem time; no-ops outside the window.
  if (bot) {
    try {
      const { sendPendingReminders } = require("../lib/reminderService");
      await sendPendingReminders(bot.telegram);
    } catch (err) {
      console.error("[Reminders] error:", err.message);
    }
  }

  // Saved-search LIVE push was REMOVED in the May-2026 newsletter
  // redesign — saved-search topics now drive the buffered delivery
  // above. The `saved_searches` rows themselves are still used by:
  //   - lib/savedSearchNotifier.js#notifySavedSearchMatchesForTicket
  //     (WhatsApp 2nd-hand ticket matches — different domain, kept live)
  //   - lib/lowStockNotifier.js (low-stock urgency push — bypasses
  //     the buffer for ≤10-ticket events)
  // notifyWatchers (already invoked above) still fires live for
  // per-EVENT subscriptions — those are explicit one-event opt-ins,
  // not topic-level digests.

  return { synced: upserted, backInStock, newWithStock, cleanup };
}

module.exports = check;

if (require.main === module) {
  if (process.argv.includes("--test")) {
    const sampleEvent = {
      id: 12345,
      source: "mbe-rg",
      name: "אירוע לדוגמה",
      date: "2026-05-01",
      start_time: "20:00",
      tickets_left: 3,
      location: "נקודת מפגש, דרך זאב ז'בוטינסקי 107, רמת גן",
      image_url: "https://mbe-rg.smarticket.co.il/uploads/thumbs/sample.jpg",
    };
    sendNotifications(sampleEvent)
      .then(() => console.log("Test complete"))
      .catch((err) => {
        console.error("Test failed:", err.message);
        process.exit(1);
      });
  } else {
    check()
      .then(({ synced, backInStock }) => {
        console.log(
          `Done — ${synced} synced, ${backInStock.length} back in stock`
        );
      })
      .catch((err) => {
        console.error("Check failed:", err.message);
        process.exit(1);
      });
  }
}
