// Sentry integration — central error monitoring.
//
// Why Sentry over the (already wired) Telegram admin pings:
//   The pings are great for "tell me NOW" — they land on the phone
//   within seconds. But they're a chat log. As soon as you have
//   three bugs flying around they're impossible to triage from
//   scrolling history. Sentry adds the missing UI: issue grouping
//   (same fingerprint = one row with a count), occurrence rate,
//   per-user breakdown, search/filter, and an "ignored" / "resolved"
//   workflow so handled bugs stop nagging you.
//
// Why both, not Sentry-only:
//   Sentry's free tier delivery latency is fine but not instant, and
//   you check it on a laptop, not a phone. Keeping the Telegram ping
//   gives "wake up if something's on fire", while Sentry gives "what
//   actually happened today / this week / per user / per code". The
//   two channels carry the same payload so nothing is lost if either
//   side flakes.
//
// Init contract:
//   • Set SENTRY_DSN in .env to enable. Unset = silent no-op (good
//     for local dev). All capture functions short-circuit when
//     disabled, so call sites don't need their own guard.
//   • SENTRY_ENVIRONMENT defaults to NODE_ENV (or "development"
//     when neither is set). Override per-deploy ("staging",
//     "production") so issues land in separate Sentry views.
//   • TRACES_SAMPLE_RATE defaults to 0.1 — keeps free-tier
//     transaction budget honest. Bump locally with SENTRY_TRACES_SAMPLE_RATE
//     when debugging.
//
// Defensive load:
//   `@sentry/node` is a runtime dep, but the module must not crash
//   the bot if the install is broken (or the dep was somehow pruned
//   in a deployment image). We require it inside try/catch and fall
//   back to a no-op surface — same shape as `lib/langsmith.js`.

let Sentry = null;
let initialized = false;

function init() {
  if (initialized) return;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    // Stay quiet in local dev where the operator deliberately
    // doesn't run Sentry. The Telegram channel and console logs
    // still work.
    return;
  }
  try {
    Sentry = require("@sentry/node");
  } catch (err) {
    console.warn(
      `[Sentry] @sentry/node not installed (${err.message}); error monitoring disabled`,
    );
    return;
  }

  const environment =
    process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || "development";
  const release = process.env.SENTRY_RELEASE || undefined;
  const tracesSampleRate = Number.isFinite(
    parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE),
  )
    ? parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE)
    : 0.1;

  Sentry.init({
    dsn,
    environment,
    release,
    tracesSampleRate,
    // `@sentry/node` auto-installs OnUncaughtException and
    // OnUnhandledRejection — anything our code forgets to catch
    // still reaches Sentry without explicit wiring at the call site.
    // We leave those defaults on.
  });

  initialized = true;
  console.log(
    `[Sentry] enabled (env=${environment}${release ? ", release=" + release : ""})`,
  );
}

function isEnabled() {
  return initialized;
}

// Capture a structured alert (parallel to bot/telegramBot.js#alertAdmin).
//
// Shape mirrors alertAdmin so the bot can fan a single alert object
// out to both channels without re-shuffling fields.
//
//   captureAlert({
//     severity: "error" | "warning",
//     code:     "series_unrecoverable" | "unhandled_error" | ...,
//     message:  "human description",
//     error:    optional Error object (gives Sentry a real stack trace),
//     context:  { telegramId, eventId, ... }   (becomes the "alert" context),
//     traceId:  optional request-trace id (becomes a tag for linking),
//   })
function captureAlert({
  severity = "error",
  code,
  message = null,
  error = null,
  context = {},
  traceId = null,
}) {
  if (!initialized || !Sentry || !code) return;

  // Sentry's level names match our severity values exactly for the
  // two we use ("warning" / "error"). Compute once so both the scope
  // and the captureMessage fallback agree on the same value.
  const sentryLevel = severity === "warning" ? "warning" : "error";

  // withScope keeps tags/context local to this single capture instead
  // of leaking onto the global hub — important here because the bot
  // is long-running and concurrent.
  Sentry.withScope((scope) => {
    scope.setLevel(sentryLevel);
    scope.setTag("code", code);
    if (traceId) scope.setTag("trace_id", traceId);
    if (context.telegramId != null) {
      // Sentry's "user" panel filters/aggregates by id — sending the
      // Telegram numeric id makes per-user diagnosis trivial. We do
      // NOT send names; the bot doesn't have them in this scope and
      // we want to stay PII-light.
      scope.setUser({ id: String(context.telegramId) });
    }
    // Stash the full context object on the issue so the Sentry UI
    // shows it in the "Additional Data" panel verbatim.
    scope.setContext("alert", { code, message, ...context });

    if (error instanceof Error) {
      // captureException gives us a real stack trace and Sentry's
      // automatic grouping by stack frame. Strongly preferred when
      // a thrown Error is available.
      Sentry.captureException(error);
    } else {
      // No Error object — capture as a message. Sentry groups by the
      // message string, which is why we pin the `code` tag too: even
      // if message text drifts, `code:<x>` keeps issues clustered.
      Sentry.captureMessage(message || code, sentryLevel);
    }
  });
}

// Direct passthrough for code paths that just want to record an
// exception without going through alertAdmin (e.g. background jobs
// where there's no operator chat to ping). Kept thin on purpose.
function captureException(err, extra = {}) {
  if (!initialized || !Sentry) return;
  Sentry.withScope((scope) => {
    if (extra.code) scope.setTag("code", extra.code);
    if (extra.telegramId != null) scope.setUser({ id: String(extra.telegramId) });
    if (extra.context) scope.setContext("extra", extra.context);
    Sentry.captureException(err);
  });
}

module.exports = {
  init,
  isEnabled,
  captureAlert,
  captureException,
};
