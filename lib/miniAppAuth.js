// Telegram Mini App — initData verification
//
// When a Telegram Mini App is opened, Telegram injects
// `window.Telegram.WebApp.initData` — a URL-encoded string containing
// user info, a hash, and a timestamp.  The hash is an HMAC-SHA256
// signature that lets our backend confirm the data really came from
// Telegram (not a spoofed request).
//
// Algorithm (from Telegram docs):
//   1. secret_key = HMAC-SHA256("WebAppData", bot_token)
//   2. data_check_string = all key=value pairs (excluding "hash") sorted
//      alphabetically and joined by "\n"
//   3. expected_hash = HMAC-SHA256(data_check_string, secret_key)
//   4. expected_hash must equal the "hash" field in initData
//
// We also reject initData older than MAX_AGE_SECONDS to limit replay
// attacks (Telegram's own guidance).

const crypto = require("crypto");

const MAX_AGE_SECONDS = 3 * 60 * 60; // 3 hours

function collectVerifyTokens() {
  const out = [];
  const primary = process.env.TELEGRAM_TOKEN?.trim();
  if (primary) out.push(primary);
  const extra = process.env.TELEGRAM_MINIAPP_EXTRA_TOKENS || "";
  for (const part of extra.split(",")) {
    const t = part.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

function verifyWithToken(initData, botToken) {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) throw new Error("initData missing hash");

  params.delete("hash");
  const dataCheckString = Array.from(params.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest();
  const expectedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  if (expectedHash !== hash) throw new Error("initData signature invalid");

  const authDate = parseInt(params.get("auth_date") || "0", 10);
  const ageSeconds = Math.floor(Date.now() / 1000) - authDate;
  if (ageSeconds > MAX_AGE_SECONDS) {
    throw new Error(`initData expired (${Math.round(ageSeconds / 60)} min old)`);
  }

  let user;
  try {
    user = JSON.parse(params.get("user") || "{}");
  } catch {
    throw new Error("initData.user is not valid JSON");
  }
  if (!user.id) throw new Error("initData.user missing id");

  return {
    telegramId: String(user.id),
    firstName: user.first_name || "",
    lastName: user.last_name || null,
    username: user.username || null,
  };
}

/**
 * Verify Telegram initData and return the extracted user payload.
 *
 * Tries TELEGRAM_TOKEN first, then any comma-separated tokens in
 * TELEGRAM_MINIAPP_EXTRA_TOKENS (e.g. a dev @BotFather token when the
 * Mini App is hosted on Railway but opened from a local dev bot).
 *
 * @param {string} initData  Raw URL-encoded initData string from the Mini App.
 * @returns {{ telegramId: string, firstName: string, lastName: string|null, username: string|null }}
 * @throws {Error} if the signature is invalid, data is expired, or malformed.
 */
function verify(initData) {
  if (!initData) throw new Error("Missing initData");

  const tokens = collectVerifyTokens();
  if (!tokens.length) throw new Error("TELEGRAM_TOKEN not configured");

  let lastErr = null;
  for (const botToken of tokens) {
    try {
      return verifyWithToken(initData, botToken);
    } catch (err) {
      lastErr = err;
      // Wrong bot token — try the next one. Any other error (expired,
      // malformed) is definitive; don't mask it behind "invalid signature".
      if (err.message !== "initData signature invalid") throw err;
    }
  }
  throw lastErr || new Error("initData signature invalid");
}

module.exports = { verify, verifyWithToken };
