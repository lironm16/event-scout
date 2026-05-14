// Aggregates all tool modules into a single { declarations, dispatch }
// pair the orchestrator passes to Gemini and uses to route function calls.
//
// Each sub-module exports { declarations: [...], handlers: { name: fn } }.
// We merge them here so adding a new tool is a one-line registration in
// the array below.

const profile = require("./profile");
const locations = require("./locations");
const events = require("./events");
const savedSearches = require("./savedSearches");
const watchers = require("./watchers");
const semantic = require("./semantic");
const conversation = require("./conversation");
const ticketOffer = require("./ticketOffer");
const tracing = require("../../tracing");

const modules = [
  profile,
  locations,
  events,
  savedSearches,
  watchers,
  semantic,
  conversation,
  ticketOffer,
];

const declarations = [];
const handlers = Object.create(null);

for (const m of modules) {
  for (const decl of m.declarations) declarations.push(decl);
  for (const [name, fn] of Object.entries(m.handlers)) {
    if (handlers[name]) {
      throw new Error(`Tool name collision: ${name}`);
    }
    handlers[name] = fn;
  }
}

// Compact summary of a tool result that's safe to log. We keep arrays
// short and strip large payloads so the trace JSONB stays readable in
// `/debug` output.
function summarizeResult(result) {
  if (!result || typeof result !== "object") return result;
  const summary = {};
  if (result.error) summary.error = result.error;
  if (result.final) summary.final = true;
  if (result.paused) summary.paused = true;
  if (result.ok) summary.ok = true;
  if (Array.isArray(result.events)) summary.events_count = result.events.length;
  if (Array.isArray(result.candidates)) summary.candidates_count = result.candidates.length;
  if (Array.isArray(result.tickets)) summary.tickets_count = result.tickets.length;
  if (result.status) summary.status = result.status;
  if (result.matched != null) summary.matched = result.matched;
  if (result.total_in_window != null) summary.total_in_window = result.total_in_window;
  if (result.from_memory != null) summary.from_memory = result.from_memory;
  if (result.window?.label_he) summary.window = result.window.label_he;
  return summary;
}

/**
 * Execute a tool by name with the given args + ctx. All errors are caught
 * and returned as `{ error: "..." }` so a misbehaving tool never crashes
 * the agent loop — Gemini reads the error and decides the next move.
 */
async function dispatch(name, args, ctx) {
  const traceId = ctx?.traceId || null;
  const fn = handlers[name];
  if (!fn) {
    tracing.addStep(traceId, `tool:${name}`, { error: "unknown_tool" });
    return { error: "unknown_tool", message: `No tool named '${name}'` };
  }
  const t0 = Date.now();
  try {
    const result = await fn(args || {}, ctx);
    tracing.addStep(traceId, `tool:${name}`, {
      ms: Date.now() - t0,
      args: args || {},
      result: summarizeResult(result),
    });
    return result;
  } catch (err) {
    console.error(`[Agent] Tool ${name} failed:`, err.message);
    tracing.addStep(traceId, `tool:${name}:error`, {
      ms: Date.now() - t0,
      args: args || {},
      error: err.message,
    });
    return { error: "tool_failed", tool: name, message: err.message };
  }
}

module.exports = {
  declarations,
  handlers,
  dispatch,
  // Surface the tool config object Gemini wants in `tools: [{ functionDeclarations }]`.
  toolsConfig: [{ functionDeclarations: declarations }],
};
