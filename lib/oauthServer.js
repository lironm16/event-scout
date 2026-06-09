// Tiny Express server that handles Google OAuth 2.0 callbacks.
//
// Why a server when the bot is otherwise polling-only:
//   The Telegram bot is a worker (polls Telegram), no inbound HTTP.
//   But OAuth 2.0 authorization_code flow requires Google to redirect
//   the user's browser to a URL we control with the `code` query
//   parameter. There's no way around having SOME public HTTP endpoint.
//
// Deployment on Railway: Railway injects $PORT for the web service
// type. The same process can both poll Telegram (Telegraf) AND listen
// on $PORT for the OAuth callback. We bind only the single route we
// need (`/oauth/google/callback`) plus a `/health` probe; everything
// else 404s.
//
// State parameter: we use `state=<telegram_id>` so the callback can
// associate the returned tokens with the right user. The value is not
// secret per se (it's a Telegram user id), but Google does validate
// state ↔ original-request equality so an attacker can't trivially
// hijack the flow. For higher-stakes flows we'd HMAC the state; for a
// personal-bot Calendar integration the plain id is sufficient.

const path = require("path");
const express = require("express");
const axios = require("axios");
const supabase = require("./supabase");
const miniAppAuth = require("./miniAppAuth");
const { getProfile } = require("../bot/profileService");
const { getAllEvents, getEventById } = require("../bot/matchingService");
const { deriveDefaultAudienceSet } = require("./categories");
const { formatHebrewDate, formatTimeRange, formatAudienceLine, getEventIcon } = require("./eventFormat");
const { accessRestrictionLine } = require("./interestCategories");
const { getBookingUrl } = require("./sourceUrls");
const { normalizeImageUrl } = require("./imageUrl");
const { displayLocationText, isCityWideLocation } = require("./locationStore");
const { addInterest, removeInterest, recordInterestSignal, recordPositiveSignal, recordNotInterestedSignal } = require("./interestService");

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

function buildAuthUrl(telegramId) {
  const clientId = requireEnv("GOOGLE_OAUTH_CLIENT_ID");
  const redirectUri = requireEnv("GOOGLE_OAUTH_REDIRECT_URI");
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/calendar.events",
    // `offline` + `prompt=consent` guarantee a refresh_token in the
    // response — without these Google returns NULL for refresh_token
    // on subsequent grants and our token store ends up unable to
    // refresh access. Forcing the consent screen every time is a
    // small annoyance for the user but avoids the silent
    // "refresh_token is null" pitfall.
    access_type: "offline",
    prompt: "consent",
    state: String(telegramId),
    include_granted_scopes: "true",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

// Render a self-contained HTML response so the user sees a friendly
// page after the redirect lands. We don't host any static assets;
// inline everything.
function renderSuccessHtml() {
  return `<!doctype html>
<html lang="he" dir="rtl">
  <head><meta charset="utf-8"><title>החיבור הושלם</title></head>
  <body style="font-family:sans-serif;text-align:center;padding:40px;">
    <h1>✅ החיבור ל‑Google Calendar הושלם</h1>
    <p>אפשר לסגור את החלון הזה ולחזור לטלגרם.</p>
  </body>
</html>`;
}

function renderErrorHtml(message) {
  return `<!doctype html>
<html lang="he" dir="rtl">
  <head><meta charset="utf-8"><title>שגיאה</title></head>
  <body style="font-family:sans-serif;text-align:center;padding:40px;">
    <h1>⚠️ חיבור נכשל</h1>
    <p>${escapeHtml(message)}</p>
    <p>אפשר לנסות שוב עם /connect_calendar בטלגרם.</p>
  </body>
</html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

// Exchange the authorization_code for tokens, persist them keyed by
// telegram_id. Idempotent — re-runs overwrite the existing row,
// which is the right behaviour when the user re-connects (e.g.
// switched accounts).
async function exchangeCodeForTokens(code) {
  const clientId = requireEnv("GOOGLE_OAUTH_CLIENT_ID");
  const clientSecret = requireEnv("GOOGLE_OAUTH_CLIENT_SECRET");
  const redirectUri = requireEnv("GOOGLE_OAUTH_REDIRECT_URI");
  const res = await axios.post(
    GOOGLE_TOKEN_URL,
    new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }).toString(),
    {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 15_000,
    },
  );
  return res.data;
}

async function persistTokens(telegramId, tokens) {
  const expiresInSec = Number(tokens.expires_in) || 3600;
  const expiresAt = new Date(Date.now() + expiresInSec * 1000).toISOString();
  const row = {
    telegram_id: String(telegramId),
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || null,
    expires_at: expiresAt,
    scope: tokens.scope || null,
    updated_at: new Date().toISOString(),
  };
  // If we're refreshing (no refresh_token returned), keep the
  // existing one — Google only ships refresh_token on the FIRST
  // consent. The upsert below would clobber it to NULL, so we read
  // first when refresh_token is missing.
  if (!row.refresh_token) {
    const { data: existing } = await supabase
      .from("google_oauth_tokens")
      .select("refresh_token")
      .eq("telegram_id", String(telegramId))
      .maybeSingle();
    if (existing?.refresh_token) {
      row.refresh_token = existing.refresh_token;
    }
  }
  const { error } = await supabase
    .from("google_oauth_tokens")
    .upsert(row, { onConflict: "telegram_id" });
  if (error) throw new Error(`persistTokens failed: ${error.message}`);
}

// ─── Mini App helpers ──────────────────────────────────────────────────────
// Preference score for ranking: higher = show first.
function computePreferenceScore(event, prefs) {
  if (!prefs) return 0;
  let score = 0;
  const { tag_weights = {}, category_weights = {}, series_suppress = {} } = prefs;
  // Suppressed series are greatly demoted (not hidden — user might still want
  // to find them if they scroll, but they shouldn't crowd the top).
  if (event.external_slug && series_suppress[event.external_slug]) score -= 2;
  if (event.category && category_weights[event.category])
    score += category_weights[event.category];
  if (Array.isArray(event.tags)) {
    for (const tag of event.tags) {
      if (tag_weights[tag]) score += tag_weights[tag];
    }
  }
  return score;
}

// Serialize a DB event row into a lean JSON shape the frontend consumes.
function serializeEvent(event) {
  let bookingUrl = null;
  try { bookingUrl = getBookingUrl(event); } catch {}

  return {
    id: event.id,
    name: event.name,
    icon: getEventIcon(event),
    date: event.date,
    dateHe: formatHebrewDate(event.date),
    startTime: event.start_time || null,
    timeHe: formatTimeRange(event.start_time, event.end_time),
    location: isCityWideLocation(event.location_key) ? "ברחבי העיר" : (event.location || null),
    image: normalizeImageUrl(event.image, event) || null,
    category: event.category || null,
    audience: event.audience || null,
    audienceLine: formatAudienceLine(event),
    // Extra row shown only when the event is narrowed to specific
    // community/ies (access ≠ open). null = open to the general public.
    accessLine: accessRestrictionLine(event.access),
    tags: event.tags || [],
    description: event.description || null,
    bookingUrl,
    externalUrl: event.external_url || null,
    onlineUrl: event.online_url || null,
    ticketsLeft: event.tickets_left ?? null,
    source: event.source,
    umbrella_slug: event.umbrella_slug || null,
    umbrella_title: event.umbrella_title || null,
    _lat: event._coords?.lat ?? null,
    _lng: event._coords?.lng ?? null,
    _score: 0, // filled in by the route
  };
}

/**
 * Register Mini App API routes under `prefix` (e.g. /miniapp).
 * `verifyInitData` selects prod vs dev bot token for initData HMAC.
 */
function registerMiniAppRoutes(app, { prefix, verifyInitData, logLabel, bot }) {
  const tag = logLabel || prefix;
  // Reuse the bot's full search engine + saved-search helpers.
  const { dispatch } = require("./agent/tools");
  const { rememberSearchHits } = require("./searchCtx");
  const { filtersToSearchArgs, filtersToSaveSnapshot } = require("./searchRouter");
  const {
    listSavedSearches,
    createSavedSearch,
    archiveSavedSearch,
  } = require("./savedSearchService");

  const asList = (v) =>
    Array.isArray(v)
      ? v
      : typeof v === "string" && v.trim()
        ? v.split(",").map((s) => s.trim()).filter(Boolean)
        : [];
  const asBool = (v) => v === "1" || v === "true" || v === true;

  function parseSearchFilters(q) {
    const f = {};
    if (q.date_preset) f.date_preset = q.date_preset;
    if (q.dateFrom) f.date_from = q.dateFrom;
    if (q.dateTo) f.date_to = q.dateTo;
    if (!f.date_preset && !f.date_from && !f.date_to) f.date_preset = "upcoming";
    const tags = asList(q.tags);
    if (tags.length) f.tags = tags;
    const kw = asList(q.keywords);
    if (kw.length) f.keywords = kw;
    const acts = asList(q.activity_types);
    if (acts.length) f.activity_types = acts;
    const auds = asList(q.audiences);
    if (auds.length) f.audiences = auds;
    if (q.audience) f.audience = q.audience;
    if (q.proximity) f.proximity = q.proximity;
    if (asBool(q.available_only)) f.available_only = true;
    if (asBool(q.unseen_only)) f.unseen_only = true;
    if (asBool(q.ignore_profile)) f.ignore_profile = true;
    const ages = asList(q.ages).map((n) => parseInt(n, 10)).filter(Number.isFinite);
    if (ages.length) f.ages = ages;
    return f;
  }

  app.get(`${prefix}/events`, async (req, res) => {
    let identity;
    try {
      identity = verifyInitData(req.query.initData || "");
    } catch (err) {
      return res.status(401).json({ error: err.message });
    }

    try {
      const { telegramId, firstName } = identity;

      let profile = null;
      try { profile = await getProfile(telegramId); } catch {}
      const prefs = profile?.user_context?.preferences || null;

      // Run the SAME search the bot runs (all profile-aware filters,
      // בשבילי/כללי, tags, proximity, age/stage fit, …) via the tool.
      const args = filtersToSearchArgs(parseSearchFilters(req.query));
      // Catalog renders the full sorted set with infinite scroll on the
      // client, so request a generous page (bounded server-side to 300).
      // High cap so series-collapse (which happens AFTER the cap) still yields
      // the full distinct-event set; the client paginates via infinite scroll.
      const reqLimit = parseInt(req.query.limit, 10);
      args.limit = Number.isFinite(reqLimit) && reqLimit > 0 ? reqLimit : 800;
      const ctx = { telegramId, profile, lastSearchHits: [], lastSearchResultIds: new Set() };
      ctx.rememberSearchHits = (evts) => rememberSearchHits(ctx, evts);
      const result = await dispatch("search_events", args, ctx);
      if (result?.error) {
        return res.status(500).json({ error: result.message || "search failed" });
      }

      // result.events are series representatives (projection); render rich
      // cards from the full rows search_events cached on ctx.lastSearchHits.
      // lastSearchHits is capped (SEARCH_HIT_CAP) so reps beyond the cap miss
      // it and lose image/source — fall back to the full getAllEvents row.
      const byId = new Map((ctx.lastSearchHits || []).map((e) => [e.id, e]));
      let allById = null;
      try {
        const all = await require("../bot/matchingService").getAllEvents();
        allById = new Map((all || []).map((e) => [e.id, e]));
      } catch { allById = new Map(); }
      // "בשבילי" scope: in כללי (ignore_profile) we mark which events DO match
      // the profile, so the UI can badge them "✨ בשבילך" and skip the
      // suppress option on matches. In בשבילי mode everything matched already.
      const isGeneral = !!args.ignore_profile;
      let defAud = null;
      const { passesProfileFilters } = require("./profileEventFilter");
      if (isGeneral) {
        try { defAud = require("./categories").deriveDefaultAudienceSet(profile); } catch {}
      }
      const events = (result.events || []).map((p) => {
        const full = byId.get(p.id) || allById.get(p.id);
        const s = serializeEvent(full || {
          id: p.id, name: p.name, date: p.date,
          start_time: p.start_time, end_time: p.end_time,
          tickets_left: p.tickets_left, location: p.location,
          location_key: p.location_key, tags: p.tags || [],
        });
        s._score = computePreferenceScore(full || {}, prefs);
        s.totalOccurrences = p.total_occurrences || 1;
        // Does this event match the profile ("would show in בשבילי")?
        s.forMe = isGeneral
          ? (full && defAud ? passesProfileFilters(full, profile, defAud) : false)
          : true;
        return s;
      });

      // ── Distance labels ────────────────────────────────────────────
      // Annotate each event (whose venue coords are already known) with a
      // cheap "🚶 ~12 דק׳ / 🚗 ~8 דק׳" label so the catalog can show how far
      // it is from home. Coords are supplied → pure local math, no geocoding
      // network. Only when the profile has home coordinates. (The proximity
      // *filter* is already applied inside search_events via location_modes;
      // this is purely the visible label.)
      try {
        const homeC = profile?.user_context?.constraints?.home_coordinates || null;
        if (homeC?.lat != null && homeC?.lng != null) {
          const { evaluateProximity } = require("./geocoding");
          const { evalWalkMinutesForModes, getLocationModes } = require("./locationPrefs");
          const evalMin = evalWalkMinutesForModes(
            getLocationModes(profile?.user_context?.constraints || {}),
          );
          let budget = 600; // bound the work on very large pages
          for (const s of events) {
            if (budget-- <= 0) break;
            if (s.onlineUrl || s._lat == null || s._lng == null) continue;
            const r = await evaluateProximity(
              { lat: homeC.lat, lng: homeC.lng },
              s.location || null,
              evalMin,
              { lat: s._lat, lng: s._lng },
              { useRoutesApi: false },
            );
            if (r?.resolved && r.label) {
              s.distanceLabel = r.label;
              s.distanceKm = r.km ?? null;
              s.requiresCar = !!r.requires_car;
              s.driveMinutes = r.drive_minutes ?? null;
            }
          }
        }
      } catch (e) {
        console.warn(`[MiniApp${tag}] distance annotate failed: ${e.message}`);
      }

      // Liked/wanted tags rank FIRST. The user's interests (topic labels +
      // arbitrary "wanted" tags) live in user_context.interests. Stable-sort
      // (V8 is stable) so events matching an interest float to the top while
      // search_events' own ordering is preserved within each group.
      const interestSet = new Set(
        (profile?.user_context?.interests || []).map((s) => String(s).trim()).filter(Boolean),
      );
      if (interestSet.size) {
        const matchesInterest = (s) =>
          (s.tags || []).some((t) => interestSet.has(String(t).trim()));
        events.forEach((s, i) => { s._idx = i; s._liked = matchesInterest(s); });
        events.sort((a, b) =>
          a._liked === b._liked ? a._idx - b._idx : a._liked ? -1 : 1,
        );
        events.forEach((s) => { delete s._idx; delete s._liked; });
      }

      // Hydrate the user's currently-watched event ids so the card shows
      // the 🔔 state correctly after a reload.
      let watchedIds = [];
      try {
        const watched = await require("./watchService").getWatchedEvents(telegramId);
        watchedIds = (watched || []).map((w) => w.id);
      } catch { /* non-fatal */ }

      // Expose the user's home (coords + address) so the catalog can show a
      // "my location" map marker, build nav-from-home directions, and sort
      // by distance. Null when the profile has no geocoded home.
      const homeC = profile?.user_context?.constraints?.home_coordinates || null;
      const homeForClient =
        homeC?.lat != null && homeC?.lng != null
          ? {
              lat: homeC.lat,
              lng: homeC.lng,
              address: profile?.user_context?.constraints?.home_address || null,
            }
          : null;
      return res.json({
        profile: {
          firstName,
          telegramId,
          interests: profile?.user_context?.interests || [],
          home: homeForClient,
        },
        total: events.length,
        events,
        scope: isGeneral ? "all" : "me",
        watchedIds,
        window: result.window || null,
        canExtend: !!result.can_extend_beyond_window,
        extensionHint: result.extension_hint || null,
        resolvedTags: result.resolved_tags || [],
        unresolvedTags: result.unresolved_tags || [],
      });
    } catch (err) {
      console.error(`[MiniApp${tag}] /events error:`, err.message);
      return res.status(500).json({ error: "Internal error" });
    }
  });

  // Single-event detail (for the "קרא עוד" Mini App page).
  app.get(`${prefix}/event`, async (req, res) => {
    try { verifyInitData(req.query.initData || ""); }
    catch (err) { return res.status(401).json({ error: err.message }); }
    const id = parseInt(req.query.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Missing id" });
    try {
      const ev = await getEventById(id);
      if (!ev) return res.status(404).json({ error: "not found" });
      const serialized = serializeEvent(ev);
      // (Removed: a full getAllEvents() load here to compute
      // serialized.totalOccurrences — event.js, the only consumer of /event,
      // never renders it, so it was an expensive no-op on every detail open.)
      return res.json({ event: serialized });
    } catch (err) {
      console.error(`[MiniApp${tag}] /event error:`, err.message);
      return res.status(500).json({ error: "Internal error" });
    }
  });

  app.post(`${prefix}/signal`, async (req, res) => {
    let identity;
    try {
      identity = verifyInitData(req.body?.initData || "");
    } catch (err) {
      return res.status(401).json({ error: err.message });
    }
    const { eventId, signal } = req.body || {};
    if (!eventId || !signal) return res.status(400).json({ error: "Missing eventId or signal" });
    const { telegramId } = identity;
    try {
      if (signal === "interest") {
        await addInterest(telegramId, eventId);
        recordInterestSignal(telegramId, eventId).catch(() => {});
        recordPositiveSignal(telegramId, eventId).catch(() => {});
      } else if (signal === "not_interested") {
        await removeInterest(telegramId, eventId).catch(() => {});
        recordNotInterestedSignal(telegramId, eventId).catch(() => {});
      }
      return res.json({ ok: true });
    } catch (err) {
      console.error(`[MiniApp${tag}] /signal error:`, err.message);
      return res.status(500).json({ error: "Internal error" });
    }
  });

  app.post(`${prefix}/report`, async (req, res) => {
    const VALID_TYPES = ["wrong_audience", "wrong_category", "bad_description", "duplicate", "wrong_time", "other"];
    let telegramId = null;
    try {
      if (req.body?.initData) {
        try { telegramId = verifyInitData(req.body.initData).telegramId; } catch {}
      }
      const { eventId, issueType, note } = req.body || {};
      if (!eventId) return res.status(400).json({ error: "Missing eventId" });
      if (!VALID_TYPES.includes(issueType)) return res.status(400).json({ error: "Invalid issueType" });

      // Best-effort persist. If the event_reports table is unavailable
      // (e.g. migration not yet applied / stale PostgREST schema cache) we
      // still forward the report to the admin below rather than hard-failing
      // the user's submission.
      const { error: dbErr } = await supabase.from("event_reports").insert({
        event_id: Number(eventId),
        telegram_id: telegramId,
        issue_type: issueType,
        note: note?.slice(0, 500) || null,
      });
      if (dbErr) console.warn(`[MiniApp${tag}] /report insert failed (continuing): ${dbErr.message}`);

      if (bot?.telegram) {
        const { data: ev } = await supabase.from("events").select("name").eq("id", Number(eventId)).maybeSingle();
        const ISSUE_LABELS = {
          wrong_audience: "קהל יעד שגוי",
          wrong_category: "סיווג / תגיות שגויים",
          bad_description: "תיאור חסר או שגוי",
          duplicate: "אירוע כפול",
          wrong_time: "שעה / תאריך שגויים",
          other: "אחר",
        };
        const lines = [
          `🚩 *דיווח על בעיה*`,
          `📌 ${ev?.name || `אירוע #${eventId}`} \\(#${eventId}\\)`,
          `🏷 ${ISSUE_LABELS[issueType] || issueType}`,
        ];
        if (note) lines.push(`💬 "${note.slice(0, 300)}"`);
        if (telegramId) lines.push(`👤 telegram: ${telegramId}`);
        const ADMIN_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
        if (ADMIN_CHAT_ID) {
          bot.telegram.sendMessage(ADMIN_CHAT_ID, lines.join("\n"), { parse_mode: "MarkdownV2" })
            .catch((e) => console.warn(`[MiniApp${tag}] report notify failed:`, e.message));
        }
      }

      return res.json({ ok: true });
    } catch (err) {
      console.error(`[MiniApp${tag}] /report error:`, err.message);
      return res.status(500).json({ error: "Internal error" });
    }
  });

  // True if an occurrence has already ended (date in the past, or today with
  // its end/start time already passed). Times are HH:MM[:SS] in Israel local.
  function occurrencePassed(dateStr, startTime, endTime) {
    if (!dateStr) return false;
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(new Date());
    const p = Object.fromEntries(fmt.map((x) => [x.type, x.value]));
    const today = `${p.year}-${p.month}-${p.day}`;
    const nowHM = `${p.hour}:${p.minute}`;
    if (dateStr < today) return true;
    if (dateStr > today) return false;
    const t = (endTime || startTime || "").slice(0, 5);
    return t ? t <= nowHM : false; // no time → keep (don't drop)
  }

  // ── Event-card actions (parity with the bot card) ──────────────────
  // 🔁 Other occurrences of a (series / umbrella) event.
  app.get(`${prefix}/occurrences`, async (req, res) => {
    let identity;
    try {
      identity = verifyInitData(req.query.initData || "");
    } catch (err) {
      return res.status(401).json({ error: err.message });
    }
    try {
      const id = Number(req.query.id);
      if (!id) return res.status(400).json({ error: "Missing id" });
      const ev = await getEventById(id);
      if (!ev) return res.json({ occurrences: [] });
      // For the "✨ בשבילך" per-row marker: which occurrences match the profile.
      let profile = null, defAud = null;
      try {
        profile = await getProfile(identity.telegramId);
        if (profile) defAud = require("./categories").deriveDefaultAudienceSet(profile);
      } catch { /* ok */ }
      const { passesProfileFilters } = require("./profileEventFilter");
      // SERIES = same event recurring. Group by the SAME series key search
      // uses (normalized name), so the list matches the "(N)" count exactly.
      const { seriesKey } = require("./eventSeries");
      const { getAllEvents } = require("../bot/matchingService");
      const key = seriesKey(ev);
      const all = await getAllEvents();
      const occ = (all || [])
        .filter((e) => e.id !== id && seriesKey(e) === key && !occurrencePassed(e.date, e.start_time, e.end_time))
        .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")) || String(a.start_time || "").localeCompare(String(b.start_time || "")))
        .map((e) => ({
          id: e.id,
          name: e.name || null,
          icon: getEventIcon(e),
          dateHe: formatHebrewDate(e.date),
          timeHe: formatTimeRange(e.start_time, e.end_time),
          location: e.location || null,
          ticketsLeft: e.tickets_left,
          bookingUrl: getBookingUrl(e),
          forMe: (profile && defAud) ? passesProfileFilters(e, profile, defAud) : true,
        }));
      return res.json({ occurrences: occ });
    } catch (err) {
      console.error(`[MiniApp${tag}] /occurrences error:`, err.message);
      return res.status(500).json({ error: "Internal error" });
    }
  });

  // 📋 All children of an umbrella ("open the parent") — including ones not
  // in the current result set, so the drill-down is complete.
  app.get(`${prefix}/umbrella`, async (req, res) => {
    try {
      verifyInitData(req.query.initData || "");
    } catch (err) {
      return res.status(401).json({ error: err.message });
    }
    try {
      const slug = String(req.query.slug || "").trim();
      if (!slug) return res.status(400).json({ error: "Missing slug" });
      const { getAllEvents } = require("../bot/matchingService");
      const all = await getAllEvents();
      const today = new Date().toISOString().slice(0, 10);
      const sibs = (all || [])
        .filter((e) => e.umbrella_slug === slug && !occurrencePassed(e.date, e.start_time, e.end_time))
        .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")))
        .map((e) => serializeEvent(e));
      return res.json({ events: sibs });
    } catch (err) {
      console.error(`[MiniApp${tag}] /umbrella error:`, err.message);
      return res.status(500).json({ error: "Internal error" });
    }
  });

  // 🔔 Watch / unwatch an event (low-stock / back-in-stock alerts).
  app.post(`${prefix}/watch`, async (req, res) => {
    let identity;
    try {
      identity = verifyInitData(req.body?.initData || "");
    } catch (err) {
      return res.status(401).json({ error: err.message });
    }
    const { eventId, watch } = req.body || {};
    if (!eventId) return res.status(400).json({ error: "Missing eventId" });
    try {
      const watchService = require("./watchService");
      if (watch === false) {
        await watchService.removeWatcher(identity.telegramId, eventId);
      } else {
        await watchService.addWatcher(identity.telegramId, eventId);
      }
      const watching = await watchService.isWatching(identity.telegramId, eventId);
      return res.json({ ok: true, watching });
    } catch (err) {
      console.error(`[MiniApp${tag}] /watch error:`, err.message);
      return res.status(500).json({ error: "Internal error" });
    }
  });

  // ❌ Detailed "not for me" feedback (reason-tagged).
  app.post(`${prefix}/feedback`, async (req, res) => {
    let identity;
    try {
      identity = verifyInitData(req.body?.initData || "");
    } catch (err) {
      return res.status(401).json({ error: err.message });
    }
    const VALID = ["not_interested", "wrong_audience", "wrong_time", "wrong_location", "seen_already"];
    const { eventId, reason } = req.body || {};
    if (!eventId) return res.status(400).json({ error: "Missing eventId" });
    const r = VALID.includes(reason) ? reason : "not_interested";
    try {
      const feedbackService = require("./feedbackService");
      await feedbackService.recordFeedback({ eventId, telegramId: identity.telegramId, reason: r });
      await removeInterest(identity.telegramId, eventId).catch(() => {});
      recordNotInterestedSignal(identity.telegramId, eventId).catch(() => {});
      return res.json({ ok: true });
    } catch (err) {
      console.error(`[MiniApp${tag}] /feedback error:`, err.message);
      return res.status(500).json({ error: "Internal error" });
    }
  });

  // 📍 Exclude the event's venue from future results.
  app.post(`${prefix}/exclude-place`, async (req, res) => {
    let identity;
    try {
      identity = verifyInitData(req.body?.initData || "");
    } catch (err) {
      return res.status(401).json({ error: err.message });
    }
    const { eventId } = req.body || {};
    if (!eventId) return res.status(400).json({ error: "Missing eventId" });
    try {
      const { recordTooFarSignal } = require("./interestService");
      await recordTooFarSignal(identity.telegramId, eventId);
      return res.json({ ok: true });
    } catch (err) {
      console.error(`[MiniApp${tag}] /exclude-place error:`, err.message);
      return res.status(500).json({ error: "Internal error" });
    }
  });

  // ── Profile editor (Mini App) ──────────────────────────────────────
  const { buildProfileEditPayload, applyProfilePatch } = require("./miniAppProfile");

  app.get(`${prefix}/profile`, async (req, res) => {
    let identity;
    try {
      identity = verifyInitData(req.query.initData || "");
    } catch (err) {
      return res.status(401).json({ error: err.message });
    }
    try {
      const profile = await getProfile(identity.telegramId).catch(() => null);
      return res.json(await buildProfileEditPayload(profile));
    } catch (err) {
      console.error(`[MiniApp${tag}] /profile GET error:`, err.message);
      return res.status(500).json({ error: "Internal error" });
    }
  });

  app.post(`${prefix}/profile`, async (req, res) => {
    let identity;
    try {
      identity = verifyInitData(req.body?.initData || "");
    } catch (err) {
      return res.status(401).json({ error: err.message });
    }
    const patch = req.body?.patch;
    if (!patch || typeof patch !== "object") {
      return res.status(400).json({ error: "Missing patch" });
    }
    try {
      const updated = await applyProfilePatch(identity.telegramId, patch);
      return res.json(updated);
    } catch (err) {
      if (err && err.name === "ProfileConflictError") {
        // Suppressed tag contradicts a positive audience/community membership.
        // The Mini App shows a resolution dialog and re-saves.
        return res.status(409).json({ error: "conflict", conflicts: err.conflicts });
      }
      console.error(`[MiniApp${tag}] /profile POST error:`, err.message);
      return res.status(500).json({ error: "Internal error" });
    }
  });

  // Address autocomplete proxy (keeps the Google key server-side).
  app.get(`${prefix}/places`, async (req, res) => {
    try { verifyInitData(req.query.initData || ""); }
    catch (err) { return res.status(401).json({ error: err.message }); }
    try {
      const { autocomplete } = require("./googlePlaces");
      const suggestions = await autocomplete(req.query.q || "");
      return res.json({ suggestions });
    } catch (err) {
      console.error(`[MiniApp${tag}] /places error:`, err.message);
      return res.json({ suggestions: [] });
    }
  });

  // Full tag list for the profile tag-picker (popular first).
  app.get(`${prefix}/labels`, async (req, res) => {
    try { verifyInitData(req.query.initData || ""); }
    catch (err) { return res.status(401).json({ error: err.message }); }
    try {
      const { getPopularLabelNames } = require("./labelStore");
      const labels = await getPopularLabelNames(300);
      return res.json({ labels });
    } catch (err) {
      console.error(`[MiniApp${tag}] /labels error:`, err.message);
      return res.status(500).json({ error: "Internal error" });
    }
  });

  // ── Saved searches (Mini App) ──────────────────────────────────────
  app.get(`${prefix}/saved`, async (req, res) => {
    let identity;
    try { identity = verifyInitData(req.query.initData || ""); }
    catch (err) { return res.status(401).json({ error: err.message }); }
    try {
      const list = await listSavedSearches(identity.telegramId);
      return res.json({ saved: list || [] });
    } catch (err) {
      console.error(`[MiniApp${tag}] /saved GET error:`, err.message);
      return res.status(500).json({ error: "Internal error" });
    }
  });

  app.post(`${prefix}/saved`, async (req, res) => {
    let identity;
    try { identity = verifyInitData(req.body?.initData || ""); }
    catch (err) { return res.status(401).json({ error: err.message }); }
    try {
      const filters = parseSearchFilters(req.body?.filters || {});
      const snapshot = filtersToSaveSnapshot(filters, req.body?.label);
      const saved = await createSavedSearch(identity.telegramId, snapshot);
      return res.json({ ok: true, saved });
    } catch (err) {
      console.error(`[MiniApp${tag}] /saved POST error:`, err.message);
      return res.status(500).json({ error: "Internal error" });
    }
  });

  app.post(`${prefix}/saved/archive`, async (req, res) => {
    let identity;
    try { identity = verifyInitData(req.body?.initData || ""); }
    catch (err) { return res.status(401).json({ error: err.message }); }
    const id = req.body?.id;
    if (!id) return res.status(400).json({ error: "Missing id" });
    try {
      await archiveSavedSearch(id, identity.telegramId);
      return res.json({ ok: true });
    } catch (err) {
      console.error(`[MiniApp${tag}] /saved/archive error:`, err.message);
      return res.status(500).json({ error: "Internal error" });
    }
  });
}

function buildApp({ bot } = {}) {
  const app = express();
  app.use(express.json());

  const publicDir = path.join(__dirname, "..", "public");
  app.use("/miniapp", express.static(publicDir));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", time: new Date().toISOString() });
  });

  registerMiniAppRoutes(app, {
    prefix: "/miniapp",
    verifyInitData: miniAppAuth.verify,
    logLabel: "",
    bot,
  });

  app.get("/oauth/google/callback", async (req, res) => {
    const { code, state, error } = req.query;
    if (error) {
      console.warn(`[OAuth] callback denied: ${error}`);
      res.status(400).type("html").send(renderErrorHtml(String(error)));
      return;
    }
    if (!code || !state) {
      res.status(400).type("html").send(renderErrorHtml("Missing code/state"));
      return;
    }
    const telegramId = String(state);
    try {
      const tokens = await exchangeCodeForTokens(String(code));
      if (!tokens?.access_token) {
        throw new Error("Google did not return access_token");
      }
      await persistTokens(telegramId, tokens);
      // Best-effort confirmation back to the user in Telegram so they
      // don't have to alt-tab back to find out it worked.
      if (bot?.telegram) {
        try {
          await bot.telegram.sendMessage(
            telegramId,
            "✅ Google Calendar מחובר. עכשיו אפשר להוסיף אירועים ליומן מתוך הניוזלטר.",
          );
        } catch (err) {
          console.warn(`[OAuth] confirm send failed: ${err.message}`);
        }
      }
      res.status(200).type("html").send(renderSuccessHtml());
    } catch (err) {
      console.error(`[OAuth] callback failed: ${err.message}`);
      res.status(500).type("html").send(renderErrorHtml(err.message));
    }
  });

  return app;
}

function start({ bot } = {}) {
  // PORT comes from Railway / local dev. When unset we still start
  // (default to 3000) so a local-dev run can reach the callback via
  // ngrok or similar.
  const port = parseInt(process.env.PORT || "3000", 10);
  const app = buildApp({ bot });
  const server = app.listen(port, () => {
    console.log(`[OAuth] server listening on :${port}`);
  });
  return server;
}

module.exports = {
  start,
  buildApp,
  buildAuthUrl,
  exchangeCodeForTokens,
  persistTokens,
};
