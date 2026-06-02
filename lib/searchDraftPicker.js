// Multi-select search hub — toggle filters on one keyboard, then search (gendered label).

const { Markup } = require("telegraf");
const { searchGoLabel, searchMarkVerb } = require("./genderForm");
const { getProfile } = require("../bot/profileService");

const MENU = "menu";

const SEARCH_TOPICS = [
  { label: "🎵 מוזיקה", tag: "מוזיקה", id: "music" },
  { label: "🎨 יצירה", tag: "יצירה", id: "craft" },
  { label: "🌿 טבע", tag: "טבע", id: "nature" },
  { label: "🎭 תיאטרון", tag: "תיאטרון", id: "theater" },
  { label: "✈️ עולים", tag: "עולים חדשים", id: "olim" },
  { label: "🕯️ שבועות", tag: "שבועות", id: "shavuot" },
];

const TAG_BY_ID = new Map(SEARCH_TOPICS.map((t) => [t.id, t.tag]));

const SEARCH_KEYWORDS = [
  { label: "👶 משחקייה", kw: "משחקייה", id: "playground" },
];

const KW_BY_ID = new Map(SEARCH_KEYWORDS.map((k) => [k.id, k.kw]));

const SEARCH_ACTIVITIES = [
  { label: "🔧 סדנה", type: "workshop" },
  { label: "🚶 סיור", type: "tour" },
  { label: "🎉 מסיבה", type: "party" },
  { label: "🔬 הרצאה", type: "lecture" },
  { label: "🎪 הופעה", type: "show" },
  { label: "🤝 מפגש", type: "gathering" },
];

const SEARCH_AUDIENCES = [
  { label: "👶 ילדים", aud: "kids" },
  { label: "👨‍👩‍👧 משפחה", aud: "family" },
  { label: "👶 תינוקות", aud: "toddlers" },
  { label: "🎒 נוער", aud: "teens" },
];

function tagFromRouterId(id) {
  return TAG_BY_ID.get(id) || null;
}

function kwFromRouterId(id) {
  return KW_BY_ID.get(id) || null;
}

const DATE_PRESETS = [
  { label: "📅 היום", preset: "today" },
  { label: "📅 מחר", preset: "tomorrow" },
  { label: "📅 השבוע", preset: "this_week" },
  { label: "📅 שבוע הבא", preset: "next_week" },
];

function emptyDraft() {
  return {
    tags: [],
    activityTypes: [],
    audiences: [],
    datePreset: null,
    proximity: false,
    availableOnly: false,
    unseenOnly: false,
    keywords: [],
  };
}

function seedDraftFromFilters(filters) {
  const f = filters || {};
  const draft = emptyDraft();
  if (Array.isArray(f.tags)) draft.tags = [...f.tags];
  if (Array.isArray(f.activity_types)) draft.activityTypes = [...f.activity_types];
  if (f.audience) draft.audiences = [f.audience];
  else if (Array.isArray(f.audiences)) draft.audiences = [...f.audiences];
  if (f.date_preset) draft.datePreset = f.date_preset;
  if (f.proximity === "walk") draft.proximity = true;
  if (f.available_only) draft.availableOnly = true;
  if (f.unseen_only) draft.unseenOnly = true;
  if (Array.isArray(f.keywords)) draft.keywords = [...f.keywords];
  return draft;
}

function draftToFilters(draft) {
  const d = draft || emptyDraft();
  const filters = {};
  if (d.datePreset) filters.date_preset = d.datePreset;
  if (d.tags.length) filters.tags = [...d.tags];
  if (d.keywords.length) filters.keywords = [...d.keywords];
  if (d.activityTypes.length) filters.activity_types = [...d.activityTypes];
  if (d.audiences.length === 1) filters.audience = d.audiences[0];
  else if (d.audiences.length > 1) filters.audiences = [...d.audiences];
  if (d.proximity) filters.proximity = "walk";
  if (d.availableOnly) filters.available_only = true;
  if (d.unseenOnly) filters.unseen_only = true;
  const hasSignal =
    filters.date_preset ||
    filters.tags?.length ||
    filters.keywords?.length ||
    filters.activity_types?.length ||
    filters.audience ||
    filters.audiences?.length ||
    filters.proximity ||
    filters.available_only ||
    filters.unseen_only;
  if (!hasSignal) return null;
  // No date chip selected → search everything upcoming (not just this week);
  // pagination caps how many show at a time.
  if (!filters.date_preset) filters.date_preset = "upcoming";
  return filters;
}

function chipLabel(base, selected) {
  return selected ? `✅ ${base}` : base;
}

function buildSearchDraftKeyboard(draft, gender = null) {
  const d = draft || emptyDraft();
  const goLabel = searchGoLabel(gender);
  const rows = [];

  for (let i = 0; i < DATE_PRESETS.length; i += 2) {
    rows.push(
      DATE_PRESETS.slice(i, i + 2).map((p) =>
        Markup.button.callback(
          chipLabel(p.label, d.datePreset === p.preset),
          `rtr:tog:date:${p.preset}`,
        ),
      ),
    );
  }

  for (let i = 0; i < SEARCH_TOPICS.length; i += 2) {
    rows.push(
      SEARCH_TOPICS.slice(i, i + 2).map((t) =>
        Markup.button.callback(
          chipLabel(t.label, d.tags.includes(t.tag)),
          `rtr:tog:tag:${t.id}`,
        ),
      ),
    );
  }

  for (let i = 0; i < SEARCH_AUDIENCES.length; i += 2) {
    rows.push(
      SEARCH_AUDIENCES.slice(i, i + 2).map((a) =>
        Markup.button.callback(
          chipLabel(a.label, d.audiences.includes(a.aud)),
          `rtr:tog:aud:${a.aud}`,
        ),
      ),
    );
  }

  for (let i = 0; i < SEARCH_ACTIVITIES.length; i += 2) {
    rows.push(
      SEARCH_ACTIVITIES.slice(i, i + 2).map((a) =>
        Markup.button.callback(
          chipLabel(a.label, d.activityTypes.includes(a.type)),
          `rtr:tog:act:${a.type}`,
        ),
      ),
    );
  }

  rows.push([
    Markup.button.callback(chipLabel("🚶 קרוב אליי", d.proximity), "rtr:tog:prox"),
    Markup.button.callback(chipLabel("🎫 עם כרטיסים", d.availableOnly), "rtr:tog:tix"),
  ]);
  rows.push([
    Markup.button.callback(chipLabel("👀 שלא ראיתי", d.unseenOnly), "rtr:tog:unseen"),
  ]);

  for (const kw of SEARCH_KEYWORDS) {
    rows.push([
      Markup.button.callback(
        chipLabel(kw.label, d.keywords.includes(kw.kw)),
        `rtr:tog:kw:${kw.id}`,
      ),
      Markup.button.callback("📋 עדכון פרופיל", "rtr:profile"),
    ]);
  }

  // Two launch buttons: profile-aware "בשבילי" vs unfiltered general
  // "חיפוש" (ignore_profile). One tap runs the search in that mode.
  rows.push([
    Markup.button.callback("✨ חיפוש בשבילי", "rtr:go"),
    Markup.button.callback(`🔍 ${goLabel}`, "rtr:go:all"),
  ]);
  rows.push([Markup.button.callback("🗑️ נקה", "rtr:clear")]);
  rows.push([Markup.button.callback("↩️ תפריט ראשי", `${MENU}:main`)]);

  return Markup.inlineKeyboard(rows);
}

function summarizeDraft(draft) {
  const d = draft || emptyDraft();
  const parts = [];
  if (d.datePreset) {
    const p = DATE_PRESETS.find((x) => x.preset === d.datePreset);
    parts.push(p ? p.label.replace(/^📅\s*/, "") : d.datePreset);
  }
  if (d.tags.length) parts.push(d.tags.join(" · "));
  if (d.audiences.length) {
    const labels = d.audiences.map((aud) => {
      const row = SEARCH_AUDIENCES.find((a) => a.aud === aud);
      return row ? row.label.replace(/^[^\s]+\s*/, "") : aud;
    });
    parts.push(labels.join(" · "));
  }
  if (d.activityTypes.length) {
    const labels = d.activityTypes.map((type) => {
      const row = SEARCH_ACTIVITIES.find((a) => a.type === type);
      return row ? row.label.replace(/^[^\s]+\s*/, "") : type;
    });
    parts.push(labels.join(" · "));
  }
  if (d.keywords.length) parts.push(d.keywords.join(" · "));
  if (d.proximity) parts.push("קרוב");
  if (d.availableOnly) parts.push("כרטיסים");
  if (d.unseenOnly) parts.push("שלא ראיתי");
  return parts;
}

function buildSearchDraftHeader(draft, draftText, gender = null) {
  const d = draft || emptyDraft();
  const mark = searchMarkVerb(gender);
  const go = searchGoLabel(gender);
  const lines = [
    "🔍 *חיפוש אירועים*",
    "",
    `${mark} כמה מסננים שרלוונטיים (✅), ואז «${go}». אפשר לשלב תאריך + נושאים + קהל. «שלא ראיתי» = מסתיר אירועים שכבר הוצגו לך כרטיס.`,
  ];
  const typed = String(draftText || "").trim();
  if (typed) {
    lines.push("");
    lines.push(`_גם מה שכתבת:_ «${typed}»`);
  }
  const summary = summarizeDraft(d);
  if (summary.length) {
    lines.push("");
    lines.push(`*נבחר:* ${summary.join(" · ")}`);
  }
  return lines.join("\n");
}

function toggleArrayItem(arr, value) {
  const i = arr.indexOf(value);
  if (i >= 0) {
    arr.splice(i, 1);
    return false;
  }
  arr.push(value);
  return true;
}

/** Apply an `rtr:tog:*` callback to draft; returns updated draft. */
function applyDraftToggle(draft, action) {
  const d = {
    tags: [...(draft?.tags || [])],
    activityTypes: [...(draft?.activityTypes || [])],
    audiences: [...(draft?.audiences || [])],
    datePreset: draft?.datePreset ?? null,
    proximity: !!draft?.proximity,
    availableOnly: !!draft?.availableOnly,
    unseenOnly: !!draft?.unseenOnly,
    keywords: [...(draft?.keywords || [])],
  };

  if (action === "prox") {
    d.proximity = !d.proximity;
    return d;
  }
  if (action === "tix") {
    d.availableOnly = !d.availableOnly;
    return d;
  }
  if (action === "unseen") {
    d.unseenOnly = !d.unseenOnly;
    return d;
  }
  if (action.startsWith("date:")) {
    const preset = action.slice(5);
    d.datePreset = d.datePreset === preset ? null : preset;
    return d;
  }
  if (action.startsWith("tag:")) {
    const tag = tagFromRouterId(action.slice(4)) || action.slice(4);
    toggleArrayItem(d.tags, tag);
    return d;
  }
  if (action.startsWith("aud:")) {
    toggleArrayItem(d.audiences, action.slice(4));
    return d;
  }
  if (action.startsWith("act:")) {
    toggleArrayItem(d.activityTypes, action.slice(4));
    return d;
  }
  if (action.startsWith("kw:")) {
    const kw = kwFromRouterId(action.slice(3)) || action.slice(3);
    toggleArrayItem(d.keywords, kw);
    return d;
  }
  return d;
}

/** Legacy single-tap callbacks (`rtr:preset:…`, `rtr:tag:…`) → toggle draft. */
function applyLegacyRouterAction(draft, action) {
  if (action.startsWith("preset:")) {
    const preset = action.slice(7);
    if (preset === "walk") return applyDraftToggle(draft, "prox");
    if (preset === "tickets") return applyDraftToggle(draft, "tix");
    return applyDraftToggle(draft, `date:${preset}`);
  }
  if (action.startsWith("refine:")) {
    if (action.slice(7) === "walk") return applyDraftToggle(draft, "prox");
    if (action.slice(7) === "tickets") return applyDraftToggle(draft, "tix");
    return draft || emptyDraft();
  }
  if (action.startsWith("tag:")) {
    return applyDraftToggle(draft, action);
  }
  if (action.startsWith("aud:")) {
    return applyDraftToggle(draft, `aud:${action.slice(4)}`);
  }
  if (action.startsWith("act:")) {
    return applyDraftToggle(draft, `act:${action.slice(4)}`);
  }
  if (action.startsWith("kw:")) {
    return applyDraftToggle(draft, `kw:${action.slice(3)}`);
  }
  return draft || emptyDraft();
}

async function profileGender(telegramId) {
  const profile = await getProfile(telegramId).catch(() => null);
  return profile?.user_context?.gender || null;
}

async function openSearchDraftHub(ctx, sessionStore, { draftText = null } = {}) {
  const telegramId = ctx.from.id;
  const gender = await profileGender(telegramId);
  const last = sessionStore.getLastSearchFilters(telegramId);
  const draft = seedDraftFromFilters(last);
  const text = buildSearchDraftHeader(draft, draftText, gender);
  const keyboard = buildSearchDraftKeyboard(draft, gender);
  const msg = await ctx.reply(text, { parse_mode: "Markdown", ...keyboard });
  sessionStore.setSearchDraft(telegramId, {
    draft,
    draftText: draftText || null,
    messageId: msg.message_id,
    chatId: msg.chat.id,
  });
}

async function editSearchDraftHub(ctx, sessionStore) {
  const telegramId = ctx.from.id;
  const state = sessionStore.getSearchDraft(telegramId);
  if (!state?.messageId || !state?.chatId) return;
  const gender = await profileGender(telegramId);
  const text = buildSearchDraftHeader(state.draft, state.draftText, gender);
  const keyboard = buildSearchDraftKeyboard(state.draft, gender);
  try {
    await ctx.telegram.editMessageText(
      state.chatId,
      state.messageId,
      undefined,
      text,
      { parse_mode: "Markdown", ...keyboard },
    );
  } catch (err) {
    if (!/not modified/i.test(err.message || "")) throw err;
  }
}

module.exports = {
  SEARCH_TOPICS,
  SEARCH_KEYWORDS,
  SEARCH_ACTIVITIES,
  SEARCH_AUDIENCES,
  tagFromRouterId,
  kwFromRouterId,
  emptyDraft,
  seedDraftFromFilters,
  draftToFilters,
  buildSearchDraftKeyboard,
  buildSearchDraftHeader,
  applyDraftToggle,
  applyLegacyRouterAction,
  openSearchDraftHub,
  editSearchDraftHub,
};
