const TZ = "Asia/Jerusalem";

/**
 * Today as YYYY-MM-DD in Asia/Jerusalem (the user's timezone).
 * The bot's "today" is whatever today is in Israel, regardless of where the
 * server runs. Used for every events query (`date >= todayISO()`).
 */
function todayISO() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  return parts;
}

/**
 * Current wall-clock time in Israel as "HH:MM" (24h).
 */
function currentTimeHHMM() {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());
}

/**
 * Day of week in Israel: 0=Sunday, 1=Monday, ..., 6=Saturday.
 * Israel's week starts on Sunday (יום ראשון).
 */
function dayOfWeekIL() {
  const weekdayName = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    weekday: "short",
  }).format(new Date());
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekdayName);
}

function addDaysISO(iso, days) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/**
 * "This week" in Israel = today through the upcoming Saturday (inclusive).
 * If today IS Saturday, it returns the same day on both ends.
 */
function weekRangeIL() {
  const start = todayISO();
  const dow = dayOfWeekIL();          // 0..6, Sun..Sat
  const daysToSat = (6 - dow + 7) % 7; // Sat → 0, Sun → 6, Fri → 1
  const end = addDaysISO(start, daysToSat);
  return { startISO: start, endISO: end };
}

/**
 * "Next week" in Israel = next Sunday through the following Saturday.
 */
function nextWeekRangeIL() {
  const today = todayISO();
  const dow = dayOfWeekIL();
  const daysToNextSun = ((7 - dow) % 7) || 7;
  const startISO = addDaysISO(today, daysToNextSun);
  const endISO = addDaysISO(startISO, 6);
  return { startISO, endISO };
}

/**
 * "This month" in everyday speech = today through 30 days ahead. Not the
 * calendar month, because users saying "החודש" usually mean "the next ~30
 * days", not "until the 31st of this calendar month". Keeping it relative
 * also avoids the empty-window problem on the 28th of the month.
 */
function monthAheadRangeIL() {
  const startISO = todayISO();
  const endISO = addDaysISO(startISO, 30);
  return { startISO, endISO };
}

/**
 * True if the event has finished before "now" in Israel time.
 *
 * Rules (top-down):
 *   1. No date → not past (let upstream decide).
 *   2. Date < today → past.
 *   3. Date > today → not past.
 *   4. Date === today:
 *      a. end_time provided → past iff end_time ≤ now. An event
 *         that started 30 minutes ago but runs another two hours
 *         is STILL relevant — the previous "past iff start_time
 *         < now" check was wrong and hid ongoing events from the
 *         live search and the newsletter.
 *      b. end_time missing, start_time provided → grace period.
 *         Without a duration signal we'd either be too eager
 *         (filtering at start_time, hiding ongoing activities)
 *         or too lazy (never filter today's events, surfacing
 *         already-finished morning events at 9pm). 90 minutes
 *         after start_time is a practical middle ground that
 *         matches typical city activities (workshops/playgroups/
 *         garden hours).
 *      c. start_time missing → not past (no temporal signal).
 *
 * Backwards-compatible: callers that don't yet pass end_time get
 * the safer (b) behaviour rather than the old aggressive "past at
 * start_time" cut.
 */
const DEFAULT_DURATION_GRACE_MIN = 90;

function isEventInPast(dateStr, startTime = null, endTime = null) {
  if (!dateStr) return false; // missing date — let upstream decide
  const today = todayISO();
  const onlyDate = String(dateStr).slice(0, 10);
  if (onlyDate < today) return true;
  if (onlyDate > today) return false;

  const now = currentTimeHHMM();
  // Same-day comparison helper: HH:MM strings compare
  // lexicographically when both are zero-padded to 5 chars.
  if (endTime) {
    const t = String(endTime).slice(0, 5);
    return t <= now;
  }
  if (!startTime) return false;

  const start = String(startTime).slice(0, 5);
  const [sh, sm] = start.split(":").map((n) => Number(n) || 0);
  const expiredMin = sh * 60 + sm + DEFAULT_DURATION_GRACE_MIN;
  const [nh, nm] = now.split(":").map((n) => Number(n) || 0);
  const nowMin = nh * 60 + nm;
  return nowMin > expiredMin;
}

/**
 * Long, human-readable "today is …" string in English for Gemini prompts.
 * E.g. "Saturday, May 2, 2026".
 */
function todayHumanEN() {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date());
}

/**
 * Pattern matching admin / non-event entries that occasionally leak into
 * the Smarticket feed. These are NEVER real ticketed events — they're
 * back-office payment links that should be filtered out before users
 * see them.
 *
 * Patterns observed in the wild:
 *   - "השלמת תשלום" / "סדנאות ופעילות-השלמת תשלום ..."  (mbe-rg #19842)
 *   - "לינק לתשלום"                                      (ramat-gan #3646)
 *
 * The Trans community pages on ramat-gan use "לינק לתשלום" as a
 * recurring monthly payment-link entry that surfaces in the calendar
 * with a real start_date / start_time. It looks like an event by
 * structure but isn't. Adding the regex catches both Hebrew and the
 * occasional English variants admins try.
 */
const ADMIN_NAME_PATTERNS = [
  /השלמת תשלום/i,
  /לינק לתשלום/i,
  /payment completion/i,
  /payment link/i,
  // Test stubs the venues publish ("טסט לבחינת API", "טסט למופע רב אירועים",
  // "סדנת נגרות טסט"). Anchored to the WHOLE WORD "טסט" so it never matches it
  // mid-word — e.g. "טסטוסטרון" (testosterone) must NOT be treated as a test.
  /(^|\s)טסט(\s|$)/u,
];

function isAdminEntry(name) {
  if (!name) return false;
  return ADMIN_NAME_PATTERNS.some((re) => re.test(name));
}

/**
 * Detect "service catalog" rows in the Smarticket calendar response.
 *
 * Smarticket lets municipalities use the same `get_events_calendar`
 * endpoint to sell non-events: library fees, photocopy/scan/fax
 * credits, kiln-access slots, craft-material purchases, annual
 * memberships, etc. They look like events in the JSON but they're
 * really just billing endpoints — there's no real date or time, and
 * they show up in EVERY calendar query because Smarticket rolls
 * their date forward to "today" each day.
 *
 * Real-world examples (ramat-gan, 2026-05):
 *   #320  "תשלומי ספרייה"      (1038 stock — printing, fines, etc.)
 *   #434  "רכישת חומרים"       (281 stock — craft materials)
 *   #1502 "שימוש בתנור קרמיקה"  (48 stock — kiln slots)
 *
 * Two-part heuristic, both required:
 *   1. `website_visibility_end = 9999-12-31` — the "perpetual"
 *      marker. Real events have a real expiry; services use 9999.
 *   2. `website_left_tickets_count > 30` — services routinely show
 *      hundreds in stock. Real recurring classes (e.g. weekly
 *      woodworking workshop) ALSO use the 9999 marker but ship with
 *      small per-occurrence stock (3-15), so we keep them.
 *
 * The threshold (30) was chosen empirically — see the smoke probe
 * data in the migration commit. Bump it if a real workshop ever
 * trips the filter; lower it if a service slips past.
 */
function isServiceEntry(e) {
  if (!e || typeof e !== "object") return false;
  const visibilityEnd = e.website_visibility_end || "";
  const isPerpetual = visibilityEnd.startsWith("9999");
  if (!isPerpetual) return false;
  const ticketsLeft = Number(e.website_left_tickets_count) || 0;
  return ticketsLeft > 30;
}

/**
 * Detect Smarticket QA / sandbox events that leak onto the live
 * calendar.
 *
 * Single signal: `website_left_tickets_count < 0`. Smarticket's QA
 * team uses negative stock as a marker on test events (e.g. ramat-gan
 * #1174/#1826/#1827 all sit at -1/-3/-2). The same value also appears
 * on the rare oversold real show — but oversold means "no tickets
 * sellable" anyway, so dropping those rows is harmless: the bot can't
 * route a user to a bookable URL for them either way.
 *
 * Note that this rule does NOT catch every test event. Some test
 * events on mbe-rg ship with positive stock (#15693 = 14 tickets).
 * We accept that gap deliberately — the user explicitly opted for
 * the negative-tickets-only rule because adding name-pattern matching
 * risked false positives across Hebrew/Russian/English titles.
 */
function isTestEntry(e) {
  if (!e || typeof e !== "object") return false;
  const tickets = Number(e.website_left_tickets_count);
  return Number.isFinite(tickets) && tickets < 0;
}

/**
 * True if the given date string (YYYY-MM-DD) is a valid future-or-today date
 * in Israel time. Anything in the past, malformed, or NaN is rejected.
 */
function isFutureOrToday(dateStr) {
  if (!dateStr || typeof dateStr !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}/.test(dateStr)) return false;
  const today = todayISO();
  return dateStr.slice(0, 10) >= today;
}

const HEBREW_MONTHS = [
  "ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני",
  "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר",
];

function isoToHebrewDate(iso) {
  if (!iso) return null;
  const [, m, d] = iso.split("-").map(Number);
  if (!m || !d) return null;
  return `${d} ב${HEBREW_MONTHS[m - 1]}`;
}

/**
 * Natural-language Hebrew label for a [from, to] inclusive date window.
 * Used by the agent so its `intro_text` can naturally announce the search
 * scope ("הנה מה שמצאתי בשבועיים הקרובים") instead of dropping the user
 * into a list with no temporal context.
 *
 * Recognises canonical windows that the bot uses by default or via date
 * presets (today / tomorrow / this-week / next-week / 14-days / 30-days).
 * Anything else falls back to a literal Hebrew range ("בין 4 במאי ל-18 במאי").
 */
function describeWindowHe(fromISO, toISO) {
  if (!fromISO || !toISO) return null;
  const today = todayISO();
  const tomorrow = addDaysISO(today, 1);

  if (fromISO === toISO) {
    if (fromISO === today) return "להיום";
    if (fromISO === tomorrow) return "למחר";
    return `ל-${isoToHebrewDate(fromISO)}`;
  }

  const week = weekRangeIL();
  if (fromISO === week.startISO && toISO === week.endISO) return "השבוע";

  const nextWeek = nextWeekRangeIL();
  if (fromISO === nextWeek.startISO && toISO === nextWeek.endISO) return "בשבוע הבא";

  if (fromISO === today) {
    if (toISO === addDaysISO(today, 6)) return "בשבוע הקרוב";
    if (toISO === addDaysISO(today, 13) || toISO === addDaysISO(today, 14)) return "בשבועיים הקרובים";
    if (toISO === addDaysISO(today, 30)) return "בחודש הקרוב";
    // Wide open-ended window ("upcoming" default) — a date span here is
    // meaningless to the user; just call it "הקרובים".
    if (toISO >= addDaysISO(today, 60)) return "הקרובים";
  }

  return `בין ${isoToHebrewDate(fromISO)} ל-${isoToHebrewDate(toISO)}`;
}

module.exports = {
  TZ,
  todayISO,
  todayHumanEN,
  currentTimeHHMM,
  dayOfWeekIL,
  weekRangeIL,
  nextWeekRangeIL,
  monthAheadRangeIL,
  isEventInPast,
  isAdminEntry,
  isServiceEntry,
  isTestEntry,
  isFutureOrToday,
  ADMIN_NAME_PATTERNS,
  addDaysISO,
  describeWindowHe,
  isoToHebrewDate,
};
