// Google Routes API — accurate walking / driving travel-time estimates
// between two coordinates.
//
// Why an API call instead of an in-process heuristic?
//   The previous approach used haversine (great-circle distance) × a
//   constant speed/circuity ratio. That's good enough to decide
//   "walkable vs car", but the actual minute count drifts by 30-100%
//   from Google's own ETA — one user reported 6 vs 13 (walk) and 11
//   vs 19 (drive). Hard to defend "13 דק' הליכה" on a card when Google
//   Maps says 19. Routes API uses the real road network plus current
//   traffic, so the number on the card matches what the user sees
//   when they tap "🧭 נווט".
//
// Cost:
//   The "Compute Routes" basic mode is $5/1000 calls. Maps Platform
//   gives $200/month free credit = 40,000 free calls/month. With our
//   in-process cache + at most 5 cards per turn × walk-OR-drive (not
//   both), realistic load is ~hundreds of calls/day — solidly free.
//
// API key:
//   Reuses GOOGLE_PLACES_API_KEY (same Google Cloud project). The
//   Routes API must also be ENABLED in the GCP console for that
//   project, alongside Places. Without enablement the request comes
//   back as 403 and we silently fall back to the heuristic.
//
// Cache:
//   In-process Map keyed by origin+dest+mode at 4-decimal precision
//   (~11 m, plenty for routing). The user's home rarely changes; the
//   venue list is bounded (~50-100 unique venues across all events).
//   Cache hit rate after warmup is essentially 100%.

const axios = require("axios");
const sentry = require("./sentry");

const ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";
const TIMEOUT_MS = 5000;
const apiKey = process.env.GOOGLE_PLACES_API_KEY || null;

// Process-wide circuit breaker for PERMANENT API failures (Routes API
// not enabled on the GCP project, bad/expired API key, …). When the
// first 401/403 lands we flip the flag, log once, ping Sentry once,
// and short-circuit every subsequent call without an HTTP round-trip.
//
// Why: the per-(origin,dest,mode) cache only suppresses repeat calls
// to the SAME route. A user's first turn typically queries 5-10 unique
// routes, each one separately hitting the API, each one separately
// warning. That's 5-10 lines of noise per turn for a problem the
// operator can't fix without manual GCP action. The breaker collapses
// that to ONE log + ONE Sentry alert per process lifetime.
//
// The breaker is intentionally NOT reset on its own. If the operator
// enables the API mid-run, restarting the bot picks it back up — the
// alternative (probe every N minutes) wastes calls for a transient
// state that practically never happens.
let _disabled = false;
let _disabledReason = null;

// Transient quota / rate-limit (HTTP 429). Unlike 401/403 we auto-
// recover after a cooldown so a monthly quota reset or QPM window
// rollover doesn't require a process restart.
const QUOTA_COOLDOWN_MS = 15 * 60 * 1000;
let _quotaPausedUntil = 0;
let _quotaWarned = false;

// Round to 4 decimals (~11 m). Keys quantize at this precision so two
// "essentially identical" coordinate pairs hit the same cache slot.
function quantize(n) {
  return Math.round(n * 10000) / 10000;
}

// Map our mode strings to Routes API's enum + the field name we care
// about. Routes API supports DRIVE / WALK / BICYCLE / TWO_WHEELER /
// TRANSIT — we only need the first two.
const MODE_MAP = {
  walk: "WALK",
  drive: "DRIVE",
};

const cache = new Map();

function cacheKey(origin, dest, mode) {
  return `${quantize(origin.lat)},${quantize(origin.lng)}->${quantize(dest.lat)},${quantize(dest.lng)}|${mode}`;
}

function isEnabled() {
  return Boolean(apiKey);
}

/**
 * Compute travel time between two coordinates in the requested mode.
 *
 * @param {{lat:number,lng:number}} origin
 * @param {{lat:number,lng:number}} destination
 * @param {"walk"|"drive"} mode
 * @returns {Promise<number|null>}  Minutes (rounded) on success;
 *   `null` on any failure (no key, invalid coords, network error,
 *   non-200 response, missing route field). Callers MUST fall back
 *   to a heuristic — never display "0 דק'" because we got null.
 */
async function computeTravelMinutes(origin, destination, mode) {
  if (!apiKey) return null;
  // Honor the circuit breaker BEFORE the input-shape checks so we
  // don't accidentally re-enable callers via a malformed input that
  // returns null for an unrelated reason.
  if (_disabled) return null;
  if (Date.now() < _quotaPausedUntil) return null;
  if (!origin?.lat || !origin?.lng) return null;
  if (!destination?.lat || !destination?.lng) return null;

  const apiMode = MODE_MAP[mode];
  if (!apiMode) return null;

  const key = cacheKey(origin, destination, mode);
  if (cache.has(key)) return cache.get(key);

  try {
    const { data, status } = await axios.post(
      ROUTES_URL,
      {
        origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } },
        destination: { location: { latLng: { latitude: destination.lat, longitude: destination.lng } } },
        travelMode: apiMode,
        // Don't ask for alternatives — saves response weight and we'd
        // pick the primary one anyway.
        computeAlternativeRoutes: false,
        // Routes API requires routingPreference for DRIVE; WALK ignores
        // it. TRAFFIC_AWARE is the cheap tier and gives us live ETAs.
        ...(apiMode === "DRIVE" ? { routingPreference: "TRAFFIC_AWARE" } : {}),
      },
      {
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          // FieldMask is REQUIRED by Routes API. Without it the request
          // 400s. We only need the duration string.
          "X-Goog-FieldMask": "routes.duration,routes.distanceMeters",
        },
        timeout: TIMEOUT_MS,
        validateStatus: (s) => s < 500,
      },
    );
    if (status !== 200) {
      // Classify the failure mode.
      //   401 / 403 → permanent for this process (key invalid / API
      //               not enabled / billing missing). Trip the
      //               circuit breaker so every future call short-
      //               circuits cleanly to the heuristic.
      //   400       → malformed payload (our bug). Cache the null
      //               for THIS route but keep trying others — other
      //               coord pairs might be fine.
      //   429       → quota exceeded. Cache and move on; the next
      //               cycle's calls will hit cache too if we keep
      //               failing. Could in principle be transient, so
      //               we don't trip the breaker.
      //   anything else < 500 → unknown; treat like 400.
      if (status === 401 || status === 403) {
        _tripCircuitBreaker(status, data);
      } else if (status === 429) {
        _pauseForQuota(data);
      } else {
        console.warn(
          `[Routes] API responded ${status} for ${mode}: ${JSON.stringify(data).slice(0, 160)}`,
        );
      }
      cache.set(key, null);
      return null;
    }
    const route = data?.routes?.[0];
    const durationStr = route?.duration; // e.g. "1234s"
    if (!durationStr) {
      cache.set(key, null);
      return null;
    }
    // Routes API returns ISO 8601 duration as a string suffixed with "s".
    const seconds = parseInt(String(durationStr).replace(/s$/, ""), 10);
    if (!Number.isFinite(seconds)) {
      cache.set(key, null);
      return null;
    }
    const minutes = Math.max(1, Math.round(seconds / 60));
    cache.set(key, minutes);
    return minutes;
  } catch (err) {
    console.warn(`[Routes] request failed (${mode}): ${err.message}`);
    return null;
  }
}

// Flip the breaker and emit a single operator-facing log + Sentry
// alert. Safe to call multiple times — only the first call does
// anything; subsequent ones are no-ops.
function _pauseForQuota(body) {
  _quotaPausedUntil = Date.now() + QUOTA_COOLDOWN_MS;
  if (_quotaWarned) return;
  _quotaWarned = true;
  const apiMessage =
    (body && body.error && body.error.message) ||
    (typeof body === "string" ? body : JSON.stringify(body || {})).slice(0, 200);
  console.warn(
    `[Routes] Google Routes quota/rate limit hit (429) — ${apiMessage}. ` +
      `Using straight-line ETAs for ~${Math.round(QUOTA_COOLDOWN_MS / 60000)} minutes, ` +
      `then retrying. Bulk search filters already skip the API; card labels may be approximate.`,
  );
  sentry.captureAlert({
    severity: "warning",
    code: "routes_api_quota",
    message: apiMessage,
    context: { cooldownMinutes: Math.round(QUOTA_COOLDOWN_MS / 60000) },
  });
}

function _tripCircuitBreaker(status, body) {
  if (_disabled) return;
  _disabled = true;
  // Pull the human-readable bit out of Google's error envelope. The
  // typical shape is { error: { code, message, status } }.
  const apiMessage =
    (body && body.error && body.error.message) ||
    (typeof body === "string" ? body : JSON.stringify(body || {})).slice(0, 200);
  _disabledReason = `HTTP ${status}: ${apiMessage}`;

  console.warn(
    `[Routes] Google Routes API disabled for this process — ` +
      `${_disabledReason}. ` +
      `Falling back to haversine-based heuristic for all future requests. ` +
      `To restore real ETAs, enable the Routes API at ` +
      `https://console.cloud.google.com/apis/library/routes.googleapis.com ` +
      `for your GCP project, then restart the bot.`,
  );

  // One-shot Sentry alert so the operator sees this in their alert
  // feed without grepping logs. `severity: warning` because the bot
  // still works (heuristic distance is acceptable), it's just a
  // degraded mode. The `code` tag groups all instances of this
  // failure into one Sentry issue.
  sentry.captureAlert({
    severity: "warning",
    code: "routes_api_disabled",
    message: _disabledReason,
    context: {
      url: ROUTES_URL,
      status,
      // Surface the enable URL on the issue so the fix is a click
      // away — no need to dig through code to find what to enable.
      enableUrl:
        "https://console.cloud.google.com/apis/library/routes.googleapis.com",
    },
  });
}

module.exports = {
  isEnabled,
  computeTravelMinutes,
  // Exposed only for tests.
  _cache: cache,
  _isDisabled: () => _disabled,
  _resetDisabled: () => {
    _disabled = false;
    _disabledReason = null;
    _quotaPausedUntil = 0;
    _quotaWarned = false;
  },
};
