// Display helpers for event cards (Hebrew, Israel-locale).

const HEBREW_DAYS = [
  "ראשון",
  "שני",
  "שלישי",
  "רביעי",
  "חמישי",
  "שישי",
  "שבת",
];

const HEBREW_MONTHS = [
  "ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני",
  "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר",
];

/**
 * Format a YYYY-MM-DD (or anything Date can parse) into the Hebrew long
 * form "יום שני, 4 במאי 2026". Returns the original string on parse failure.
 */
function formatHebrewDate(input) {
  if (!input) return "";
  // Accept "2026-05-04" or "2026-05-04T..." etc. Avoid timezone drift by
  // pulling Y/M/D directly when possible.
  const ymd = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(input));
  let date;
  if (ymd) {
    date = new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]));
  } else {
    date = new Date(input);
  }
  if (Number.isNaN(date.getTime())) return String(input);

  const day = HEBREW_DAYS[date.getDay()];
  const dom = date.getDate();
  const month = HEBREW_MONTHS[date.getMonth()];
  const year = date.getFullYear();
  return `יום ${day}, ${dom} ב${month} ${year}`;
}

/**
 * Pick a topic-appropriate emoji for an event card.
 *
 * Strategy: collapse the event's signals (tags + name + event_title)
 * into ONE haystack and walk TOPIC_RULES in tier order — first rule
 * that matches anywhere in the bag wins. The rules are ordered
 * specific-→-general so a name that mentions "גיטרה" beats a tag of
 * "מוזיקה", "סדנת ריקוד" lands on 💃 instead of 🎓, and a tag of
 * "ל״ג בעומר" beats a tag of "יצירה" because holidays sit in Tier 0.
 *
 * We prefer one combined pass over "tags then name" because tags can
 * be sparse / generic ("מוזיקה" only) while the name carries the
 * specific signal ("גולי והגיטרה"); a tags-first scheme would lock in
 * 🎵 before ever looking at the name. Conversely, a name-first scheme
 * would miss tag-only signals like ["שבועות"] on a generic-named row.
 *
 * Falls back to 🎪 — the generic family-show emoji and the right
 * answer for most miscellaneous Smarticket entries.
 */
// Tier headers in comments mark the priority logic — keep new rules in
// the right tier or you'll regress the "guitar beats music" / "yoga
// beats babies" / "Lag B'Omer beats art" cases.
const TOPIC_RULES = [
  // ── Tier 0: Holidays (highest priority — most thematic) ─────────────
  // A holiday-themed art workshop (ל״ג בעומר tag + יצירה tag) reads as
  // a holiday event before it reads as a generic art workshop. Same
  // logic for חנוכה / שבועות / פורים — the timely angle is what makes
  // the event distinctive at a glance.
  // Standardised tag spellings match the labels table: "ל״ג בעומר",
  // "שבועות", "פסח", "חנוכה", "יום העצמאות".
  { icon: "🔥", patterns: [/ל['"׳״]?ג בעומר/, /לג בעומר/, /\blag b[' ]?omer\b/i] },
  { icon: "🌾", patterns: [/שבועות/, /\bshavuot\b/i, /ביכורים/] },
  { icon: "🕯️", patterns: [/חנוכה/, /\bhanukk?ah\b/i, /\bchanukah\b/i] },
  { icon: "🍷", patterns: [/פסח/, /\bpassover\b/i, /הגדה/] },
  // Purim wears 🎭 too (masks) — duplicating the icon is fine; the
  // Tier 6 theater entry covers non-Purim plays without ambiguity.
  { icon: "🎭", patterns: [/פורים/, /\bpurim\b/i] },
  { icon: "🍎", patterns: [/ראש השנה/, /\brosh hashana/i] },
  { icon: "🇮🇱", patterns: [/יום העצמאות/, /\bindependence day\b/i] },

  // ── Tier 1: Specific instruments / dance styles ─────────────────────
  // Guitar BEFORE music so "מוזיקה + גיטרה" → 🎸 not 🎵. Same logic
  // for ballet / classical violin: more specific than the generic music
  // bucket below.
  { icon: "🎸", patterns: [/גיטר/, /\bguitar\b/i] },
  { icon: "🪈", patterns: [/חליל/, /\bflute\b/i, /\brecorder\b/i] },
  { icon: "🥁", patterns: [/תופ/, /\bdrum\b/i] },
  { icon: "🎺", patterns: [/ג['׳]אז/, /jazz/i, /חצוצר/, /\btrumpet\b/i] },
  { icon: "🎻", patterns: [/קלאסי/, /סימפונ/, /\bclassical\b/i, /כינור/, /\bviolin\b/i] },
  { icon: "🩰", patterns: [/מחול/, /בלט/, /\bballet\b/i] },
  { icon: "💃", patterns: [/ריקוד/, /רקדנ/, /\bdance\b/i] },

  // ── Tier 2: Specific physical activities ────────────────────────────
  // Yoga ABOVE babies/parenting so "יוגה לתינוקות" lands on 🧘 (the
  // activity) instead of 👶 (the audience). Same goes for swimming,
  // sports — when the name carries an activity AND an age modifier,
  // the activity wins.
  { icon: "🧘", patterns: [/יוגה/, /\byoga\b/i, /מדיט[צ]?י/, /\bmeditat/i] },
  { icon: "🏊", patterns: [/שחי[יה]/, /בריכה/, /\bswim/i] },
  { icon: "⚽", patterns: [/כדורגל/, /\bsoccer\b/i, /\bfootball\b/i] },
  { icon: "🏀", patterns: [/כדורסל/, /\bbasketball\b/i] },

  // ── Tier 3: Specific creative & food topics ─────────────────────────
  // Specific FIRST so a name carrying both a specific topic (sushi,
  // illustration, science) and a generic "creation" word (יצירה,
  // אומנות) lands on the specific one — same logic as "guitar beats
  // music" in Tier 1, "yoga beats babies" in Tier 2.
  //
  // Order within the tier:
  //   1. Writing / illustration — specific creative outputs.
  //   2. Food (sushi, pizza, cake, baking, cooking) — specific
  //      culinary topics. Placed BEFORE generic art so
  //      "סדנת יצירת עוגת יום הולדת" lands on 🍰 not 🎨.
  //   3. Generic art (יציר/אמנות/ציור/פיסול).
  //   4. Other specific topics (magic, science, books, standup).
  //
  // Holidays still beat the whole tier — "סדנת בישול לשבועות" lands
  // on 🌾 (Tier 0), matching the convention that the most-distinctive
  // angle wins.
  { icon: "✏️", patterns: [/כתיב/, /\bwriting\b/i, /\bwriter\b/i] },
  { icon: "🖍️", patterns: [/איור/, /\billustrat/i, /\bdrawing\b/i] },
  // Food cluster — specific items first; cooking/baking are generic
  // fallbacks for events with no more specific cue.
  { icon: "🍣", patterns: [/סושי/, /\bsushi\b/i] },
  { icon: "🍕", patterns: [/פיצה/, /\bpizza\b/i] },
  // Cake forms: עוגה / עוגת / עוגות / עוגיה / עוגיות. Explicit
  // suffix list avoids false-positives like "מעוגן" (anchored) /
  // "עוגן" (anchor).
  { icon: "🍰", patterns: [/עוג(?:ה|ות|יה|יות|ת)/, /קונדיטור/, /\bcake\b/i, /\bpastr/i] },
  // Baking forms: אפיה / אפייה / אפיית (construct state, very common
  // in titles: "סדנת אפיית חלות"). `אפי[יה]` covers all three without
  // matching אפילו / אפיק / אפיון.
  { icon: "🥐", patterns: [/אפי[יה]/, /מאפ[יה]/, /\bbaking\b/i] },
  { icon: "🍳", patterns: [/בישול/, /\bcooking\b/i, /\bchef\b/i, /\bculinary\b/i] },
  // Generic art / craft — fires when nothing more specific matched.
  { icon: "🎨", patterns: [/יציר/, /יוצרים/, /אמנות/, /אומנות/, /ציור/, /פיסול/, /\bart\b/i, /\bcraft\b/i] },
  { icon: "🪄", patterns: [/קס[םמ]/, /קוסמ?/, /\bmagic\b/i, /\bclown\b/i, /ליצנ?/] },
  { icon: "🧪", patterns: [/מדע/, /\bscience\b/i, /ניסויים/, /רובוטיקה/, /\brobot/i] },
  { icon: "📚", patterns: [/סיפור/, /ספרי[יה]/, /\bbook\b/i, /\bstory\b/i, /\bstories\b/i, /קריאה/] },
  { icon: "🎤", patterns: [/סטנדאפ/, /סטנד אפ/, /\bstand[- ]?up\b/i, /קריוקי/, /\bkaraoke\b/i] },

  // ── Tier 4: Audience-targeting topics (parenting / babies) ──────────
  // Only fire when no Tier 1-3 specific activity matched — that's why
  // they're below yoga/swimming/etc. "קליניקת הנקה" / "ייעוץ הורות"
  // have no activity-word to compete with, so 🤱 / 👨‍👩‍👧 land here.
  { icon: "🤱", patterns: [/הנקה/, /\bbreast[- ]?feed/i, /\blactation\b/i] },
  { icon: "👶", patterns: [/תינוק/, /\bbab(?:y|ies)\b/i, /\binfant\b/i] },
  { icon: "👨‍👩‍👧", patterns: [/הור[ויו]ת/, /\bparent(?:ing|s)?\b/i] },

  // ── Tier 5: Animals / nature ────────────────────────────────────────
  { icon: "🦒", patterns: [/ספארי/, /חיות/, /\bsafari\b/i, /\bzoo\b/i] },
  { icon: "🌳", patterns: [/טיול/, /טבע/, /\bnature\b/i, /יער/, /פארק/i] },

  // ── Tier 6: Entertainment formats ───────────────────────────────────
  { icon: "🎭", patterns: [/תיאטרון/, /מחזה/, /הצג/, /\btheater\b/i, /\btheatre\b/i] },
  { icon: "🎬", patterns: [/הקרנ/, /קולנוע/, /סרט/, /סינמטק/, /\bcinema\b/i, /\bfilm\b/i, /\bmovie\b/i] },

  // ── Tier 7: Generic genres (after specific instruments and formats) ─
  // Music covers concerts, performances, and singing. Both מופע (the
  // common Hebrew form for "show / performance") and הופע (the verb
  // stem) are matched — we used to miss "מופע חנה כהן" because only
  // הופע was listed.
  { icon: "🎵", patterns: [/קונצרט/, /מופע/, /הופע/, /\bconcert\b/i, /מוזיק/, /\bmusic\b/i, /שירה/] },
  { icon: "🤸", patterns: [/ספורט/, /התעמל/, /\bsport\b/i, /\bgym\b/i] },

  // ── Tier 8: Family-life venues ──────────────────────────────────────
  // Smarticket Ramat Gan uses "משחקייה" almost exclusively for parent-
  // and-baby drop-in centers, not video-game arcades — hence 🍼 over 🎮.
  { icon: "🍼", patterns: [/משחקי[יה]ת?/, /\bplay\s*center\b/i, /\bplaygroup\b/i] },
  { icon: "🎂", patterns: [/יום\s+הולדת/, /חגיג/, /\bbirthday\b/i, /\bparty\b/i] },

  // ── Tier 9: Activity types (lowest priority) ────────────────────────
  // Workshops, lectures and tours describe FORM, not topic. They sit
  // last so "סדנת ריקוד" / "הרצאה על מדע" land on the topic-emoji
  // (💃 / 🧪) and only fall through to 🎓 / 🧭 when nothing more
  // specific fired.
  { icon: "🎓", patterns: [/הרצא/, /סדנ[אה]/, /סדנת/, /\blecture\b/i, /\bworkshop\b/i] },
  { icon: "🧭", patterns: [/\bסיור\b|^סיור|סיור /, /\btour\b/i, /\bguided\b/i] },
];

function getEventIcon(event) {
  const tags = Array.isArray(event?.tags) ? event.tags.filter((t) => typeof t === "string") : [];
  const name = (event?.name || event?.event_title || "").trim();
  // \u0001 (SOH) is a safe separator — it can't appear in either source
  // and prevents accidental cross-field matches like "אומנות" + "ב" → "אומנותב".
  const haystack = [...tags, name].filter(Boolean).join(" \u0001 ");
  if (!haystack) return "🎪";
  for (const rule of TOPIC_RULES) {
    if (rule.patterns.some((re) => re.test(haystack))) return rule.icon;
  }
  return "🎪";
}

/**
 * Render a time field for an event card. Accepts either:
 *   - a start time alone ("17:00")           → "17:00"
 *   - start + end                            → "17:00-18:30"
 *   - HH:MM:SS variants — seconds are stripped
 * Returns "" when nothing usable is provided.
 */
function formatTimeRange(start, end) {
  const trim = (t) => {
    if (!t) return "";
    const s = String(t).trim();
    // Postgres TIME columns serialize as "HH:MM:SS"; we only want HH:MM.
    const m = /^(\d{1,2}:\d{2})/.exec(s);
    return m ? m[1] : s;
  };
  const a = trim(start);
  const b = trim(end);
  if (!a) return "";
  if (b && a !== b) return `${a}-${b}`;
  return a;
}

// Right-to-Left Mark (U+200F). Prepend to every card line so Telegram
// resolves the paragraph direction to RTL — the first strong character
// the bidi algorithm sees is the RLM, so the line is laid out RTL
// regardless of what comes next.
//
// Why unconditional (not "only when no Hebrew")
//   The earlier version skipped lines that contained ANY Hebrew letter,
//   on the assumption that the Hebrew itself would anchor the line as
//   RTL. That breaks for lines whose content STARTS with strong-LTR
//   characters (Latin / digits) BEFORE any Hebrew — e.g.
//   "🌾 SHAVUOT PARTY +מסיבה בלבן לגילאי 35-". The first strong char
//   the OS bidi pass encounters is the `S` of SHAVUOT, so paragraph
//   direction resolves to LTR and the whole line — Hebrew included —
//   gets left-aligned. Prepending RLM unconditionally fixes that with
//   zero side-effects (RLM in front of an already-Hebrew line is an
//   invisible no-op).
const RLM = "\u200F";

/**
 * Force a line to render RTL on Telegram regardless of which script
 * happens to come first inside it. The single invisible RLM prefix is
 * always strong-RTL, so the bidi algorithm anchors the paragraph as
 * RTL and embedded LTR runs (English words, numbers, times) flow
 * inside the RTL frame.
 */
function rtlLine(text) {
  if (!text) return text;
  // Idempotent — if the caller already prepended an RLM (or the central
  // tg.reply wrapper applied this helper before us), don't stack another.
  // RLM is U+200F, a zero-width invisible mark; doubling it wouldn't
  // BREAK rendering but it would waste bytes and make the output
  // marginally harder to reason about.
  if (text.charCodeAt(0) === 0x200F) return text;
  return `${RLM}${text}`;
}

/**
 * Render an event's tags as a single visual line for the card.
 *
 * The point is to surface the topic at-a-glance ("מוזיקה • התפתחות •
 * ל״ג בעומר") so the user doesn't have to tap "פרטים" to know what
 * the event is about.
 *
 * Two highlight sets affect ORDERING (not visual markers — we used to
 * prefix matched tags with 🔍 / ⭐ but it made the line noisy; now
 * everything renders as plain text after the leading 🏷️):
 *   - `searchHits`  → tag matched the user's CURRENT search. Pulled to
 *                     the very front of the line so the reason the
 *                     event surfaced is the first thing the user reads.
 *   - `highlight`   → tag matches the user's saved interests. Pulled
 *                     ahead of plain tags but behind search hits.
 * Search hits win when a tag qualifies for both — it answers the
 * user's "why is this in my results?" question more directly.
 *
 * Returns `null` when there's nothing to render. The caller decides
 * whether to push a line; we don't want an empty `🏷️ ` floating in
 * the card.
 */
function formatTagLine(tags, { highlight, searchHits, max = 4 } = {}) {
  if (!Array.isArray(tags) || !tags.length) return null;
  const norm = (t) => String(t || "").toLowerCase().trim();
  const interestSet = new Set([...(highlight || [])].map(norm));
  const searchSet = new Set([...(searchHits || [])].map(norm));

  // Walk tags once, classify each into one of three buckets so we can
  // emit search-matched tags first, then personal-interest, then plain.
  // Order is the ONLY signal — no per-tag glyphs (we removed the
  // 🔍 / ⭐ prefixes because the line read as "🏷️ 🔍 מוזיקה • ⭐
  // התפתחות" which was visually busy).
  const hits = [];
  const stars = [];
  const plain = [];
  const seen = new Set();
  for (const raw of tags) {
    const name = String(raw || "").trim();
    if (!name) continue;
    const k = name.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    if (searchSet.has(k)) hits.push(name);
    else if (interestSet.has(k)) stars.push(name);
    else plain.push(name);
  }

  const ordered = [...hits, ...stars, ...plain].slice(0, max);
  if (!ordered.length) return null;
  return `🏷️ ${ordered.join(" • ")}`;
}

module.exports = {
  formatHebrewDate,
  formatTimeRange,
  formatTagLine,
  getEventIcon,
  rtlLine,
  HEBREW_DAYS,
  HEBREW_MONTHS,
};
