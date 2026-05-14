const { randomUUID } = require("crypto");
const supabase = require("./supabase");

// Request-level execution tracing. Every text/button event from Telegram
// opens a trace; every Gemini call, Supabase query, or tool dispatch
// pushes a step into it. The trace is flushed to `request_traces` in
// real time (fire-and-forget UPDATEs), so an operator can pull the row
// mid-flight via `/debug <traceId>` and see exactly where execution is
// stuck.
//
// Architectural choices:
//   • In-memory map keyed by traceId is the source of truth. The DB
//     update is best-effort: if it fails (timeout, missing migration,
//     etc.) the trace still works locally and we surface the error
//     without breaking the actual user flow.
//   • Each addStep does a full `steps` JSONB rewrite rather than a
//     row-scoped append RPC. At ~10-30 steps per trace and small
//     payloads, this is well below latency budget and saves us writing
//     a Postgres function.
//   • Steps include `t_ms` (relative to trace start) so /debug can show
//     a flame-chart style breakdown without needing per-step timestamps.
//   • Sensitive payloads (full Gemini contents, API keys, etc.) are
//     truncated by the call sites — this module trusts what's passed.

const TRACE_TABLE = "request_traces";
const traces = new Map();

// Truncate large strings before serializing so we don't blow up the
// JSONB column with multi-KB Gemini transcripts. Per-step payloads stay
// useful for debugging while the table stays cheap to scan.
const STEP_VALUE_TRUNCATE = 4000;
const AI_PAYLOAD_TRUNCATE = 12000;

function safeStringify(value, cap) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  let str;
  try {
    str = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    str = String(value);
  }
  if (cap && str && str.length > cap) {
    return str.slice(0, cap) + `…[truncated ${str.length - cap}b]`;
  }
  return str;
}

function truncatePayload(payload, cap = AI_PAYLOAD_TRUNCATE) {
  if (!payload || typeof payload !== "object") return payload;
  // We re-encode to apply the cap uniformly across nested fields.
  const json = safeStringify(payload, cap);
  try {
    return JSON.parse(json);
  } catch {
    return { _raw: json };
  }
}

let _missingTableLogged = false;
function isMissingTableError(error) {
  if (!error) return false;
  const code = error.code || "";
  const msg = error.message || "";
  // Accept both raw-Postgres (42P01) and PostgREST (PGRST205 / "schema
  // cache") shapes. supabase-js almost always returns the latter,
  // since PostgREST resolves table names against its cache before
  // issuing SQL, so we never see the underlying SQLSTATE.
  const isMissing =
    code === "42P01" ||
    code === "PGRST205" ||
    /relation .* does not exist/i.test(msg) ||
    /Could not find the table .* in the schema cache/i.test(msg);
  if (!isMissing) return false;
  if (!_missingTableLogged) {
    _missingTableLogged = true;
    console.warn(
      "[Tracing] sql/024_request_traces.sql not applied — traces logged in memory only.",
    );
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────────────────

async function startTrace({ telegramId, inputText, kind = "text" }) {
  const id = randomUUID();
  const startedAt = Date.now();
  const trace = {
    id,
    telegramId: String(telegramId),
    inputText: inputText || null,
    kind,
    steps: [],
    aiPayload: null,
    outputText: null,
    error: null,
    startedAt,
    finishedAt: null,
  };
  traces.set(id, trace);

  // Insert the row eagerly so /debug works mid-flight. We DON'T await:
  // the UPDATE in addStep is racey-safe (Postgres handles it) and the
  // user shouldn't pay latency for trace I/O.
  const inputForDb = safeStringify(inputText, STEP_VALUE_TRUNCATE);
  supabase
    .from(TRACE_TABLE)
    .insert({
      id,
      telegram_id: String(telegramId),
      input_text: inputForDb,
      steps: [],
    })
    .then(({ error }) => {
      if (error && !isMissingTableError(error)) {
        console.warn(`[Tracing] startTrace insert failed: ${error.message}`);
      }
    });

  return id;
}

function addStep(traceId, stepName, data = null) {
  if (!traceId) return;
  const trace = traces.get(traceId);
  if (!trace) return;

  const step = {
    step: stepName,
    t_ms: Date.now() - trace.startedAt,
  };
  if (data !== null && data !== undefined) {
    // Strings get truncated; objects get re-encoded with the same cap.
    step.data = typeof data === "string"
      ? safeStringify(data, STEP_VALUE_TRUNCATE)
      : truncatePayload(data, STEP_VALUE_TRUNCATE);
  }
  trace.steps.push(step);

  // Fire-and-forget DB write. We rewrite the full steps array each time
  // because Supabase JS doesn't expose a JSONB array-append; the cost
  // is bounded by trace length (~30 steps max in practice).
  supabase
    .from(TRACE_TABLE)
    .update({ steps: trace.steps })
    .eq("id", traceId)
    .then(({ error }) => {
      if (error && !isMissingTableError(error)) {
        // Only log non-network noise — addStep is on the hot path and
        // we don't want to flood the console.
        if (!/timeout|fetch failed/i.test(error.message || "")) {
          console.warn(`[Tracing] addStep "${stepName}" flush failed: ${error.message}`);
        }
      }
    });
}

function setAiPayload(traceId, payload) {
  if (!traceId) return;
  const trace = traces.get(traceId);
  if (!trace) return;
  trace.aiPayload = truncatePayload(payload);
  supabase
    .from(TRACE_TABLE)
    .update({ ai_payload: trace.aiPayload })
    .eq("id", traceId)
    .then(({ error }) => {
      if (error && !isMissingTableError(error)) {
        console.warn(`[Tracing] setAiPayload flush failed: ${error.message}`);
      }
    });
}

function setOutput(traceId, text) {
  if (!traceId) return;
  const trace = traces.get(traceId);
  if (!trace) return;
  trace.outputText = safeStringify(text, STEP_VALUE_TRUNCATE);
  // Defer DB write until finishTrace so we batch.
}

function setError(traceId, err) {
  if (!traceId) return;
  const trace = traces.get(traceId);
  if (!trace) return;
  trace.error = err?.stack || err?.message || String(err || "unknown");
}

async function finishTrace(traceId) {
  if (!traceId) return null;
  const trace = traces.get(traceId);
  if (!trace) return null;
  trace.finishedAt = Date.now();
  const durationMs = trace.finishedAt - trace.startedAt;

  // Final UPDATE: write everything that may have changed since the last
  // step flush, in a single round trip. This is the only DB write we
  // bother awaiting — it ensures the row is consistent at the moment we
  // remove it from the in-memory map.
  const { error } = await supabase
    .from(TRACE_TABLE)
    .update({
      steps: trace.steps,
      ai_payload: trace.aiPayload,
      output_text: trace.outputText,
      error: trace.error,
      duration_ms: durationMs,
      finished_at: new Date(trace.finishedAt).toISOString(),
    })
    .eq("id", traceId);

  if (error && !isMissingTableError(error)) {
    console.warn(`[Tracing] finishTrace flush failed: ${error.message}`);
  }

  // Hold the trace in memory briefly so a follow-up /debug right after
  // a request can be answered from RAM (faster, and works even if the
  // migration is missing).
  setTimeout(() => traces.delete(traceId), 60_000).unref();

  return {
    id: trace.id,
    durationMs,
    error: trace.error,
    steps: trace.steps,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Read API — used by /debug command
// ─────────────────────────────────────────────────────────────────────

async function getTrace(traceId) {
  if (!traceId) return null;
  // Prefer the in-memory copy (still in-flight or just finished). It's
  // strictly fresher than the DB during the 60s retention window.
  const live = traces.get(traceId);
  if (live) {
    return {
      id: live.id,
      telegram_id: live.telegramId,
      input_text: live.inputText,
      steps: live.steps,
      ai_payload: live.aiPayload,
      output_text: live.outputText,
      error: live.error,
      duration_ms: live.finishedAt ? live.finishedAt - live.startedAt : Date.now() - live.startedAt,
      finished_at: live.finishedAt ? new Date(live.finishedAt).toISOString() : null,
      _source: "memory",
    };
  }

  const { data, error } = await supabase
    .from(TRACE_TABLE)
    .select("*")
    .eq("id", traceId)
    .maybeSingle();
  if (error) {
    if (isMissingTableError(error)) return null;
    console.warn(`[Tracing] getTrace failed: ${error.message}`);
    return null;
  }
  if (!data) return null;
  return { ...data, _source: "db" };
}

// Format a trace for display in Telegram. Designed to fit comfortably
// inside one Telegram message (4096 chars) — long fields get truncated
// and the steps render as a compact timing list.
function formatTraceForTelegram(trace) {
  if (!trace) return "❌ Trace לא נמצא.";

  const lines = [];
  lines.push(`🔎 *Trace* \`${trace.id}\``);
  lines.push(`👤 user: \`${trace.telegram_id}\``);
  lines.push(`📝 input: ${trace.input_text ? `"${trace.input_text.slice(0, 200)}"` : "—"}`);
  if (trace.duration_ms != null) {
    const status = trace.finished_at ? "✅" : "⏳";
    lines.push(`${status} duration: ${trace.duration_ms}ms`);
  }
  if (trace._source === "memory") lines.push(`💾 source: in-memory`);

  if (trace.error) {
    const errStr = String(trace.error).split("\n").slice(0, 4).join("\n");
    lines.push(`\n🔥 *error:*\n\`\`\`\n${errStr.slice(0, 800)}\n\`\`\``);
  }

  if (Array.isArray(trace.steps) && trace.steps.length) {
    lines.push(`\n*steps:* (${trace.steps.length})`);
    let prevT = 0;
    for (const s of trace.steps) {
      const dt = (s.t_ms ?? 0) - prevT;
      prevT = s.t_ms ?? prevT;
      let line = `• \`+${String(dt).padStart(5)}ms\` ${s.step}`;
      if (s.data !== undefined && s.data !== null) {
        const dataStr = typeof s.data === "string" ? s.data : safeStringify(s.data, 180);
        line += ` — ${String(dataStr).slice(0, 180)}`;
      }
      lines.push(line);
    }
  } else {
    lines.push(`\n*steps:* —`);
  }

  if (trace.output_text) {
    lines.push(`\n*output:* "${String(trace.output_text).slice(0, 300)}"`);
  }

  let out = lines.join("\n");
  if (out.length > 3800) out = out.slice(0, 3800) + "\n…[truncated]";
  return out;
}

module.exports = {
  startTrace,
  addStep,
  setAiPayload,
  setOutput,
  setError,
  finishTrace,
  getTrace,
  formatTraceForTelegram,
};
