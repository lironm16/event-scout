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
const { getAllEvents } = require("../bot/matchingService");
const { deriveDefaultAudienceSet } = require("./categories");
const { formatHebrewDate, formatTimeRange, formatAudienceLine, getEventIcon } = require("./eventFormat");
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

function buildApp({ bot } = {}) {
  const app = express();

  // Serve static Mini App files from the `public/` folder next to this
  // module's parent directory (i.e. project root / public).
  const publicDir = path.join(__dirname, "..", "public");
  app.use("/miniapp", express.static(publicDir));

  // Health check — used by Railway to verify the worker is up.
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", time: new Date().toISOString() });
  });

  // ─── GET /miniapp/events ──────────────────────────────────────────────
  // Returns a personalized, ranked list of upcoming events for the user
  // identified by the Telegram initData passed in the `initData` query param.
  //
  // Query params:
  //   initData   (required) — raw URL-encoded Telegram initData string
  //   audience   (optional) — override audience filter: kids/family/adults/teens/toddlers/parents/all
  //   category   (optional) — filter by Hebrew category string (e.g. "סדנה")
  //   dateFrom   (optional) — YYYY-MM-DD lower bound
  //   dateTo     (optional) — YYYY-MM-DD upper bound
  app.get("/miniapp/events", async (req, res) => {
    // Verify identity.
    let identity;
    try {
      identity = miniAppAuth.verify(req.query.initData || "");
    } catch (err) {
      return res.status(401).json({ error: err.message });
    }

    try {
      const { telegramId, firstName } = identity;

      // Load profile (nullable — new users won't have one yet).
      let profile = null;
      try { profile = await getProfile(telegramId); } catch {}

      const prefs = profile?.user_context?.preferences || null;

      // Determine which community scopes this user can access.
      const communities = profile?.user_context?.communities || {};
      const accessScopes = ["open"];
      for (const [key, val] of Object.entries(communities)) {
        if (val === "member") accessScopes.push(key);
      }

      // Fetch events.
      const events = await getAllEvents({
        futureOnly: true,
        dateFrom: req.query.dateFrom || null,
        dateTo: req.query.dateTo || null,
        accessScopes,
      });

      // Derive default audience set (same rule as bot).
      const defaultAudienceSet = deriveDefaultAudienceSet(profile);

      // Apply audience filter.
      const audienceParam = req.query.audience || null;
      let filtered = events;
      if (audienceParam && audienceParam !== "all") {
        // Map from English key to Hebrew ENUM value.
        const AUDIENCE_HE = {
          toddlers: "תינוקות",
          kids: "ילדים",
          teens: "נוער",
          parents: "הורים",
          adults: "מבוגרים",
          family: "לכל המשפחה",
        };
        const targetHe = AUDIENCE_HE[audienceParam];
        if (targetHe) {
          filtered = events.filter(
            (e) => !e.audience || e.audience === targetHe || e.audience === "לכל המשפחה",
          );
        }
      } else if (!audienceParam) {
        // Default: profile-derived audience set.
        filtered = events.filter(
          (e) => !e.audience || defaultAudienceSet.has(e.audience),
        );
      }

      // Apply category filter.
      if (req.query.category) {
        filtered = filtered.filter(
          (e) => e.category === req.query.category,
        );
      }

      // Serialize + score + sort.
      const serialized = filtered.map((e) => {
        const s = serializeEvent(e);
        s._score = computePreferenceScore(e, prefs);
        return s;
      });

      // Sort: one-time before recurring, then by date, then preference score desc.
      serialized.sort((a, b) => {
        if (a.date !== b.date) return a.date < b.date ? -1 : 1;
        if (b._score !== a._score) return b._score - a._score;
        return a.id - b.id;
      });

      // Expose user's saved interests as filter chips in the Mini App.
      const interests = profile?.user_context?.interests || [];

      return res.json({
        profile: { firstName, telegramId, interests },
        total: serialized.length,
        events: serialized,
      });
    } catch (err) {
      console.error("[MiniApp] /events error:", err.message);
      return res.status(500).json({ error: "Internal error" });
    }
  });

  // ─── POST /miniapp/signal ─────────────────────────────────────────────
  // Records a user interaction signal (interest / not-interested).
  // Body (JSON): { initData, eventId, signal: "interest"|"not_interested" }
  app.use(express.json());
  app.post("/miniapp/signal", async (req, res) => {
    let identity;
    try {
      identity = miniAppAuth.verify(req.body?.initData || "");
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
      console.error("[MiniApp] /signal error:", err.message);
      return res.status(500).json({ error: "Internal error" });
    }
  });

  // ─── POST /miniapp/report ─────────────────────────────────────────────
  // Records an operator-facing quality report from the Mini App.
  // Body (JSON): { initData, eventId, issueType, note? }
  app.post("/miniapp/report", async (req, res) => {
    const VALID_TYPES = ["wrong_audience","wrong_category","bad_description","duplicate","wrong_time","other"];
    let telegramId = null;
    try {
      // Auth is optional — allow unauthenticated reports but record identity when available.
      if (req.body?.initData) {
        try { telegramId = miniAppAuth.verify(req.body.initData).telegramId; } catch {}
      }
      const { eventId, issueType, note } = req.body || {};
      if (!eventId)                          return res.status(400).json({ error: "Missing eventId" });
      if (!VALID_TYPES.includes(issueType))  return res.status(400).json({ error: "Invalid issueType" });

      const { error: dbErr } = await supabase.from("event_reports").insert({
        event_id:   Number(eventId),
        telegram_id: telegramId,
        issue_type: issueType,
        note:       note?.slice(0, 500) || null,
      });
      if (dbErr) throw new Error(dbErr.message);

      // Notify admin in Telegram (fire-and-forget)
      if (bot?.telegram) {
        const { data: ev } = await supabase.from("events").select("name").eq("id", Number(eventId)).maybeSingle();
        const ISSUE_LABELS = {
          wrong_audience:  "קהל יעד שגוי",
          wrong_category:  "סיווג / תגיות שגויים",
          bad_description: "תיאור חסר או שגוי",
          duplicate:       "אירוע כפול",
          wrong_time:      "שעה / תאריך שגויים",
          other:           "אחר",
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
            .catch(e => console.warn("[MiniApp] report notify failed:", e.message));
        }
      }

      return res.json({ ok: true });
    } catch (err) {
      console.error("[MiniApp] /report error:", err.message);
      return res.status(500).json({ error: "Internal error" });
    }
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
