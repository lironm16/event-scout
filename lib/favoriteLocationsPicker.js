// Profile flow: pick favorite location_keys from the catalog (by popularity).

const {
  PAGE_SIZE,
  fetchTopLocationsPage,
  countAvailableLocations,
  locationLabel,
} = require("./topLocationsService");
const { getLocation } = require("./locationStore");
const { saveFavoriteLocationKeys, getProfile } = require("../bot/profileService");

const MAX_LOADED = 50;
const MAX_LABEL_LEN = 52;

function truncateLabel(text) {
  const s = String(text || "").trim();
  if (s.length <= MAX_LABEL_LEN) return s;
  return `${s.slice(0, MAX_LABEL_LEN - 1)}…`;
}

function formatLocationChip(loc, selected) {
  const prefix = selected ? "✅ " : "";
  const count = loc.events_count > 0 ? ` (${loc.events_count})` : "";
  return `${prefix}${truncateLabel(loc.label)}${count}`;
}

function buildFavoriteLocationsKeyboard(state) {
  const selected = state.selectedKeys || new Set();
  const loaded = Array.isArray(state.loaded) ? state.loaded : [];
  const rows = loaded.map((loc) => [{
    text: formatLocationChip(loc, selected.has(loc.key)),
    callback_data: `floc:tog:${loc.index}`,
  }]);

  const total = Number(state.total || 0);
  const remaining = total > loaded.length ? total - loaded.length : 0;
  const atCap = loaded.length >= MAX_LOADED;
  if (state.hasMore && !atCap) {
    const batch = remaining > 0 && remaining < PAGE_SIZE ? remaining : PAGE_SIZE;
    const suffix = total > 0 ? `/${remaining}` : "";
    rows.push([{
      text: `🔁 עוד מקומות (${batch}${suffix})`,
      callback_data: "floc:more",
    }]);
  }

  rows.push([
    { text: "💾 שמרי", callback_data: "floc:save" },
    { text: "🗑️ נקה הכל", callback_data: "floc:clear" },
  ]);
  rows.push([
    { text: "❌ ביטול", callback_data: "floc:cancel" },
  ]);
  return { inline_keyboard: rows };
}

function buildPickerHeader({ selectedLabels, gender }) {
  const lines = [
    "📍 *המקומות שלי*",
    "",
    "בחרי מקומות שבהם את רוצה לקבל אירועים (למשל המועדון שלך).",
    "כשיש בחירה — *רק* אירועים במקומות שסימנת יוצגו, גם אם מקום אחר קרוב.",
    "",
    "_הרשימה ממוינת לפי פופולריות (כמה אירועים פעילים בכל מקום)._",
  ];
  if (selectedLabels.length) {
    lines.push("");
    lines.push(`*נבחרו (${selectedLabels.length}):* ${selectedLabels.map(truncateLabel).join(" · ")}`);
  }
  return lines.join("\n");
}

async function resolveSelectedLabels(keys) {
  const out = [];
  for (const key of keys) {
    const loc = await getLocation(key).catch(() => null);
    out.push(loc ? locationLabel(loc) : key);
  }
  return out;
}

async function hydratePickerState(telegramId, existingKeys = []) {
  const { locations, hasMore } = await fetchTopLocationsPage(0);
  const total = await countAvailableLocations();
  const selectedKeys = new Set(existingKeys);
  const byKey = new Map(locations.map((l) => [l.key, l]));
  const merged = [...locations];
  for (const key of existingKeys) {
    if (!byKey.has(key)) {
      const loc = await getLocation(key).catch(() => null);
      if (loc) {
        merged.unshift({
          index: merged.length,
          key,
          label: locationLabel(loc),
          events_count: 0,
        });
      }
    }
  }
  merged.forEach((l, i) => { l.index = i; });
  return {
    loaded: merged,
    selectedKeys,
    offset: locations.length,
    hasMore,
    total,
  };
}

async function appendLocationsPage(state) {
  const { locations, hasMore } = await fetchTopLocationsPage(state.offset);
  const existingKeys = new Set(state.loaded.map((l) => l.key));
  const merged = [...state.loaded];
  for (const loc of locations) {
    if (!existingKeys.has(loc.key)) {
      merged.push({ ...loc, index: merged.length });
    }
  }
  return {
    ...state,
    loaded: merged,
    offset: state.offset + locations.length,
    hasMore,
  };
}

async function openFavoriteLocationsPicker(ctx, sessionStore, { returnTo = "profile:edit" } = {}) {
  const telegramId = ctx.from.id;
  const profile = await getProfile(telegramId).catch(() => null);
  const existing = profile?.user_context?.favorite_location_keys || [];
  const base = await hydratePickerState(telegramId, existing);
  const selectedLabels = await resolveSelectedLabels([...base.selectedKeys]);
  const text = buildPickerHeader({
    selectedLabels,
    gender: profile?.user_context?.gender,
  });
  const keyboard = buildFavoriteLocationsKeyboard(base);
  const msg = await ctx.reply(text, {
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });
  sessionStore.setFavoriteLocationsPicker(telegramId, {
    ...base,
    messageId: msg.message_id,
    chatId: msg.chat.id,
    returnTo,
  });
}

async function editFavoriteLocationsPicker(ctx, sessionStore) {
  const telegramId = ctx.from.id;
  const state = sessionStore.getFavoriteLocationsPicker(telegramId);
  if (!state?.messageId || !state?.chatId) return;
  const selectedLabels = await resolveSelectedLabels([...state.selectedKeys]);
  const text = buildPickerHeader({ selectedLabels });
  const keyboard = buildFavoriteLocationsKeyboard(state);
  try {
    await ctx.telegram.editMessageText(state.chatId, state.messageId, undefined, text, {
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });
  } catch (err) {
    if (!/message is not modified/i.test(err.message || "")) {
      console.warn("[FavoriteLocations] edit failed:", err.message);
    }
  }
}

async function saveFavoriteLocationsPicker(ctx, sessionStore) {
  const telegramId = ctx.from.id;
  const state = sessionStore.getFavoriteLocationsPicker(telegramId);
  const keys = state ? [...state.selectedKeys] : [];
  await saveFavoriteLocationKeys(telegramId, keys);
  sessionStore.clearFavoriteLocationsPicker(telegramId);
  return keys;
}

module.exports = {
  MAX_LOADED,
  buildFavoriteLocationsKeyboard,
  buildPickerHeader,
  hydratePickerState,
  appendLocationsPage,
  openFavoriteLocationsPicker,
  editFavoriteLocationsPicker,
  saveFavoriteLocationsPicker,
  resolveSelectedLabels,
  truncateLabel,
};
