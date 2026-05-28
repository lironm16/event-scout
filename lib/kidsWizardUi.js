// Shared UI for kids + communities wizards (feedback `fb:*` and onboarding `onb:*`).

const { Markup } = require("telegraf");
const { AUDIENCE_CATEGORIES } = require("./interestCategories");

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

const AGE_03_OPTIONS = [0, 0.5, 1, 1.5, 2, 2.5, 3];

const COMMUNITY_CHIPS = AUDIENCE_CATEGORIES.filter((a) => a.community).map((a) => ({
  key: a.community,
  short: a.community.replace("community-", ""),
  label: `${a.emoji} ${a.label}`,
}));

function encodeAge(age) {
  return String(Math.round(age * 10));
}

function decodeAge(code) {
  const n = parseInt(code, 10);
  if (!Number.isFinite(n)) return null;
  return n / 10;
}

function stageLabels(stageIds) {
  return (stageIds || []).map((id) => DEV_STAGES.find((s) => s.id === id)?.label || id);
}

/** @param {"fb"|"onb"} mode */
function buildAge03Keyboard(mode, refId) {
  const p = mode === "fb" ? "fb" : "onb";
  const rows = [];
  for (let i = 0; i < AGE_03_OPTIONS.length; i += 3) {
    rows.push(
      AGE_03_OPTIONS.slice(i, i + 3).map((age) =>
        Markup.button.callback(
          age === 0 ? "לידה (0)" : String(age),
          mode === "fb" ? `${p}:ka:${refId}:${encodeAge(age)}` : `${p}:ka:${encodeAge(age)}`,
        ),
      ),
    );
  }
  const back =
    mode === "fb"
      ? Markup.button.callback("↩️ חזרה", `fb:aud:${refId}`)
      : Markup.button.callback("↩️ חזרה", "onb:back:kids");
  rows.push([back]);
  return rows;
}

function buildStagesKeyboard(mode, refId, selected) {
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
  rows.push([
    Markup.button.callback(
      "✔️ המשך לשם",
      mode === "fb" ? `${p}:stgn:${refId}` : `${p}:stgn`,
    ),
  ]);
  return rows;
}

function buildKidsBandKeyboard(mode, refId, { positive = false, afterMore = false } = {}) {
  const p = mode === "fb" ? "fb" : "onb";
  const rows = [
    [
      Markup.button.callback(
        positive ? "👶 תינוק/ת (0-3)" : "👶 יש לי ילדים בגילאי 0-3",
        mode === "fb" ? `${p}:aud:03:${refId}` : `${p}:kids:03`,
      ),
    ],
    [
      Markup.button.callback(
        positive ? "🧒 ילד/ה (3-18)" : "🧒 יש לי ילדים בגילאי 3+",
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
  AGE_03_OPTIONS,
  COMMUNITY_CHIPS,
  encodeAge,
  decodeAge,
  stageLabels,
  buildAge03Keyboard,
  buildStagesKeyboard,
  buildKidsBandKeyboard,
  buildCommunityKeyboard,
};
