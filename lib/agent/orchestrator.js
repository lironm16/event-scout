const { GoogleGenerativeAI } = require("@google/generative-ai");
const { buildSystemPrompt } = require("./systemPrompt");
const { dispatch, toolsConfig } = require("./tools");
const sessionStore = require("./sessionStore");
const { scrubHistory } = require("./historyScrubber");
const { getProfile } = require("../../bot/profileService");
const tracing = require("../tracing");
const { trace } = require("../langsmith");
const sentry = require("../sentry");

// Pre-wrap the Gemini call for LangSmith. We use a top-level wrapped
// function (not a per-turn closure) so the SDK can dedupe the function
// identity across rounds — keeps the trace tidy when the same agent
// turn fires three Gemini rounds. Returns the raw SDK response; the
// caller still extracts function calls / text from it.
//
// We scrub volatile fields (tickets_left, is_sold_out, ...) from PRIOR-
// TURN tool responses right before sending. Without this, the model
// reads stale numbers from history and quotes them in replies — see
// `lib/agent/historyScrubber.js` for the full rationale.
const tracedGenerate = trace(
  async function gemini_round({ contents }, model) {
    const safeContents = scrubHistory(contents);
    return await model.generateContent({ contents: safeContents });
  },
  { name: "gemini_round", run_type: "llm" },
);

// Per-tool-call wrap. We accept the tool name as the first argument so
// each call shows up as a distinctly-named span in LangSmith ("tool:
// search_events" / "tool: present_event_results") even though they all
// flow through the same dispatch function.
const tracedDispatch = trace(
  async function tool_call({ name, args }, ctx) {
    return await dispatch(name, args, ctx);
  },
  { name: "tool_call", run_type: "tool" },
);

const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const MODEL = "gemini-flash-latest";

// Each Gemini round is bounded so a single hung call can't stall the whole
// turn. In practice rounds end in 1-5s once the prompt is small. There's
// no MAX_ROUNDS cap — the agent loops until it converges on a terminal
// tool (reply_text / ask_clarification / present_event_results / …) OR
// the wall-clock budget below kicks in. This avoids artificially failing
// turns that legitimately need 5-6 rounds (dense profile updates,
// disambiguation chains, multi-tool conversations).
const PER_ROUND_TIMEOUT_MS = 18_000;
// Wall-clock budget for the WHOLE agent turn — Gemini rounds + tool
// dispatch + bookkeeping. This is the ONLY ceiling on agent runtime.
// Must be strictly less than Telegraf's handlerTimeout (90s) so our
// graceful exit ("התקשיתי להבין...") always fires before Telegraf's
// brutal "Promise timed out" reaches bot.catch. 15s headroom lets the
// final `ctx.tg.reply()` and trace flush land cleanly.
const AGENT_TOTAL_BUDGET_MS = 75_000;

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timeout (${ms / 1000}s)`)), ms)),
  ]);
}

// Pull every functionCall part out of a Gemini response, scoped
// strictly to candidates[0].
//
// IMPORTANT: we only look at candidates[0] — not all candidates —
// because the caller stores `response.candidates[0].content.parts`
// verbatim into history (see appendModelTurn below). If we ever
// pulled calls from candidates[1+] and the SDK started returning
// multiple candidates, we'd dispatch tool calls that ARE NOT in the
// stored model turn → next round, Gemini sees a function response
// without a matching functionCall in the preceding model turn and
// 400s with shape errors. Keep these two extraction paths in sync.
function extractFunctionCalls(response) {
  const parts = response?.candidates?.[0]?.content?.parts || [];
  const calls = [];
  for (const p of parts) {
    if (p.functionCall) calls.push(p.functionCall);
  }
  return calls;
}

// Find the index of the most recent `user` turn. Used by the history
// recovery path in the round-failure catch block. Returns -1 if none.
function findLastUserTurnIndex(history) {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]?.role === "user") return i;
  }
  return -1;
}

// Build a compact, Sentry-safe snapshot of the conversation history
// for forensic attachment to alerts. Without this, debugging a
// Gemini history-shape 400 is impossible: the message just says
// "your history is wrong" with no clue WHICH turn is wrong. With
// this attached to the alert, we can see the role sequence at a
// glance and pinpoint the offending pair.
//
// Output shape: array of one entry per turn, each ~80 bytes max:
//   { role, fc?: ["name1","name2"], fr?: ["name1"], text?: "first 80 chars" }
//
// We capture:
//   • `role` always — the alternation pattern is what's broken in
//     shape errors, so this is the headline data.
//   • `fc` (function call names) — so we can see WHICH tools the
//     model invoked at each step. Names only, no args (those can
//     contain PII like home_address).
//   • `fr` (function response names) — same logic, matching the
//     paired functionCall.
//   • `text` (truncated) — only the FIRST 80 chars of user/model
//     text, mostly to identify the user message in the trace. NOT
//     the model's full output (could be a 2KB card render).
//
// Returns at most LAST_N turns (most recent end of history) so a
// 40-turn session doesn't blow up the Sentry payload. The shape bug
// almost always involves the last 3-5 turns anyway.
function historySnapshotForAlert(history, lastN = 12) {
  if (!Array.isArray(history)) return [];
  const slice = history.slice(-lastN);
  return slice.map((turn, idx) => {
    const out = {
      // `i` indexes within the SLICE; the alert also carries
      // `history_len` so the reader can compute the absolute index
      // as (history_len - lastN + i) when needed.
      i: idx,
      role: turn?.role || "unknown",
    };
    const parts = Array.isArray(turn?.parts) ? turn.parts : [];
    const fcNames = [];
    const frNames = [];
    let firstText = null;
    for (const p of parts) {
      if (p?.functionCall?.name) fcNames.push(p.functionCall.name);
      if (p?.functionResponse?.name) frNames.push(p.functionResponse.name);
      if (typeof p?.text === "string" && firstText === null && p.text.trim()) {
        firstText = p.text.length > 80 ? p.text.slice(0, 80) + "…" : p.text;
      }
    }
    if (fcNames.length) out.fc = fcNames;
    if (frNames.length) out.fr = frNames;
    if (firstText) out.text = firstText;
    return out;
  });
}

// Did Gemini reject the request because our history violates the
// tool-API turn sequence rules? The exact error string is stable in
// the SDK as of late-2024 — keyed loosely so a minor reword still
// matches. If true, we can trim history to the last user turn and
// retry instead of dropping the user's message.
function isHistoryShapeError(err) {
  const msg = err?.message || "";
  return (
    /function call turn comes immediately after/.test(msg) ||
    /Function call is missing a thought_signature/.test(msg) ||
    /content with role 'function' is missing/.test(msg)
  );
}

// Gemini occasionally finishes a turn by emitting a content-free
// acknowledgement ("ok", "אוקיי", "done", a lone emoji) instead of
// just stopping. The system prompt forbids this — every textual
// communication should go through `reply_text` — but in practice
// the model leaks a filler ~once every few hundred turns,
// typically right after a successful `present_event_results`.
// Surfacing "ok" to the user is jarring and looks like a bug. We
// match strict patterns (anchored, short) so a real reply that
// happens to START with "ok" still flows through.
const FILLER_TRAILING_TEXT = /^(ok|okay|done|fine|noted|sure|got it|✓|✔|👍|🎯|אוקיי|אוקי|בסדר|סיימתי|הצלחה|המשך|כן)[\s.!,?]*$/i;

function isFillerTrailingText(text) {
  if (!text) return false;
  const trimmed = String(text).trim();
  if (!trimmed) return false;
  if (trimmed.length > 15) return false;
  return FILLER_TRAILING_TEXT.test(trimmed);
}

function extractText(response) {
  // The SDK exposes `response.text()`; we fall back to manual extraction
  // if there's no text part (because the only parts were functionCalls).
  try {
    const t = response?.text?.();
    if (t) return t;
  } catch {}
  const candidates = response?.candidates || [];
  const chunks = [];
  for (const c of candidates) {
    const parts = c?.content?.parts || [];
    for (const p of parts) {
      if (typeof p.text === "string") chunks.push(p.text);
    }
  }
  return chunks.join("\n").trim();
}

/**
 * Run the agent for a fresh user input. Caller responsibilities:
 *   1. Append the user's message to session history (via sessionStore.appendUserMessage).
 *   2. Pass `ctx` populated with `tg` renderers (reply, renderEventCard, …).
 *
 * The function returns when either:
 *   - the agent reaches a terminal tool (`reply_text` or pause via
 *     `ask_clarification` / `present_save_confirmation`); or
 *   - the wall-clock budget (AGENT_TOTAL_BUDGET_MS) is exhausted — the
 *     caller is told nothing more is coming.
 */
// Cap how many hits we keep in the per-turn search cache. The agent
// rarely runs more than 3-4 search_events calls per turn (max 30 each),
// so 200 is plenty of headroom — and bounded enough that a buggy loop
// can't blow up memory.
const SEARCH_HIT_CAP = 200;

/**
 * Append events to the per-turn search cache that `present_event_results`
 * (and similar renderers) read from.
 *
 * Critical: we MERGE rather than REPLACE. If the agent runs a refinement
 * search that returns 0 results, the previous (good) hits must remain
 * available — otherwise the agent's perfectly-valid choice to render the
 * earlier IDs silently no-ops (the bug fixed alongside this commit).
 *
 * Newer events for the same id win, so re-running the same search with
 * different annotations (e.g. `_searchedTagNames` set) updates the
 * stored row in place.
 */
function rememberSearchHits(ctx, events) {
  // Track the IDs from THIS specific search call separately from the
  // cumulative cache. The cumulative cache (lastSearchHits) is for
  // event-by-id lookups during rendering and survives the merge so a
  // follow-up search returning 0 doesn't lose the earlier results.
  // The per-call ID set (lastSearchResultIds), however, is REPLACED
  // every time — it answers the question "which events match the
  // CURRENT filter set?", which is what `present_event_results` needs
  // for accurate pagination.
  //
  // Without the per-call snapshot, refinement queries silently
  // mis-paginate: a broad search ("all events") followed by a narrow
  // one ("only walking distance") would still offer "show more" from
  // the broad cache and the user gets back the events the narrow
  // filter explicitly excluded. See screenshot 2026-05-14.
  const ids = Array.isArray(events)
    ? events.map((e) => e?.id).filter((id) => id != null)
    : [];
  ctx.lastSearchResultIds = new Set(ids);

  if (!Array.isArray(events) || !events.length) return;
  const prev = Array.isArray(ctx.lastSearchHits) ? ctx.lastSearchHits : [];
  const map = new Map(prev.map((e) => [e.id, e]));
  for (const e of events) {
    if (!e || e.id == null) continue;
    const existing = map.get(e.id);
    if (existing) {
      // When the same event id shows up in a follow-up search, the new
      // copy comes fresh from the DB and is missing any ephemeral
      // annotations the previous tool added (e.g. `_searchedTagNames`,
      // `_audience_verdict`, `_proximity`). Carry those over so a
      // tag-search → keyword-refine sequence doesn't silently strip
      // the "this matched the search tag" highlight we want to render.
      for (const key of Object.keys(existing)) {
        if (key.startsWith("_") && e[key] === undefined) {
          e[key] = existing[key];
        }
      }
    }
    map.set(e.id, e);
  }
  const all = [...map.values()];
  ctx.lastSearchHits = all.length > SEARCH_HIT_CAP
    ? all.slice(-SEARCH_HIT_CAP)
    : all;
}

async function runAgent(telegramId, ctx) {
  const session = sessionStore.ensureSession(telegramId);
  ctx.session = session;
  ctx.telegramId = telegramId;
  ctx.rememberSearchHits = (events) => rememberSearchHits(ctx, events);
  const traceId = ctx.traceId || null;

  tracing.addStep(traceId, "agent_start", {
    history_len: session.history.length,
    pending_clarification: !!session.pendingClarification,
  });

  // Profile snapshot for the system prompt — refresh on every turn so a
  // mid-conversation profile update reflects in subsequent rounds.
  const tProfile = Date.now();
  const profile = await getProfile(telegramId).catch(() => null);
  ctx.profile = profile;
  tracing.addStep(traceId, "profile_loaded", {
    ms: Date.now() - tProfile,
    has_profile: !!profile,
  });

  const systemInstruction = buildSystemPrompt({ profile });

  const model = genai.getGenerativeModel({
    model: MODEL,
    systemInstruction,
    tools: toolsConfig,
    generationConfig: { temperature: 0.3 },
  });

  // Pull the user's most-recent message text for the parent run's input.
  // Telegraf history stores user turns as { role: "user", parts: [{text}] }
  // so this works even when the user replied to a previous message.
  const lastUserPart = [...session.history].reverse().find((m) => m.role === "user");
  const inputText = lastUserPart?.parts?.[0]?.text || "";

  // The actual loop runs inside a traced wrapper. The wrapped function's
  // single argument becomes the LangSmith run input (the user's message),
  // and its return value the output (final reply text or error). All
  // child runs (Gemini rounds, tool calls) auto-attach via the SDK's
  // AsyncLocalStorage context.
  return await tracedAgentTurn(
    { input: inputText, telegram_id: String(telegramId), profile_present: !!profile },
    { ctx, session, model, telegramId, traceId },
  );
}

const tracedAgentTurn = trace(
  async function agent_turn(_inputs, runtime) {
    const { ctx, session, model, telegramId, traceId } = runtime;
    let rounds = 0;
    const agentStart = Date.now();
    // No MAX_ROUNDS cap — the wall-clock budget check below is the
    // ONLY exit besides reaching a terminal tool. This lets dense
    // multi-fact turns (e.g. saving partner+kids+interests in one
    // message) take as many rounds as they need; the budget keeps
    // pathological loops bounded.
    while (true) {
      // Wall-clock guard. Tool dispatch isn't bounded by
      // PER_ROUND_TIMEOUT_MS (that only wraps the Gemini call), so a
      // slow Supabase/HTTP call inside a tool could otherwise push the
      // turn past Telegraf's 90s handler timeout. Break out cleanly so
      // the post-loop block sends the friendly "התקשיתי להבין..."
      // message and Sentry sees `agent_budget_exhausted` instead of
      // the catastrophic `telegraf_unhandled`.
      const elapsedTotal = Date.now() - agentStart;
      if (elapsedTotal > AGENT_TOTAL_BUDGET_MS) {
        console.warn(
          `[Agent] total budget ${AGENT_TOTAL_BUDGET_MS}ms exhausted after ${rounds} round(s)`,
        );
        tracing.addStep(traceId, "budget_exhausted", {
          rounds,
          elapsed_ms: elapsedTotal,
        });
        sentry.captureAlert({
          severity: "warning",
          code: "agent_budget_exhausted",
          message: `Agent total budget exhausted after ${rounds} round(s) (${elapsedTotal}ms)`,
          context: {
            telegramId,
            rounds,
            elapsed_ms: elapsedTotal,
            budget_ms: AGENT_TOTAL_BUDGET_MS,
            history_len: session.history.length,
          },
          traceId,
        });
        break;
      }
      rounds++;
      const t0 = Date.now();
      tracing.addStep(traceId, "gemini_request", {
        round: rounds,
        history_len: session.history.length,
      });
      let result;
      try {
        result = await withTimeout(
          tracedGenerate({ contents: session.history }, model),
          PER_ROUND_TIMEOUT_MS,
          "Agent round",
        );
      } catch (err) {
        const elapsed = Date.now() - t0;
        console.error(`[Agent] round ${rounds} failed after ${elapsed}ms:`, err.message);
        tracing.addStep(traceId, "gemini_error", {
          round: rounds,
          ms: elapsed,
          error: err.message,
        });

        // Capture the conversation shape BEFORE we mutate it (the
        // recovery branch below trims history; we want the alert to
        // show what was actually sent to Gemini at the moment of
        // failure, not the post-recovery state). Pull the user's
        // most recent text input too — that's the repro key.
        const historyShape = historySnapshotForAlert(session.history);
        const lastUserPart = [...session.history].reverse().find((m) => m.role === "user");
        const userInput = lastUserPart?.parts?.[0]?.text?.slice(0, 300) || null;

        // History-shape recovery: Gemini sometimes returns a tool-API
        // shape error if our session.history drifted out of the
        // strict user → model → function alternation (orphan
        // functionCall, missing thought_signature, history truncated
        // mid-pair, …). The user just typed something and is
        // waiting for an answer. Trim history to the most recent
        // user turn and retry ONCE — much better than telling them
        // "try again" and silently losing their input.
        if (isHistoryShapeError(err) && rounds === 1) {
          const lastUserIdx = findLastUserTurnIndex(session.history);
          if (lastUserIdx >= 0) {
            const dropped = lastUserIdx; // everything before it is gone
            // Keep only the latest user message — the system prompt
            // still carries profile/context, so the agent has what
            // it needs to answer freshly.
            session.history = session.history.slice(lastUserIdx);
            tracing.addStep(traceId, "history_recovered", {
              dropped,
              kept: session.history.length,
              error: err.message,
            });
            console.warn(
              `[Agent] history-shape error — trimmed ${dropped} turn(s), retrying round 1`,
            );
            sentry.captureAlert({
              severity: "warning",
              code: "agent_history_recovered",
              message: `Auto-recovered from Gemini history-shape 400 (dropped ${dropped} turn(s))`,
              error: err,
              context: {
                telegramId,
                user_input: userInput,
                history_len_before: session.history.length + dropped,
                history_len_after: session.history.length,
                round: rounds,
                // The headline forensic data: the role sequence
                // Gemini rejected. With this we can reconstruct
                // which turn pair violated the alternation rule
                // without needing the user to repro.
                history_shape: historyShape,
                error_message: err.message,
              },
              traceId,
            });
            // Don't consume a round — give the recovered history a
            // fair chance.
            rounds--;
            continue;
          }
        }

        // Non-recoverable: alert and surface a friendly message.
        // We send to Sentry as `error` severity — this is invisible
        // otherwise (was log-only before today), and a recurring
        // failure mode the operator should see on the dashboard.
        sentry.captureAlert({
          severity: "error",
          code: "agent_round_failed",
          message: `Agent round ${rounds} failed: ${err.message}`,
          error: err,
          context: {
            telegramId,
            user_input: userInput,
            round: rounds,
            ms: elapsed,
            history_len: session.history.length,
            // Same forensic payload as the recovered branch — for
            // non-shape errors (timeouts, 503s) the role sequence
            // probably isn't the culprit, but having it is cheap
            // and rules out history corruption as a confound when
            // triaging.
            history_shape: historyShape,
            error_message: err.message,
          },
          traceId,
        });
        try {
          await ctx.tg.reply("אני קצת איטית כרגע, סליחה. אפשר לנסות שוב בעוד רגע? 🙏");
        } catch {}
        return { ok: false, error: err.message, rounds };
      }
      const elapsed = Date.now() - t0;
      console.log(`[Agent] round ${rounds} in ${elapsed}ms`);

      const response = result?.response;
      const modelContent = response?.candidates?.[0]?.content;
      const modelParts = modelContent?.parts || [];
      const calls = extractFunctionCalls(response);

      tracing.addStep(traceId, "gemini_response", {
        round: rounds,
        ms: elapsed,
        tool_calls: calls.map((c) => c.name),
        has_text: !calls.length,
      });

      if (!calls.length) {
        // Plain text reply outside the tool protocol — the system prompt
        // forbids this, but it slips through occasionally. Two paths:
        //
        //   a. Real content leaked through (model emitted a substantial
        //      reply via raw text instead of `reply_text`). Surface it
        //      so the user's question doesn't go unanswered.
        //   b. Filler ack ("ok"/"אוקיי"/"✓") after a tool call already
        //      did the real work this turn. Swallow it — the user
        //      already saw the cards / answer from the tool. We still
        //      record the model turn into history so the alternation
        //      shape stays valid for the next user message.
        const text = extractText(response);
        const trimmed = (text || "").trim();
        if (trimmed) {
          sessionStore.appendModelTurn(telegramId, modelParts.length ? modelParts : [{ text: trimmed }]);
        }
        if (trimmed && !isFillerTrailingText(trimmed)) {
          await ctx.tg.reply(trimmed).catch(() => {});
        }
        tracing.setOutput(traceId, trimmed);
        return { ok: true, rounds, terminator: "raw_text", output: trimmed };
      }

      // Append the model turn EXACTLY as Gemini produced it. Reconstructing
      // parts ourselves drops the `thoughtSignature` field that the API
      // requires on every functionCall round-trip — the next call would
      // 400 with "Function call is missing a thought_signature".
      sessionStore.appendModelTurn(telegramId, modelParts);

      // Execute every call from this round and collect responses. Gemini
      // can issue parallel calls in a single turn (rare, but possible).
      const responseParts = [];
      let terminator = null;
      for (const call of calls) {
        const toolResult = await tracedDispatch({ name: call.name, args: call.args }, ctx);
        responseParts.push({
          functionResponse: { name: call.name, response: toolResult },
        });
        if (toolResult?.final) terminator = "final";
        else if (toolResult?.paused) terminator = "paused";
      }
      sessionStore.appendFunctionTurn(telegramId, responseParts);

      if (terminator) {
        tracing.addStep(traceId, "agent_terminate", { reason: terminator, rounds });
        return { ok: true, rounds, terminator };
      }
    }

    // Only reachable via the budget guard's `break` above (the loop
    // itself is `while (true)`). The budget guard already emitted
    // its tracing step + Sentry alert; here we just send the friendly
    // user-facing message so the user isn't left staring at silence.
    try {
      await ctx.tg.reply("התקשיתי להבין את הבקשה. אפשר לנסח אותה אחרת? אולי לפרק לכמה משפטים? 🙏");
    } catch {}
    return { ok: false, error: "budget_exhausted", rounds };
  },
  { name: "agent_turn", run_type: "chain" },
);

module.exports = {
  runAgent,
  MODEL,
  PER_ROUND_TIMEOUT_MS,
  AGENT_TOTAL_BUDGET_MS,
};
