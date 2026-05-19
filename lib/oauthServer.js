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

const express = require("express");
const axios = require("axios");
const supabase = require("./supabase");

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

function buildApp({ bot } = {}) {
  const app = express();

  // Health check — used by Railway to verify the worker is up.
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", time: new Date().toISOString() });
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
