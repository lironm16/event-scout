/**
 * Inspect the `ticket_history` audit log (sql/033).
 *
 * Usage:
 *   node jobs/showTicketHistory.js
 *     → Last 10 ticket transitions across all events.
 *
 *   node jobs/showTicketHistory.js <event_id>
 *     → Full history for one event, oldest → newest.
 *
 *   node jobs/showTicketHistory.js --since=24h
 *     → All transitions in the last 24h. Accepts h/d (e.g. 6h, 7d).
 *
 * The script is read-only and safe to run anytime. Use it whenever a
 * notification looks suspicious ("did 0 → 40 really happen, or was 0
 * a scrape blip?") — the table records every change the trigger saw.
 */

require("dotenv").config({
  path: require("path").resolve(__dirname, "..", ".env"),
});

const supabase = require("../lib/supabase");

function parseSince(arg) {
  const match = String(arg || "").match(/^(\d+)\s*([hd])$/i);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  const ms = unit === "h" ? value * 3600_000 : value * 86_400_000;
  return new Date(Date.now() - ms).toISOString();
}

function fmtTransition(prev, next) {
  const left = prev === null || prev === undefined ? "∅" : String(prev);
  const right = next === null || next === undefined ? "∅" : String(next);
  return `${left} → ${right}`;
}

function fmtRow(row, eventName) {
  const name = eventName ? `  ${eventName}` : "";
  return `[${row.changed_at}] event #${row.event_id}  ${fmtTransition(
    row.prev_tickets_left,
    row.new_tickets_left
  )}${name}`;
}

async function fetchEventNames(eventIds) {
  if (!eventIds.length) return new Map();
  const { data, error } = await supabase
    .from("events")
    .select("id,name")
    .in("id", eventIds);
  if (error) throw error;
  return new Map((data || []).map((e) => [e.id, e.name]));
}

async function showOne(eventId) {
  const { data: rows, error } = await supabase
    .from("ticket_history")
    .select("*")
    .eq("event_id", eventId)
    .order("changed_at", { ascending: true });
  if (error) throw error;
  if (!rows || rows.length === 0) {
    console.log(`No history rows for event #${eventId}.`);
    return;
  }
  const names = await fetchEventNames([Number(eventId)]);
  const eventName = names.get(Number(eventId)) || "(unknown)";
  console.log(`\nHistory for event #${eventId} — ${eventName}\n`);
  for (const row of rows) console.log(fmtRow(row));
  console.log(`\n${rows.length} transition(s) total.\n`);
}

async function showRecent(limit = 10, since = null) {
  let q = supabase
    .from("ticket_history")
    .select("*")
    .order("changed_at", { ascending: false })
    .limit(limit);
  if (since) q = q.gte("changed_at", since);
  const { data: rows, error } = await q;
  if (error) throw error;
  if (!rows || rows.length === 0) {
    console.log("No transitions found in that window.");
    return;
  }
  const names = await fetchEventNames([...new Set(rows.map((r) => r.event_id))]);
  const header = since
    ? `\nMost recent ${rows.length} transitions since ${since}:\n`
    : `\nMost recent ${rows.length} transitions:\n`;
  console.log(header);
  for (const row of rows) console.log(fmtRow(row, names.get(row.event_id)));
  console.log();
}

async function main() {
  const args = process.argv.slice(2);
  const sinceArg = args.find((a) => a.startsWith("--since="));
  const since = sinceArg ? parseSince(sinceArg.split("=")[1]) : null;

  const positional = args.find((a) => !a.startsWith("--"));
  if (positional) {
    await showOne(positional);
  } else {
    await showRecent(20, since);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[ShowTicketHistory] Fatal:", err.message);
    process.exit(1);
  });
