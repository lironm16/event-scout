// Optional LangSmith tracing.
//
// When `LANGCHAIN_API_KEY` is set, every wrapped function call streams to
// https://smith.langchain.com so each agent turn can be inspected end-to-end:
// the prompts, the function calls Gemini issued, the tool args + results,
// and timing per step. When the key is NOT set, `trace(fn)` returns `fn`
// unchanged — zero overhead, no network, no dependency on the SDK at runtime.
//
// We deliberately avoid throwing if the SDK fails to load: tracing is purely
// observability, never on the critical path. A failure here logs a warning
// and the bot keeps running.

const HAS_KEY = !!process.env.LANGCHAIN_API_KEY;

// LangSmith reads these env vars to decide whether to send + which project
// to write to. Only set sensible defaults when they're not already provided
// by the operator (tests / CI sometimes pin them explicitly).
if (HAS_KEY) {
  if (!process.env.LANGCHAIN_TRACING_V2 && !process.env.LANGSMITH_TRACING) {
    process.env.LANGCHAIN_TRACING_V2 = "true";
  }
  if (!process.env.LANGCHAIN_PROJECT && !process.env.LANGSMITH_PROJECT) {
    process.env.LANGCHAIN_PROJECT = "event-scout";
  }
}

let traceableImpl = null;
if (HAS_KEY) {
  try {
    traceableImpl = require("langsmith/traceable").traceable;
    console.log(
      `[LangSmith] tracing enabled (project=${process.env.LANGCHAIN_PROJECT || process.env.LANGSMITH_PROJECT})`,
    );
  } catch (err) {
    console.warn("[LangSmith] SDK load failed — tracing disabled:", err.message);
  }
}

/**
 * Wrap an async function so its calls become runs in LangSmith.
 *
 * `opts.name` and `opts.run_type` ("chain" | "llm" | "tool" | "retriever")
 * are forwarded to the SDK. When tracing is disabled, returns `fn` itself
 * so callers never have to branch on whether the integration is on.
 *
 * Errors during wrap (e.g. SDK regression) downgrade gracefully: we log
 * once and return the unwrapped function. Tracing is observability, never
 * the critical path.
 */
function trace(fn, opts = {}) {
  if (!traceableImpl) return fn;
  try {
    return traceableImpl(fn, opts);
  } catch (err) {
    console.warn(`[LangSmith] wrap failed for "${opts.name || "anon"}":`, err.message);
    return fn;
  }
}

module.exports = { trace, enabled: !!traceableImpl };
