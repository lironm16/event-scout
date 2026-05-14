// History scrubber — strip volatile values from PRIOR-TURN tool results
// before handing the conversation history back to Gemini.
//
// Why this exists:
//
// Gemini's chat API consumes the full message history on every round. That
// includes function-response payloads from earlier user turns. Those
// payloads carry fields like `tickets_left` and `is_sold_out` that were
// truthful AT THE TIME the tool ran but are essentially racy snapshots.
// Five minutes later they're stale.
//
// Without scrubbing, the model can — and does — quote those old numbers
// in its replies, even after a fresh search returns a different value.
// LLMs are biased to remain consistent with their previous output, so a
// model that said "יש 2 כרטיסים" five minutes ago is reluctant to say
// "אזלו" now, even when the latest tool result clearly says zero.
//
// What it does:
//
// • Splits history at the LAST `user` turn (= the boundary of "the
//   current turn we're processing right now").
// • Anything BEFORE the boundary is "previous turn" — for those function
//   responses we replace volatile fields with sentinels.
// • Anything AT/AFTER the boundary is the live turn — left untouched so
//   Gemini can still reason over the freshly-fetched data it just got.
//
// The structural fields (event ids, names, dates, locations) stay intact
// so the model retains conversation continuity. Only the racy numbers
// get redacted.
//
// Invariants:
//   - Pure function. No mutation of the input array or its items.
//   - Always returns the same number of items in the same order — the
//     Gemini protocol requires functionCall ↔ functionResponse pairing.

// Tool names whose responses carry volatile, time-sensitive availability
// data. Anything not in this set is left alone (e.g. resolve_venue,
// get_user_profile — those are stable and would only confuse the model
// if we scrubbed them).
const VOLATILE_TOOL_NAMES = new Set([
  "search_events",
  "find_event_by_name",
  "refresh_event",
  "get_watch_list",
]);

// Sentinel string we drop in place of a stale numeric value. The model
// treats free-text values as opaque strings — a stale-marker like this
// is much harder to "accidentally quote" than a plain number, and the
// embedded instruction nudges the model to fetch fresh data when
// pressed.
const STALE_MARKER =
  "<stale — call search_events or refresh_event for current value>";

function scrubEventLike(ev) {
  if (!ev || typeof ev !== "object") return ev;
  // Touch only the keys we care about; copy lazily to avoid allocating
  // new objects when nothing matched. `last_changed_at` is scrubbed too
  // because without the value itself, the "stable since X" implication
  // is meaningless and the model could end up phrasing claims based on
  // a timestamp whose anchor it can no longer see.
  let out = ev;
  for (const key of ["tickets_left", "is_sold_out", "last_checked", "last_changed_at"]) {
    if (key in ev) {
      if (out === ev) out = { ...ev };
      out[key] = key === "tickets_left" ? STALE_MARKER : null;
    }
  }
  return out;
}

function scrubResponse(response) {
  if (!response || typeof response !== "object") return response;
  let out = response;
  if (Array.isArray(out.events)) {
    const newEvents = out.events.map(scrubEventLike);
    out = { ...out, events: newEvents };
  }
  if (out.event && typeof out.event === "object") {
    out = { ...out, event: scrubEventLike(out.event) };
  }
  // Older `refresh_event` results have these top-level too; nuke them
  // so the model can't quote "previous: 2 → new: 1" from a snapshot
  // that's now itself stale.
  if ("previous_tickets_left" in out || "new_tickets_left" in out) {
    out = { ...out };
    if ("previous_tickets_left" in out) out.previous_tickets_left = STALE_MARKER;
    if ("new_tickets_left" in out) out.new_tickets_left = STALE_MARKER;
  }
  // Mark the response so it's clear in tracing/diagnostics that we
  // scrubbed it. The model itself ignores keys it doesn't recognise.
  if (out !== response) out._stale = true;
  return out;
}

/**
 * Return a scrubbed copy of the conversation history that's safe to
 * send to Gemini for the next round.
 *
 * @param {Array} history Gemini-shaped history (role + parts items).
 * @returns {Array} new array; original is never mutated.
 */
function scrubHistory(history) {
  if (!Array.isArray(history) || history.length === 0) return history;

  // Boundary = index of the last user turn. Items at or after this index
  // are part of the current request's tool round-trip and must NOT be
  // scrubbed (the model needs the freshly-fetched numbers to compose its
  // reply). Items before this index are leftovers from prior turns.
  let boundary = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]?.role === "user") {
      boundary = i;
      break;
    }
  }
  if (boundary <= 0) return history; // no prior turns to scrub

  let touched = false;
  const out = history.map((item, i) => {
    if (i >= boundary) return item;
    if (item?.role !== "function" || !Array.isArray(item.parts)) return item;
    let partsTouched = false;
    const newParts = item.parts.map((part) => {
      const name = part?.functionResponse?.name;
      if (!name || !VOLATILE_TOOL_NAMES.has(name)) return part;
      const scrubbed = scrubResponse(part.functionResponse.response);
      if (scrubbed === part.functionResponse.response) return part;
      partsTouched = true;
      return {
        ...part,
        functionResponse: { name, response: scrubbed },
      };
    });
    if (!partsTouched) return item;
    touched = true;
    return { ...item, parts: newParts };
  });
  return touched ? out : history;
}

module.exports = {
  scrubHistory,
  scrubResponse,
  scrubEventLike,
  STALE_MARKER,
  VOLATILE_TOOL_NAMES,
};
