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
 * The event `description` is included in full (normalized) so a generic
 * title ("החוג של קרן") still picks up גיטרה/ריקוד from the blurb.
 * No per-brand icon overrides — when the text isn't enough, 🎪 fallback
 * is acceptable.
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

  // ── Tier 1: Specific instruments & dance styles ──────────────────────
  { icon: "🎸", patterns: [/גיטר/, /\bguitar\b/i] },
  { icon: "🪈", patterns: [/חליל/, /\bflute\b/i, /\brecorder\b/i] },
  { icon: "🥁", patterns: [/תופ/, /\bdrum\b/i] },
  { icon: "🎺", patterns: [/ג['׳]אז/, /jazz/i, /חצוצר/, /\btrumpet\b/i] },
  { icon: "🎻", patterns: [/קלאסי/, /סימפונ/, /\bclassical\b/i, /כינור/, /\bviolin\b/i] },
  { icon: "🪗", patterns: [/אקורדיון/, /\baccordion\b/i] },
  { icon: "🪘", patterns: [/\bג'מב[הה]\b/, /\bdjembe\b/i, /תיפוף/, /\bpercussion\b/i] },
  { icon: "🎹", patterns: [/פסנתר/, /\bpiano\b/i, /\bkeyboard\b/i] },
  { icon: "🩰", patterns: [/מחול/, /בלט/, /\bballet\b/i] },
  { icon: "💃", patterns: [/ריקוד/, /רקדנ/, /זומב[אה]/, /\bdance\b/i, /\bzumba\b/i, /\bsalsa\b/i, /\btango\b/i] },
  { icon: "🎙️", patterns: [/ספוקן/, /\bspoken.?word\b/i, /\bpoetry.?slam\b/i] },

  // ── Tier 2: Specific physical activities ────────────────────────────
  { icon: "🧘", patterns: [/יוגה/, /\byoga\b/i, /מדיט[צ]?י/, /\bmeditat/i, /\bpilates\b/i, /פילאטיס/] },
  { icon: "🏊", patterns: [/שחי[יה]/, /בריכה/, /\bswim/i] },
  { icon: "⚽", patterns: [/כדורגל/, /\bsoccer\b/i, /\bfootball\b/i] },
  { icon: "🏀", patterns: [/כדורסל/, /\bbasketball\b/i] },
  { icon: "🏐", patterns: [/כדורעף/, /\bvolleyball\b/i] },
  { icon: "🎾", patterns: [/טניס/, /\btennis\b/i] },
  { icon: "🏓", patterns: [/פינג[- ]?פונג/, /טניס שולחן/, /\bping.?pong\b/i, /\btable.?tennis\b/i] },
  { icon: "🥊", patterns: [/אגרוף/, /קיקבוקס/, /\bboxing\b/i, /\bkickbox/i, /\bmuay.?thai\b/i, /אומנויות לחימה/, /קרב מג[ען]/] },
  { icon: "🥋", patterns: [/קראטה/, /ג['׳]ודו/, /קונג.?פו/, /\bkarate\b/i, /\bjudo\b/i, /\bkung.?fu\b/i, /\bjiu.?jitsu\b/i, /\btaekwondo\b/i] },
  { icon: "🏃", patterns: [/ריצה/, /מרוץ/, /\brunning\b/i, /\bmarathon\b/i, /\b5k\b/i] },
  { icon: "🚴", patterns: [/אופניים/, /רכיבה על אופ/, /\bcycling\b/i, /\bbiking\b/i] },
  { icon: "🧗", patterns: [/טיפוס/, /\bclimbing\b/i, /\bbouldering\b/i] },
  { icon: "🏄", patterns: [/גלישה/, /\bsurfing\b/i, /\bsup\b/i] },
  { icon: "🚣", patterns: [/קיאק/, /חתירה/, /\bkayak\b/i, /\browboat\b/i] },
  { icon: "💪", patterns: [/כושר/, /\bfitness\b/i, /\bworkout\b/i, /\bcrossfit\b/i, /\baerobics\b/i, /אירובי/] },

  // ── Tier 3: Specific creative, craft & food topics ───────────────────
  { icon: "🪚", patterns: [/נגר/, /\bwoodwork/i, /\bcarpentry\b/i] },
  { icon: "🏺", patterns: [/קרמיק/, /חרס/, /\bceramics\b/i, /\bpottery\b/i] },
  { icon: "🧶", patterns: [/סריגה/, /אריגה/, /\bknitting\b/i, /\bcrochet\b/i, /\bweaving\b/i] },
  { icon: "🧵", patterns: [/תפירה/, /רקמה/, /\bsewing\b/i, /\bembroidery\b/i] },
  { icon: "📷", patterns: [/צילום/, /\bphotograph/i, /\bcamera\b/i] },
  { icon: "♟️", patterns: [/שחמט/, /\bchess\b/i] },
  { icon: "🧩", patterns: [/פסיפס/, /\bmosaic\b/i] },
  { icon: "🖼️", patterns: [/תערוכה/, /גלריה/, /\bexhibit/i, /\bgallery\b/i] },
  { icon: "✏️", patterns: [/כתיב/, /\bwriting\b/i, /\bwriter\b/i] },
  { icon: "🖍️", patterns: [/איור/, /\billustrat/i, /\bdrawing\b/i] },
  { icon: "🧠", patterns: [/פסיכולוג/, /NLP/, /\bcoaching\b/i, /רווחה נפשית/, /בריאות נפש/] },
  { icon: "🩺", patterns: [/עזרה ראשונה/, /CPR/, /החייאה/, /\bfirst.?aid\b/i] },
  { icon: "🌿", patterns: [/צמחי מרפא/, /ארומתרפי/, /\bherbs?\b/i, /\baromatherapy\b/i] },
  { icon: "🌱", patterns: [/גינון/, /\bgardening\b/i, /\bplanting\b/i] },
  // Food — specific before generic
  { icon: "🍫", patterns: [/שוקולד/, /\bchocolate\b/i] },
  { icon: "☕", patterns: [/קפה/, /\bcoffee\b/i, /\bbarista\b/i] },
  { icon: "🍷", patterns: [/טעימות יין/, /בציר/, /\bwine.?tast/i, /\bwinery\b/i] },
  { icon: "🍣", patterns: [/סושי/, /\bsushi\b/i] },
  { icon: "🍕", patterns: [/פיצה/, /\bpizza\b/i] },
  { icon: "🍰", patterns: [/עוג(?:ה|ות|יה|יות|ת)/, /קונדיטור/, /\bcake\b/i, /\bpastr/i] },
  { icon: "🥐", patterns: [/אפי[יה]/, /מאפ[יה]/, /\bbaking\b/i] },
  { icon: "🍳", patterns: [/בישול/, /\bcooking\b/i, /\bchef\b/i, /\bculinary\b/i] },
  { icon: "🥗", patterns: [/תזונה/, /\bnutrition\b/i, /\bvegan\b/i, /טבעוני/] },
  // Generic art / craft
  { icon: "🎨", patterns: [/יציר/, /יוצרים/, /אמנות/, /אומנות/, /ציור/, /פיסול/, /\bart\b/i, /\bcraft\b/i] },
  { icon: "🪄", patterns: [/קס[םמ]/, /קוסמ?/, /\bmagic\b/i, /\bclown\b/i, /ליצנ?/] },
  { icon: "🧪", patterns: [/מדע/, /\bscience\b/i, /ניסויים/, /רובוטיקה/, /\brobot/i] },
  { icon: "📚", patterns: [/סיפור/, /ספרי[יה]/, /\bbook\b/i, /\bstory\b/i, /\bstories\b/i, /קריאה/, /ספרות/] },
  { icon: "🎤", patterns: [/סטנדאפ/, /סטנד אפ/, /\bstand[- ]?up\b/i, /קריוקי/, /\bkaraoke\b/i, /מונולוג/] },
  { icon: "💆", patterns: [/עיסוי/, /\bmassage\b/i, /\bspa\b/i, /ספא/] },
  { icon: "💅", patterns: [/מניקור/, /פדיקור/, /\bmanicure\b/i, /\bnail\b/i] },

  // ── Tier 4: Audience-targeting topics ───────────────────────────────
  { icon: "🤱", patterns: [/הנקה/, /\bbreast[- ]?feed/i, /\blactation\b/i] },
  { icon: "👶", patterns: [/תינוק/, /\bbab(?:y|ies)\b/i, /\binfant\b/i] },
  { icon: "👨‍👩‍👧", patterns: [/הור[ויו]ת/, /\bparent(?:ing|s)?\b/i] },
  { icon: "👴", patterns: [/גיל.?הזהב/, /גיל.?שלישי/, /\bsenior\b/i, /\belderl/i] },

  // ── Tier 5: Animals / nature ─────────────────────────────────────────
  { icon: "🎈", patterns: [/בלון/, /בלונים/, /קיץ של בלון/, /\bballoon/i] },
  { icon: "🦒", patterns: [/ספארי/, /חיות/, /\bsafari\b/i, /\bzoo\b/i] },
  { icon: "🐾", patterns: [/כלבים/, /חיי מחמד/, /\bpets?\b/i, /\bdogs?\b/i] },
  { icon: "🌳", patterns: [/טיול/, /טבע/, /\bnature\b/i, /יער/, /פארק/i, /גינ[אה]/] },

  // ── Tier 6: Entertainment formats ────────────────────────────────────
  { icon: "🎪", patterns: [/קרקס/, /\bcircus\b/i, /אקרובט/, /\bacrobat/i] },
  { icon: "🎭", patterns: [/תיאטרון/, /מחזה/, /הצג/, /\btheater\b/i, /\btheatre\b/i, /אימפרוביזציה/, /\bimprov\b/i] },
  { icon: "🎬", patterns: [/הקרנ/, /קולנוע/, /סרט/, /סינמטק/, /\bcinema\b/i, /\bfilm\b/i, /\bmovie\b/i] },

  // ── Tier 7: Generic genres ────────────────────────────────────────────
  { icon: "🎵", patterns: [/קונצרט/, /מופע/, /הופע/, /\bconcert\b/i, /מוזיק/, /\bmusic\b/i, /שירה/, /שירים/] },
  { icon: "🤸", patterns: [/ספורט/, /התעמל/, /\bsport\b/i, /\bgym\b/i, /ג['׳]ימבורי/, /\bgym\s*boree\b/i] },
  { icon: "🕍", patterns: [/שיעור\s+תורה/, /לימוד\s+תורה/, /גמרא/, /הלכה/, /פרשת\s+שבוע/] },

  // ── Tier 8: Family-life venues ────────────────────────────────────────
  { icon: "🍼", patterns: [/משחקי[יה]ת?/, /\bplay\s*center\b/i, /\bplaygroup\b/i] },
  { icon: "🎂", patterns: [/יום\s+הולדת/, /חגיג/, /\bbirthday\b/i, /\bparty\b/i] },

  // ── Tier 9: Activity types (lowest priority — form, not topic) ─────────
  { icon: "🎓", patterns: [/הרצא/, /סדנ[אה]/, /סדנת/, /חוג/, /\blecture\b/i, /\bworkshop\b/i] },
  { icon: "🧭", patterns: [/\bסיור\b|^סיור|סיור /, /\btour\b/i, /\bguided\b/i] },
  { icon: "🤝", patterns: [/\bמפגש\b/, /\bכנס\b/, /\bפורום\b/, /\bהפנינג\b/] },
];

function getEventIcon(event) {
  const tags = Array.isArray(event?.tags) ? event.tags.filter((t) => typeof t === "string") : [];
  const name = (event?.name || event?.event_title || "").trim();
  const category = typeof event?.category === "string" ? event.category.trim() : "";
  const description =
    typeof event?.description === "string"
      ? event.description.replace(/\s+/g, " ").trim()
      : "";
  // \u0001 (SOH) is a safe separator — it can't appear in either source
  // and prevents accidental cross-field matches like "אומנות" + "ב" → "אומנותב".
  // Haystack = tags + title + category + full description (tier order picks
  // the most specific topic — e.g. גיטרה in the blurb before generic חוג).
  const haystack = [...tags, name, category, description].filter(Boolean).join(" \u0001 ");
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

// Adult-tier age gate line ("🎯 לגילאי 35+" / "🎯 לגילאי 18-35").
//
// Purpose
//   Surfaces an age restriction on the event card so users see it at
//   a glance — not just buried in `min_months`/`max_months` columns
//   that drive backend filtering. Born from the May-2026 observation
//   that parties advertised "35+" / "18-35" / "60+" rendered with no
//   visual indication of the door-policy: the audience-tier filter
//   was working, but the card itself looked identical to a fully
//   open party.
//
// Scope (deliberately narrow)
//   We only emit this line when BOTH conditions hold:
//     1. `audience === 'מבוגרים'` (adult tier). Kid / baby / teen
//        events have their own age-display path (`🧒 לגילאי 4, 9`
//        in the saved-search facet line). Mixing in a second
//        adult-only formatter would either duplicate that line or
//        confuse the kid-age semantics ("28 חודשים" vs "35 שנים").
//     2. `min_months >= 216` (= 18+). The 216 floor is just the
//        default "adult event" baseline we stamp via Gemini when
//        nothing more specific is known. Stricter thresholds (420
//        for "35+", 720 for "60+") render with a visible number;
//        the default 18+ also gets a "לגילאי 18+" line so the
//        consistency holds — bouncer-style age policy IS the norm
//        at most Smarticket parties.
//
// Format
//   • `min` only (no max)               → "🎯 לגילאי X+"
//   • `min` and `max` (both set)        → "🎯 לגילאי X-Y"
//   • `max` only (unusual; safety net)  → "🎯 לגילאי עד Y"
//   • Neither / non-adult audience      → null (no line)
//
// Emoji choice
//   🎯 (target / bullseye) reads as "this is the cohort the venue
//   targets". We avoided 🔞 — it carries an adult-content connotation
//   in many users' mental model, and these parties are age-gated, NOT
//   18+ content. 🎯 is neutral and matches the spirit of the audience
//   facet without implying anything about the content itself.
// Enricher stores 1200 months (= 100y) as "no upper age bound" for
// לכל המשפחה / all-ages events. Must not render as "לידה עד 100 שנים".
const OPEN_AGE_MAX_MONTHS = 1200;

function isCanonicalFamilyAgeRange(min, max) {
  if (min == null && max == null) return true;
  if (min === 0 && (max == null || max >= OPEN_AGE_MAX_MONTHS)) return true;
  return false;
}

// Card title emoji per audience (umbrella / הורים rows only — not the
// audience-target line; that always uses AUDIENCE_LINE_ICON).
const AUDIENCE_ICON = {
  "הורים":        "👪",
  "נוער":         "🧑",
  "ילדים":        "👧",
  "תינוקות":      "👶",
  "מבוגרים":      "🎯",
  "ותיקים":       "👴",
  "לכל המשפחה":  "👨‍👩‍👧",
};

/** Single emoji for every `formatAudienceLine` row (קהל יעד). */
const AUDIENCE_LINE_ICON = "🎯";
const AUDIENCE_FALLBACK_LABEL = {
  "הורים":        "להורים",
  "נוער":         "לנוער",
  "ילדים":        "לילדים",
  "תינוקות":      "לתינוקות",
  "ותיקים":       "אזרחים ותיקים",
  "לכל המשפחה":  "לכל המשפחה",
  // "מבוגרים" absent — generic default, label adds no signal
};

// Parenting / pregnancy event names — when audience is generic מבוגרים
// but the title signals the content is for parents, show "🎯 להורים".
const PARENTING_RE_FORMAT = /הורים|הורות|הריון|לידה|הנקה|תינוק|אמהות|אבהות|חיתולים|הכנה\s*ל/u;

function isParentFocusedEvent(event) {
  if (!event) return false;
  if (event.audience === "הורים") return true;
  const hay = [event.name, event.description].filter(Boolean).join(" ");
  return PARENTING_RE_FORMAT.test(hay);
}

/**
 * Two-tier card titles (umbrella primary + child secondary).
 * Parent-focused rows put the topic emoji on the secondary line — the
 * specific session title — not on the umbrella branding line.
 */
function resolveEventTitleParts(event) {
  const umbrellaTitleTrim =
    typeof event?.umbrella_title === "string" && event.umbrella_title.trim()
      ? event.umbrella_title.trim()
      : null;
  const nameTrim = typeof event?.name === "string" ? event.name.trim() : "";
  const primaryTitle = umbrellaTitleTrim || nameTrim;
  const secondaryTitle =
    umbrellaTitleTrim && nameTrim && nameTrim !== umbrellaTitleTrim
      ? nameTrim
      : null;
  const iconOnSecondary =
    Boolean(secondaryTitle) && isParentFocusedEvent(event);
  const icon =
    event.audience === "הורים"
      ? AUDIENCE_ICON["הורים"]
      : getEventIcon(event);
  return {
    primaryTitle,
    secondaryTitle,
    icon,
    iconOnSecondary,
  };
}

/** Returns 1–2 HTML caption lines (caller supplies escapeHtml). */
function formatEventCardTitleLines(event, escapeHtml) {
  const RLM = "\u200F";
  const { primaryTitle, secondaryTitle, icon, iconOnSecondary } =
    resolveEventTitleParts(event);
  const esc = typeof escapeHtml === "function" ? escapeHtml : (s) => s;
  if (iconOnSecondary) {
    return [
      `${RLM}${esc(primaryTitle)}`,
      `${icon} ${RLM}<b>${esc(secondaryTitle)}</b>`,
    ];
  }
  if (secondaryTitle) {
    return [
      `${icon} ${RLM}${esc(primaryTitle)}`,
      `${RLM}<b>${esc(secondaryTitle)}</b>`,
    ];
  }
  return [`${icon} ${RLM}<b>${esc(primaryTitle)}</b>`];
}

const {
  hasSeniorSignals,
  formatSeniorAudienceLine,
  isSixtyPlusMonths,
} = require("./seniorAudience");

/** @deprecated use hasSeniorSignals from seniorAudience.js */
function isSeniorTargetedEvent(event) {
  return hasSeniorSignals(event);
}

// Grade-range detector for youth events ("כיתות ז'-יב'", "כיתות א-ו", etc.)
// When found in the event name or description it is shown verbatim instead
// of a generic age conversion, since parents/teens recognise grade labels
// better than "13-18" or "שמונה עשרה+".
const GRADE_RANGE_RE = /כיתות?\s+([א-ת]{1,2})[׳']?\s*[-–—]\s*([א-ת]{1,2})[׳']?/u;
const GRADE_SINGLE_RE = /כיתה\s+([א-ת]{1,2})[׳']?(?:\s|$)/u;

function detectGradeRange(name = "", description = "") {
  const text = name + " " + (description || "");
  const range = GRADE_RANGE_RE.exec(text);
  if (range) return `כיתות ${range[1]}-${range[2]}`;
  const single = GRADE_SINGLE_RE.exec(text);
  if (single) return `כיתה ${single[1]}`;
  return null;
}

// Developmental stage keywords for תינוקות events. When found in the
// event name they replace the numeric range (parents know "זוחלים"
// better than "6-10 חודשים"). Only used when explicitly written —
// never inferred from age ranges.
// Multi-stage patterns must come BEFORE single-stage ones so a name like
// "לזחילה עד הליכה" matches "זוחלים-הולכים" and not just "זוחלים".
const BABY_STAGE_PATTERNS = [
  // Exclusions before inclusive birth–crawl ranges ("לידה-זחילה לא כולל")
  { re: /לידה.{0,40}(?:זחיל|זוחל).{0,30}לא\s*כולל/u, label: "לידה (לא זוחלים)" },
  // Range patterns (two stages in one name) — checked first
  { re: /לידה.*הלי|לידה.*הול|יילוד.*הלי/,         label: "לידה-הליכה"    },
  { re: /לידה.*זחיל|יילוד.*זחיל/,                  label: "לידה-זחילה"    },
  { re: /זחיל.*הלי|זחיל.*הול|זוחל.*הלי|זוחל.*הול/, label: "זוחלים-הולכים" },
  {
    re: /מזחילה\s*[-–]\s*שנה\s*ו[\s-]?חצי|זחילה\s*[-–]\s*שנה\s*ו[\s-]?חצי|זוחלים\s*[-–]\s*שנה\s*ו[\s-]?חצי/u,
    label: "זוחלים-שנה וחצי",
  },
  { re: /זחיל.*גמול|זוחל.*גמול|גמול.*הול|גמול.*הלי/, label: "זוחלים-גמול" },
  { re: /גמול.*מוצק|גמול.*אוכל\s*מוצק/,            label: "גמול-אוכל מוצקים" },
  { re: /זחיל.*מוצק|זוחל.*מוצק/,                    label: "זוחלים-אוכל מוצקים" },
  // Single-stage patterns
  { re: /אוכל\s*מוצק|מעבר\s*למוצק|מוצקים/,          label: "אוכל מוצקים" },
  { re: /גמול|גימול|התגמול|הפרדה\s*מחלב/,           label: "גמול"          },
  { re: /יילוד|נולד/,                               label: "יילודים"       },
  { re: /זוחל|זחיל/,                                label: "זוחלים"        },
  { re: /הול[כק]ים?|מתחיל.*ללכת|הלי[כק]/,          label: "הולכים"        },
];

function detectBabyStage(name = "", description = "") {
  const text = `${name || ""} ${description || ""}`.trim();
  if (!text) return null;
  for (const { re, label } of BABY_STAGE_PATTERNS) {
    if (!re.test(text)) continue;
    if (
      label === "לידה-זחילה" &&
      /(?:זחיל|זוחל).{0,30}לא\s*כולל/u.test(text)
    ) {
      continue;
    }
    if (
      label === "זוחלים" &&
      /(?:מ)?זחילה\s*[-–]\s*שנה\s*ו[\s-]?חצי|זוחלים\s*[-–]\s*שנה\s*ו[\s-]?חצי/u.test(text)
    ) {
      continue;
    }
    return label;
  }
  return null;
}

// Infer age bounds from Hebrew title when enricher left max_months null.
// Returns { min_months, max_months } or null when no signal.
function inferAgeBoundsFromName(name = "") {
  const n = String(name || "");
  if (!n.trim()) return null;

  const rangeUpToYear =
    /(?:מלידה|מ-?0|יילוד|לידה).{0,20}עד\s*(?:גיל\s*)?שנה(?!\s*ו)|עד\s*גיל\s*שנה(?!\s*ו)|לגיל\s*לידה\s*עד\s*שנה/u;
  if (rangeUpToYear.test(n)) return { min_months: 0, max_months: 12 };

  const yearToThree = /שנה\s*עד\s*שלוש|שנה-שלוש|שנה\s*[-–]\s*שלוש/u;
  if (yearToThree.test(n)) return { min_months: 12, max_months: 36 };

  const yearHalfToThree =
    /(?:גילאי\s*)?שנה\s*ו[\s-]?חצי\s*[-–]\s*שלוש|לגילאי\s*שנה\s*ו[\s-]?חצי/u;
  if (yearHalfToThree.test(n)) return { min_months: 18, max_months: 36 };

  const crawlToHalfYear =
    /מזחילה\s*[-–]\s*שנה\s*ו[\s-]?חצי|זחילה\s*[-–]\s*שנה\s*ו[\s-]?חצי|זוחלים\s*[-–]\s*שנה\s*ו[\s-]?חצי/u;
  if (crawlToHalfYear.test(n)) return { min_months: 6, max_months: 18 };

  const upToCrawl = /עד\s*זחילה/u;
  if (upToCrawl.test(n)) return { min_months: 0, max_months: 9 };

  const birthNotCrawl =
    /לידה.{0,40}(?:זחיל|זוחל).{0,30}לא\s*כולל/u;
  if (birthNotCrawl.test(n)) return { min_months: 0, max_months: 8 };

  if (/אזרחים\s*ותיקים|הגיל\s*השלישי|גיל\s*60|60\s*\+|for[-_ ]age[-_ ]60/i.test(n)) {
    return { min_months: 720, max_months: null };
  }

  return null;
}

function effectiveEventAgeBounds(event) {
  const min = Number.isFinite(event?.min_months) ? event.min_months : null;
  const max = Number.isFinite(event?.max_months) ? event.max_months : null;
  const inferred = inferAgeBoundsFromName(event?.name || "");
  return {
    min_months: min ?? inferred?.min_months ?? null,
    max_months: max ?? inferred?.max_months ?? null,
  };
}

// Hebrew display for a single age value.
//   < 12 months → "X חודשים"
//   ≥ 12 months → named Hebrew phrase (שנה / שנה וחצי / שנתיים …) or "N שנים"
const _YEAR_STR = {
  12: "שנה", 18: "שנה וחצי", 24: "שנתיים", 30: "שנתיים וחצי",
  36: "שלוש", 48: "ארבע", 60: "חמש", 72: "שש",
  84: "שבע", 96: "שמונה", 108: "תשע", 120: "עשר",
  132: "אחת עשרה", 144: "שתים עשרה", 180: "חמש עשרה", 216: "שמונה עשרה",
};
function monthsToDisplay(m) {
  if (m === 0)   return "לידה";
  if (m < 12)    return `${m} חודשים`;
  if (_YEAR_STR[m]) return _YEAR_STR[m];
  return `${Math.round(m / 12)} שנים`;
}

// Build a human-readable age range string with smart unit handling:
//   min = 0 (לידה)                 → "לידה עד Y"      (always "עד", no "0 חודשים")
//   Both values in months (< 12)   → "X-Y חודשים"     (shared suffix)
//   Both values in years  (≥ 12)   → "X-Y"             (Hebrew year phrases)
//   Mixed units                     → "X חודשים עד Y"  (explicit "עד" separator)
//   Open-ended                      → "X+" / "עד Y"
function formatAgeRange(min, max) {
  if (min == null && max == null) return null;
  if (min != null && max != null) {
    if (min === 0) return `לידה עד ${monthsToDisplay(max)}`;
    const minMonths = min < 12;
    const maxMonths = max < 12;
    if (minMonths && maxMonths)   return `${min}-${max} חודשים`;
    if (!minMonths && !maxMonths) return `${monthsToDisplay(min)}-${monthsToDisplay(max)}`;
    return `${monthsToDisplay(min)} עד ${monthsToDisplay(max)}`;
  }
  if (min != null) return min === 0 ? "מלידה" : `${monthsToDisplay(min)}+`;
  return `עד ${monthsToDisplay(max)}`;
}

/**
 * Returns a single audience/age line for event cards, or null if nothing
 * meaningful to show. Works when `audience` ENUM is null if the title
 * carries an age signal ("עד גיל שנה", "לידה-זחילה", כיתות וכו').
 */
function formatAudienceLine(event) {
  if (!event) return null;

  const min = Number.isFinite(event.min_months) ? event.min_months : null;
  const max = Number.isFinite(event.max_months) ? event.max_months : null;
  const inferred = inferAgeBoundsFromName(event.name || "");
  const effMin = min ?? inferred?.min_months ?? null;
  const effMax = max ?? inferred?.max_months ?? null;

  if (!event.audience) {
    const stage = detectBabyStage(event.name || "", event.description || "");
    if (stage) return `${AUDIENCE_LINE_ICON} ${stage}`;
    const grade = detectGradeRange(event.name || "", event.description || "");
    if (grade) return `${AUDIENCE_LINE_ICON} ${grade}`;
    const range = formatAgeRange(effMin, effMax);
    if (range && (effMin != null || effMax != null)) {
      return `${AUDIENCE_LINE_ICON} ${range}`;
    }
    if (PARENTING_RE_FORMAT.test(event.name || "")) {
      return `${AUDIENCE_LINE_ICON} להורים`;
    }
    return null;
  }

  const icon = AUDIENCE_LINE_ICON;

  // ── תינוקות: stage keyword beats numeric range ──────────────────────
  if (event.audience === "תינוקות") {
    const stage = detectBabyStage(event.name || "", event.description || "");
    if (stage) return `${icon} ${stage}`;
    const range = formatAgeRange(min, max);
    if (range) return `${icon} ${range}`;
    return `${icon} ${AUDIENCE_FALLBACK_LABEL["תינוקות"]}`;
  }

  const seniorLine = formatSeniorAudienceLine(event);
  if (seniorLine) return seniorLine;

  // ── מבוגרים: show range when specific; fallback to generic adult label ──
  if (event.audience === "מבוגרים") {
    const isGenericFloor = min === 216 && max == null;
    if (isGenericFloor) {
      if (PARENTING_RE_FORMAT.test(event.name || "")) {
        return `${AUDIENCE_LINE_ICON} להורים`;
      }
      return `${icon} למבוגרים`;
    }
    const range = formatAgeRange(min, max);
    if (range) return `${icon} ${range}`;
    return `${icon} למבוגרים`;
  }

  // ── לכל המשפחה ───────────────────────────────────────────────────────
  if (event.audience === "לכל המשפחה") {
    const stage = detectBabyStage(event.name || "", event.description || "");
    if (stage) return `${icon} ${stage}`;
    // 0–1200 is the enricher's "all ages" sentinel — show the audience
    // label, not "לידה עד 100 שנים".
    if (isCanonicalFamilyAgeRange(min, max)) {
      if (PARENTING_RE_FORMAT.test(event.name || "")) {
        return `${AUDIENCE_LINE_ICON} להורים`;
      }
      return `${icon} ${AUDIENCE_FALLBACK_LABEL["לכל המשפחה"]}`;
    }
    const range = formatAgeRange(effMin, effMax);
    if (range && (effMin != null || effMax != null)) {
      return `${icon} ${range}`;
    }
    if (PARENTING_RE_FORMAT.test(event.name || "")) {
      return `${AUDIENCE_LINE_ICON} להורים`;
    }
    return `${icon} ${AUDIENCE_FALLBACK_LABEL["לכל המשפחה"]}`;
  }

  // ── ילדים / נוער / הורים ─────────────────────────────────────────────
  // Grade label ("כיתות ז-יב") beats numeric age range
  const grade = detectGradeRange(event.name || "", event.description || "");
  if (grade) return `${icon} ${grade}`;
  const range = formatAgeRange(effMin, effMax);
  if (range) return `${icon} ${range}`;
  const label = AUDIENCE_FALLBACK_LABEL[event.audience];
  return label ? `${icon} ${label}` : null;
}

// Keep the old name as an alias so existing callers don't break while
// we migrate them to formatAudienceLine in the same commit.
const formatAdultAgeGate = formatAudienceLine;

const { kidAgeMonths } = require("./kidAge");

const CRAWL_STAGE_LABELS = new Set(["זוחל", "זוחלים"]);
/** Typical crawl window when birth date is known but stages[] is empty. */
const CRAWL_MONTHS_MIN = 6;
const CRAWL_MONTHS_MAX = 11;

function eventTextHaystack(event) {
  return [event?.name, event?.description].filter(Boolean).join(" ");
}

/** Title/description says crawlers are not welcome (e.g. "לידה-זחילה לא כולל"). */
function eventExcludesCrawlers(event) {
  const text = eventTextHaystack(event);
  if (!text) return false;
  if (/לידה.{0,40}(?:זחיל|זוחל).{0,30}לא\s*כולל/u.test(text)) return true;
  if (/(?:לא\s*כולל(?:ים|ות)?|ללא|בלי).{0,25}(?:זוחל|זחיל)/u.test(text)) return true;
  if (/(?:זוחל|זחיל).{0,30}(?:לא\s*כולל|מלבד)/u.test(text)) return true;
  return false;
}

function kidProfileIsCrawler(kid, asOf = new Date()) {
  const stages = Array.isArray(kid?.stages) ? kid.stages : [];
  if (stages.some((s) => CRAWL_STAGE_LABELS.has(String(s).trim()))) return true;
  const months = kidAgeMonths(kid, asOf);
  return (
    months != null && months >= CRAWL_MONTHS_MIN && months <= CRAWL_MONTHS_MAX
  );
}

function kidConflictsEventExclusions(event, kids) {
  if (!eventExcludesCrawlers(event)) return false;
  if (!Array.isArray(kids) || !kids.length) return false;
  return kids.some((k) => kidProfileIsCrawler(k));
}

module.exports = {
  formatHebrewDate,
  formatTimeRange,
  formatTagLine,
  formatAudienceLine,
  formatAdultAgeGate, // alias for backward compat
  isSeniorTargetedEvent,
  inferAgeBoundsFromName,
  detectBabyStage,
  eventExcludesCrawlers,
  kidConflictsEventExclusions,
  kidProfileIsCrawler,
  effectiveEventAgeBounds,
  isCanonicalFamilyAgeRange,
  OPEN_AGE_MAX_MONTHS,
  getEventIcon,
  isParentFocusedEvent,
  resolveEventTitleParts,
  formatEventCardTitleLines,
  rtlLine,
  HEBREW_DAYS,
  HEBREW_MONTHS,
};
