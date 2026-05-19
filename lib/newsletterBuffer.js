// In-memory per-user newsletter buffer.
//
// The May-2026 v2 spec replaces the weekly digest with an
// "immediate-with-5-min-buffer" delivery model:
//
//   • A new relevant event arrives → start (or extend) a 5-min
//     buffer for that user.
//   • More events arrive within the window → grouped into the
//     same buffer.
//   • After 5 min elapse from the FIRST event, the buffer flushes:
//       - exactly 1 event → single-card flush (no multi-select UI)
//       - ≥ 2 events     → multi-card newsletter format with select
//                          buttons + bulk-action footer
//
// State is in-memory only. On bot restart the buffers are lost, but
// the cross-cycle dedup via `user_newsletter_state.last_sent_at`
// (events with first_seen_at > last_sent_at) re-enqueues the same
// events on the next scrape so nothing is permanently dropped — at
// worst a delivery slips by ~5 minutes after a restart. Trade-off:
// persistence would require a per-(user, event) DB write on every
// enqueue, which dominates the cost when many events arrive at once.

// Window from `firstSeenAt` to flush. 5 minutes per spec.
const BUFFER_MS = 5 * 60 * 1000;

// Hard cap on buffer size per user. Prevents an unbounded list of
// events from accumulating in memory if a user is opted into a
// very broad set (e.g. no profile filters) and we have an unusual
// scrape boost. Once full we just stop enqueuing — the next flush
// catches the overflow on the following cycle.
const MAX_EVENTS_PER_BUFFER = 50;

// telegramId(string) → { events: Map<eventId, event>, firstSeenAt: epoch_ms }
const buffers = new Map();

/**
 * Add an event to a user's buffer. First add starts the 5-min
 * timer; subsequent adds within the window join the same group.
 *
 * Returns `true` when the event was enqueued (not a duplicate, buffer
 * not full), `false` when skipped.
 */
function enqueue(telegramId, event) {
  if (event?.id == null) return false;
  const key = String(telegramId);
  let buf = buffers.get(key);
  if (!buf) {
    buf = { events: new Map(), firstSeenAt: Date.now() };
    buffers.set(key, buf);
  }
  if (buf.events.size >= MAX_EVENTS_PER_BUFFER) return false;
  if (buf.events.has(event.id)) return false;
  buf.events.set(event.id, event);
  return true;
}

/**
 * Buffers whose window has elapsed. Returns shallow snapshots so the
 * caller can iterate without holding the underlying Map during
 * async work. Use {@link consume} to remove a buffer atomically.
 */
function getDueBuffers(now = Date.now()) {
  const out = [];
  for (const [tg, buf] of buffers) {
    if (now - buf.firstSeenAt >= BUFFER_MS) {
      out.push({ telegramId: tg, buf });
    }
  }
  return out;
}

/**
 * Atomically remove + return a user's buffer. The caller uses this
 * BEFORE rendering so a concurrent enqueue during the async render
 * goes into a fresh buffer (next tick) — without that, we'd risk
 * losing the late-arriving event on a buffer-clear at the end of
 * the render.
 */
function consume(telegramId) {
  const key = String(telegramId);
  const buf = buffers.get(key);
  buffers.delete(key);
  return buf || null;
}

/** Diagnostics — number of active buffers + total queued events. */
function stats() {
  let total = 0;
  for (const buf of buffers.values()) total += buf.events.size;
  return { users: buffers.size, events: total };
}

/** Test helper — wipe everything. */
function clearAll() {
  buffers.clear();
}

module.exports = {
  enqueue,
  getDueBuffers,
  consume,
  stats,
  clearAll,
  BUFFER_MS,
  MAX_EVENTS_PER_BUFFER,
};
