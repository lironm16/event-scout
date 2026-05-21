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

/**
 * Verify Telegram initData and return the extracted user payload.
 *
 * @param {string} initData  Raw URL-encoded initData string from the Mini App.
 * @returns {{ telegramId: string, firstName: string, lastName: string|null, username: string|null }}
 * @throws {Error} if the signature is invalid, data is expired, or malformed.
 */
function verify(initData) {
  if (!initData) throw new Error("Missing initData");

  const botToken = process.env.TELEGRAM_TOKEN;
  if (!botToken) throw new Error("TELEGRAM_TOKEN not configured");

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) throw new Error("initData missing hash");

  // Build the data-check string: all fields except "hash", sorted by key.
  params.delete("hash");
  const dataCheckString = Array.from(params.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  // Compute expected hash.
  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest();
  const expectedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  if (expectedHash !== hash) throw new Error("initData signature invalid");

  // Reject stale data.
  const authDate = parseInt(params.get("auth_date") || "0", 10);
  const ageSeconds = Math.floor(Date.now() / 1000) - authDate;
  if (ageSeconds > MAX_AGE_SECONDS) {
    throw new Error(`initData expired (${Math.round(ageSeconds / 60)} min old)`);
  }

  // Parse the user JSON embedded in the "user" field.
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

module.exports = { verify };
