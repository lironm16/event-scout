// Google Calendar insertion + automatic token refresh.
//
// Two responsibilities:
//   1. `getValidAccessToken(telegramId)` — return a token good for at
//      least the next ~60s. Refreshes lazily via the user's stored
//      refresh_token when the cached access_token is near expiry.
//   2. `insertEvents(telegramId, events)` — push N event rows to the
//      user's primary Google Calendar. Returns a summary {inserted,
//      failed} so the caller can render an aggregate confirmation.
//
// We deliberately stay close to the raw REST API (no `googleapis`
// package). The Calendar Events insert endpoint is a single POST and
// the OAuth refresh is a single POST — pulling in the SDK would add
// ~3MB of dependencies for two endpoints we already use via axios
// elsewhere.

const axios = require("axios");
const supabase = require("./supabase");

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const CAL_INSERT_URL =
  "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const REFRESH_LEEWAY_MS = 60_000; // refresh if <60s left
const TZ = "Asia/Jerusalem";

async function loadTokens(telegramId) {
  const { data, error } = await supabase
    .from("google_oauth_tokens")
    .select("telegram_id, access_token, refresh_token, expires_at, scope")
    .eq("telegram_id", String(telegramId))
    .maybeSingle();
  if (error) {
    if (error.code === "42P01" || error.code === "PGRST205") return null;
    throw new Error(`loadTokens failed: ${error.message}`);
  }
  return data || null;
}

async function persistRefresh(telegramId, newAccessToken, expiresInSec, scope) {
  const expiresAt = new Date(Date.now() + expiresInSec * 1000).toISOString();
  const row = {
    telegram_id: String(telegramId),
    access_token: newAccessToken,
    expires_at: expiresAt,
    updated_at: new Date().toISOString(),
  };
  if (scope) row.scope = scope;
  const { error } = await supabase
    .from("google_oauth_tokens")
    .update(row)
    .eq("telegram_id", String(telegramId));
  if (error) throw new Error(`persistRefresh failed: ${error.message}`);
}

async function refreshAccessToken(refreshToken) {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_OAUTH_CLIENT_ID / _CLIENT_SECRET not set");
  }
  const res = await axios.post(
    GOOGLE_TOKEN_URL,
    new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }).toString(),
    {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 15_000,
    },
  );
  return res.data;
}

async function getValidAccessToken(telegramId) {
  const tokens = await loadTokens(telegramId);
  if (!tokens) return null;
  const expiresAt = new Date(tokens.expires_at).getTime();
  if (Number.isFinite(expiresAt) && expiresAt - Date.now() > REFRESH_LEEWAY_MS) {
    return tokens.access_token;
  }
  // Refresh needed. If there's no refresh_token (rare — happens
  // when the user revoked offline access mid-session) we have no way
  // to mint a new access token without prompting them again. Signal
  // null and let the caller route them through /connect_calendar.
  if (!tokens.refresh_token) {
    console.warn(
      `[Calendar] refresh_token missing for user ${telegramId} — re-auth needed`,
    );
    return null;
  }
  try {
    const refreshed = await refreshAccessToken(tokens.refresh_token);
    if (!refreshed?.access_token) {
      console.warn(`[Calendar] refresh returned no access_token`);
      return null;
    }
    await persistRefresh(
      telegramId,
      refreshed.access_token,
      Number(refreshed.expires_in) || 3600,
      refreshed.scope || tokens.scope,
    );
    return refreshed.access_token;
  } catch (err) {
    // 400 invalid_grant typically means the refresh token was
    // revoked (user removed our app from their Google account).
    // Clear the stored row so the next attempt routes through
    // /connect_calendar fresh.
    const respData = err?.response?.data || {};
    if (respData.error === "invalid_grant") {
      console.warn(
        `[Calendar] refresh failed (invalid_grant) for ${telegramId} — clearing stored token`,
      );
      try {
        await supabase
          .from("google_oauth_tokens")
          .delete()
          .eq("telegram_id", String(telegramId));
      } catch (delErr) {
        console.warn(`[Calendar] token delete failed: ${delErr.message}`);
      }
    } else {
      console.error(`[Calendar] refresh failed: ${err.message}`);
    }
    return null;
  }
}

// Format an event for the Calendar insert payload. We use dateTime
// (start + end) with an explicit timeZone — Asia/Jerusalem matches
// our event source. When the event lacks an explicit end_time we
// default to start+1h, which is the conservative choice that won't
// cover the user's whole day with a single ambiguous block.
function eventToCalendarBody(event) {
  if (!event?.date) return null;
  const startISO = combineDateTime(event.date, event.start_time || "00:00");
  if (!startISO) return null;
  const endISO = event.end_time
    ? combineDateTime(event.date, event.end_time)
    : addMinutesISO(startISO, 60);
  const summary = event.name || "אירוע";
  const description = buildDescription(event);
  return {
    summary,
    description,
    location: event.location || undefined,
    start: { dateTime: startISO, timeZone: TZ },
    end: { dateTime: endISO || startISO, timeZone: TZ },
    reminders: { useDefault: true },
    // Source link — Google renders this as a small "open" affordance
    // on the event card in Calendar, so a tap from the calendar
    // jumps back to the booking page.
    source: tryBuildSource(event),
  };
}

function combineDateTime(date, time) {
  if (!date || !time) return null;
  // Both are local-Israel values; assemble an ISO 8601 string WITHOUT
  // a UTC offset and let Calendar respect the `timeZone` field above.
  // RFC 3339 with no offset is the format Calendar expects when a
  // `timeZone` is provided.
  return `${date}T${normaliseTime(time)}:00`;
}

function normaliseTime(time) {
  // Accept "HH:MM", "HH:MM:SS", or "H:MM". Normalise to "HH:MM".
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(time).trim());
  if (!m) return "00:00";
  const hh = m[1].padStart(2, "0");
  return `${hh}:${m[2]}`;
}

function addMinutesISO(iso, minutes) {
  // The iso here has no Z — treat as a local-time string and just add
  // minutes naively at the string level. We pass it through Date for
  // arithmetic but the timezone field on Calendar's payload anchors
  // the absolute time, so this "naive" math is correct as long as
  // start and end use the same tz.
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  const next = new Date(t + minutes * 60_000);
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}` +
    `T${pad(next.getHours())}:${pad(next.getMinutes())}:00`
  );
}

function buildDescription(event) {
  const lines = [];
  if (Array.isArray(event?.tags) && event.tags.length) {
    lines.push(`תגיות: ${event.tags.join(" • ")}`);
  }
  if (event?.tickets_left != null && event.tickets_left > 0) {
    lines.push(`כרטיסים זמינים: ${event.tickets_left}`);
  }
  lines.push("");
  lines.push("הוזן אוטומטית מ‑Event Scout 🤖");
  return lines.join("\n");
}

function tryBuildSource(event) {
  try {
    const { getBookingUrl } = require("./sourceUrls");
    const url = getBookingUrl(event);
    if (!url) return undefined;
    return { url, title: event.name || "Event" };
  } catch {
    return undefined;
  }
}

async function insertEvents(telegramId, events) {
  if (!Array.isArray(events) || !events.length) {
    return { inserted: 0, failed: 0 };
  }
  const accessToken = await getValidAccessToken(telegramId);
  if (!accessToken) {
    return { inserted: 0, failed: events.length, reason: "not_connected" };
  }

  let inserted = 0;
  let failed = 0;
  for (const event of events) {
    const body = eventToCalendarBody(event);
    if (!body) {
      failed++;
      continue;
    }
    try {
      await axios.post(CAL_INSERT_URL, body, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        timeout: 15_000,
      });
      inserted++;
    } catch (err) {
      failed++;
      console.warn(
        `[Calendar] insert failed event=${event.id}: ${err.response?.data?.error?.message || err.message}`,
      );
    }
  }
  return { inserted, failed };
}

module.exports = {
  getValidAccessToken,
  insertEvents,
  // Exported for unit testing.
  eventToCalendarBody,
};
