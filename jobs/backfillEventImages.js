// One-off backfill: normalise existing rows in `events.image` to the
// post-fix shape:
//   - Relative path (no `https://<host>` prefix).
//   - Prefer the full-resolution upload (`/uploads/upld…`) over the
//     3 KB calendar thumb (`/uploads/thumbs/thmb…`) whenever the
//     calendar API still has the event with `image` populated.
//
// Why this matters
//   The old `getThumbnailUrl` (api/check.js) seeded rows with the
//   calendar grid thumbnail — ~3 KB at native resolution. Visually
//   that's a postage stamp once Telegram scales it up. We now write
//   the upload itself (~1.5 MB for the same event), but existing
//   ~890 rows are stuck on the old shape. This job re-aligns them.
//
// Safety
//   - `--dry-run` prints the planned UPDATE for every row without
//     touching the DB. Run that first.
//   - Rows whose calendar API entry is gone (past events, sold-out
//     events that fell out of the visibility window) keep their
//     existing image — we just strip the absolute-URL host. The
//     image stays whatever it was.
//   - Idempotent: re-running on already-normalised rows is a no-op.
//
// Usage
//   node jobs/backfillEventImages.js --dry-run   # preview
//   node jobs/backfillEventImages.js             # commit

require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");
const { TENANTS } = require("../lib/sourceUrls");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const DRY_RUN = process.argv.includes("--dry-run");

// Mirrors `pickImagePath` in api/check.js — kept inline so this
// script remains a self-contained one-off (no coupling to internal
// helpers that might change). Inputs accepted: calendar API entry
// shape `{ image, thumbnail_calendar }`.
function pickImagePathFromCalendar(entry) {
  const full = typeof entry?.image === "string" ? entry.image.trim() : "";
  if (full) {
    if (full.startsWith("http://") || full.startsWith("https://")) {
      try {
        return new URL(full).pathname;
      } catch {
        /* fall through */
      }
    } else {
      return full.startsWith("/") ? full : `/uploads/${full}`;
    }
  }
  const thumb = entry?.thumbnail_calendar;
  if (!thumb) return null;
  if (thumb.startsWith("http://") || thumb.startsWith("https://")) {
    try {
      return new URL(thumb).pathname;
    } catch {
      return null;
    }
  }
  return thumb.startsWith("/") ? thumb : `/uploads/thumbs/${thumb}`;
}

function stripHost(rawValue) {
  if (!rawValue) return rawValue;
  const v = String(rawValue).trim();
  if (!v) return v;
  if (v.startsWith("http://") || v.startsWith("https://")) {
    try {
      return new URL(v).pathname;
    } catch {
      return v;
    }
  }
  return v;
}

// Calendar API fetch — same params as the live scraper. We probe a
// wide window so a backfill run picks up everything currently
// visible to users; events that fell out of the window aren't
// upgradable (no calendar data) and just keep their stripped path.
function calendarWindow() {
  const now = new Date();
  const start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const end = new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  return { start: fmt(start), end: fmt(end) };
}

async function fetchCalendarMap(tenant) {
  const { start, end } = calendarWindow();
  const url = `${tenant.calendarUrl}?start=${start}&end=${end}`;
  try {
    const { data } = await axios.get(url, {
      headers: { "User-Agent": "EventScout-Backfill/1.0" },
      timeout: 20_000,
    });
    if (data?.success === false || !Array.isArray(data?.result)) {
      console.warn(`  ${tenant.source}: calendar fetch shape unexpected; skipping upgrades for this tenant`);
      return new Map();
    }
    const map = new Map();
    for (const entry of data.result) {
      if (entry?.id != null) map.set(Number(entry.id), entry);
    }
    return map;
  } catch (err) {
    console.warn(`  ${tenant.source}: calendar fetch failed (${err.message}) — skipping upgrades for this tenant`);
    return new Map();
  }
}

async function main() {
  console.log(`[Backfill] mode: ${DRY_RUN ? "DRY-RUN" : "COMMIT"}`);

  // Pre-fetch calendar API per smarticket tenant.
  const smarticketTenants = TENANTS.filter((t) => t.kind === "smarticket");
  console.log(`[Backfill] fetching calendar API for ${smarticketTenants.length} tenant(s)…`);
  const calendarBySource = new Map();
  for (const t of smarticketTenants) {
    const m = await fetchCalendarMap(t);
    calendarBySource.set(t.source, m);
    console.log(`  ${t.source}: ${m.size} live calendar entries`);
  }

  // Iterate all live (non-archived) rows with non-null image. We
  // process ALL of them, not just smarticket — but only smarticket
  // rows can be UPGRADED to the upld upload. Other sources (rg-muni,
  // whatsapp) just get host-stripped.
  console.log(`[Backfill] scanning events…`);
  const { data: events, error } = await supabase
    .from("events")
    .select("id, source, image, name, archived")
    .not("image", "is", null);
  if (error) throw error;

  console.log(`[Backfill] ${events.length} candidate row(s) with image populated`);

  let upgradedHiRes = 0; // upgraded thumb → upld
  let normalisedHost = 0; // stripped host, same identity
  let unchanged = 0;
  let touched = 0;

  for (const row of events) {
    const before = row.image;
    let after = stripHost(before);

    const isThumbPath = /\/uploads\/thumbs\/thmb/i.test(after || "");
    if (isThumbPath) {
      const cal = calendarBySource.get(row.source)?.get(Number(row.id));
      const upgraded = cal ? pickImagePathFromCalendar(cal) : null;
      if (
        upgraded &&
        upgraded !== after &&
        /\/uploads\/upld/i.test(upgraded)
      ) {
        after = upgraded;
        upgradedHiRes++;
      }
    }

    if (after === before) {
      unchanged++;
      continue;
    }

    if (!upgradedHiRes || after !== before) {
      // Distinguish host-strip from hi-res upgrade for the summary.
      if (/\/uploads\/upld/i.test(after) && /\/uploads\/thumbs\/thmb/i.test(stripHost(before))) {
        // already counted as upgraded above
      } else {
        normalisedHost++;
      }
    }
    touched++;

    if (DRY_RUN) {
      if (touched <= 10) {
        console.log(`  ${row.id}: ${before} → ${after}`);
      } else if (touched === 11) {
        console.log(`  …(suppressing further per-row logs; use --dry-run with a row filter for details)`);
      }
      continue;
    }

    const { error: updErr } = await supabase
      .from("events")
      .update({ image: after })
      .eq("id", row.id);
    if (updErr) {
      console.error(`  ✗ ${row.id} update failed: ${updErr.message}`);
    }
  }

  console.log(``);
  console.log(`[Backfill] Summary:`);
  console.log(`  upgraded to hi-res /uploads/upld: ${upgradedHiRes}`);
  console.log(`  host-only normalisation:         ${normalisedHost}`);
  console.log(`  unchanged:                       ${unchanged}`);
  console.log(`  total touched:                   ${touched}`);
  if (DRY_RUN) {
    console.log(`\n[Backfill] DRY-RUN — no rows were modified. Re-run without --dry-run to commit.`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[Backfill] fatal:", err.message);
    process.exit(1);
  });
