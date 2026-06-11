// Shared UI for kids + communities wizards (feedback `fb:*` and onboarding `onb:*`).

const { Markup } = require("telegraf");
const { AUDIENCE_CATEGORIES } = require("./interestCategories");
const { formatKidProfileSuffix, kidAgeMonths, kidNounHe } = require("./kidAge");

const DEV_STAGES = [
  { id: "crawl", label: "זוחל" },
  { id: "walk", label: "הולך" },
  { id: "wean", label: "גמול" },
  { id: "solids", label: "אוכל מוצקים" },
  { id: "talk", label: "מדבר" },
];

function stageButtonLabel(stage, selected) {
  const prefix = selected ? "✅ " : "";
  return `${prefix}${stage.label}`;
}

const COMMUNITY_CHIPS = AUDIENCE_CATEGORIES.filter((a) => a.community).map((a) => ({
  key: a.community,
  short: a.community.replace("community-", ""),
  label: `${a.emoji} ${a.label}`,
}));

function stageLabels(stageIds) {
  return (stageIds || []).map((id) => DEV_STAGES.find((s) => s.id === id)?.label || id);
}

function stageIdsFromLabels(labels) {
  if (!Array.isArray(labels)) return [];
  return labels
    .map((label) => DEV_STAGES.find((s) => s.label === label)?.id)
    .filter(Boolean);
}

function bandFromKid(kid) {
  const months = kidAgeMonths(kid);
  if (months == null) return "3+";
  return months < 36 ? "0-3" : "3+";
}

function kidManageButtonLabel(kid, index) {
  const name = String(kid?.name || `${kidNounHe(kid?.gender)} ${index + 1}`).trim();
  const meta = formatKidProfileSuffix(kid) || "";
  const raw = meta ? `${name} · ${meta}` : name;
  const max = 48;
  return raw.length <= max ? raw : `${raw.slice(0, max - 1)}…`;
}

/** List existing kids + add / save (profile edit). */
function buildKidsManageKeyboard(kids, { editReturn = null } = {}) {
  const rows = (kids || []).map((kid, i) => [
    Markup.button.callback(`✏️ ${kidManageButtonLabel(kid, i)}`, `onb:kid:edit:${i}`),
  ]);
  rows.push([Markup.button.callback("➕ הוספת ילד", "onb:kids:new")]);
  if (editReturn === "profile") {
    if ((kids || []).length > 0) {
      rows.push([Markup.button.callback("🚫 אין לי ילדים (מחק הכל)", "onb:kids:none")]);
    }
    rows.push([Markup.button.callback("💾 שמרי וחזרה לפרופיל", "onb:kids:save")]);
    rows.push([Markup.button.callback("❌ ביטול", "onb:kids:cancel")]);
  } else {
    rows.push([Markup.button.callback("← חזרה", "onb:back:audiences")]);
  }
  return rows;
}

/** Per-child edit hub (profile or onboarding). */
function buildKidEditHubKeyboard(draft) {
  const rows = [
    [Markup.button.callback("📅 תאריך לידה", "onb:kid:field:birth")],
    [Markup.button.callback("⚧ מגדר", "onb:kid:field:gender")],
  ];
  // Developmental readiness is edited in the Mini App profile (per-stage
  // 4-level) — the bot wizard no longer offers the legacy stages step.
  rows.push([Markup.button.callback("✏️ שם", "onb:kid:field:name")]);
  if (draft?.editIndex != null) {
    rows.push([Markup.button.callback("🗑️ מחק ילד", `onb:kid:del:${draft.editIndex}`)]);
  }
  rows.push([Markup.button.callback("↩️ חזרה לרשימה", "onb:kid:back:list")]);
  return rows;
}

function buildBirthDateBackKeyboard(mode, refId, { backCallback = null } = {}) {
  const backData =
    backCallback ||
    (mode === "fb" ? `fb:aud:${refId}` : "onb:back:kids");
  const back = Markup.button.callback("↩️ חזרה", backData);
  return [[back]];
}

function buildStagesKeyboard(mode, refId, selected, { editing = false } = {}) {
  const p = mode === "fb" ? "fb" : "onb";
  const sel = new Set(selected || []);
  const rows = [];
  // Two chips per row — keeps all five stages visible on narrow phones
  // (a single column of six rows was easy to miss below the fold).
  for (let i = 0; i < DEV_STAGES.length; i += 2) {
    rows.push(
      DEV_STAGES.slice(i, i + 2).map((s) =>
        Markup.button.callback(
          stageButtonLabel(s, sel.has(s.id)),
          mode === "fb" ? `${p}:stg:${refId}:${s.id}` : `${p}:stg:${s.id}`,
        ),
      ),
    );
  }
  const contLabel = mode === "fb" ? "▶️ המשך" : "▶️ המשך";
  rows.push([
    Markup.button.callback(
      contLabel,
      mode === "fb" ? `${p}:stgn:${refId}` : `${p}:stgn`,
    ),
  ]);
  if (mode === "onb" && editing) {
    rows.push([Markup.button.callback("💾 שמרי שלבים", "onb:kid:field:stages:save")]);
  }
  return rows;
}

function buildKidGenderKeyboard(mode, refId, { backCallback = null } = {}) {
  const p = mode === "fb" ? "fb" : "onb";
  const rows = [
    [
      Markup.button.callback("👦 בן", mode === "fb" ? `${p}:kgen:${refId}:male` : `${p}:kgen:male`),
      Markup.button.callback("👧 בת", mode === "fb" ? `${p}:kgen:${refId}:female` : `${p}:kgen:female`),
    ],
    [
      Markup.button.callback(
        "לא מציין",
        mode === "fb" ? `${p}:kgen:${refId}:skip` : `${p}:kgen:skip`,
      ),
    ],
  ];
  const backData =
    backCallback || (mode === "fb" ? `fb:aud:${refId}` : "onb:back:kids");
  rows.push([Markup.button.callback("↩️ חזרה", backData)]);
  return rows;
}

function buildKidsBandKeyboard(mode, refId, { positive = false, afterMore = false } = {}) {
  const p = mode === "fb" ? "fb" : "onb";
  const rows = [
    [
      Markup.button.callback(
        positive ? "👶 תינוק (0-3)" : "👶 יש לי ילדים בגילאי 0-3",
        mode === "fb" ? `${p}:aud:03:${refId}` : `${p}:kids:03`,
      ),
    ],
    [
      Markup.button.callback(
        positive ? "🧒 ילד (3-18)" : "🧒 יש לי ילדים בגילאי 3+",
        mode === "fb" ? `${p}:aud:3p:${refId}` : `${p}:kids:3p`,
      ),
    ],
  ];
  if (!afterMore && !positive) {
    rows.unshift([
      Markup.button.callback("🚫 אל תציג לי אירועי ילדים", `fb:aud:nk:${refId}`),
    ]);
  }
  if (mode === "fb") {
    rows.push([Markup.button.callback("↩️ חזרה", `fb:reasons:${refId}`)]);
  } else if (!afterMore) {
    rows.push([
      Markup.button.callback("⏭️ אין ילדים / דלגי", "onb:kids:skip"),
    ]);
    rows.push([Markup.button.callback("← הקודם", "onb:back:audiences")]);
  } else {
    rows.push([Markup.button.callback("⏭️ סיימתי", "onb:kids:done")]);
  }
  return rows;
}

function buildCommunityKeyboard(mode, refId, memberKeys) {
  const p = mode === "fb" ? "fb" : "onb";
  const member = new Set(memberKeys || []);
  const rows = [];
  for (let i = 0; i < COMMUNITY_CHIPS.length; i += 2) {
    rows.push(
      COMMUNITY_CHIPS.slice(i, i + 2).map((c) =>
        Markup.button.callback(
          `${member.has(c.key) ? "✅ " : ""}${c.label}`,
          mode === "fb" ? `${p}:cm:${refId}:${c.short}` : `${p}:ctog:${c.short}`,
        ),
      ),
    );
  }
  rows.push([
    Markup.button.callback(
      "✔️ שמירה",
      mode === "fb" ? `${p}:cmd:${refId}` : `${p}:comm:done`,
    ),
  ]);
  const back =
    mode === "fb"
      ? Markup.button.callback("↩️ חזרה", `fb:reasons:${refId}`)
      : Markup.button.callback("← הקודם", "onb:back:kids");
  rows.push([back]);
  return rows;
}

module.exports = {
  DEV_STAGES,
  COMMUNITY_CHIPS,
  stageLabels,
  stageIdsFromLabels,
  bandFromKid,
  buildBirthDateBackKeyboard,
  buildKidGenderKeyboard,
  buildKidsManageKeyboard,
  buildKidEditHubKeyboard,
  buildStagesKeyboard,
  buildKidsBandKeyboard,
  buildCommunityKeyboard,
};
