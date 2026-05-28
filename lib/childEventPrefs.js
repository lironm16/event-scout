// Profile + search helpers for child-audience feedback.

const supabase = require("./supabase");
const { saveProfile, getProfile } = require("../bot/profileService");
const { effectiveEventAgeBounds } = require("./eventFormat");

const CHILD_AUDIENCES = new Set(["תינוקות", "ילדים", "נוער"]);

function isChildTargetedEvent(ev) {
  if (!ev) return false;
  if (CHILD_AUDIENCES.has(ev.audience)) return true;
  const min = ev.min_months;
  const max = ev.max_months;
  if (typeof max === "number" && Number.isFinite(max) && max <= 36) return true;
  if (typeof min === "number" && Number.isFinite(min) && min < 36) {
    if (max == null || max <= 144) return true;
  }
  const text = `${ev.name || ""} ${ev.description || ""}`;
  if (/תינוק|ילדים|ילד|נוער|משחקייה|לידה|זוחל|פעוט|גילאי\s*\d/u.test(text)) {
    return true;
  }
  return false;
}

function profileSuppressesChildEvents(profile) {
  return Boolean(profile?.user_context?.suppress_child_audiences);
}

async function setSuppressChildAudiences(telegramId, suppress) {
  const existing = await getProfile(telegramId);
  const ctx = existing?.user_context || {};
  const chipIds = (ctx.target_audience_chip_ids || []).filter(
    (id) => !["kids", "babies", "teens"].includes(id),
  );
  await supabase
    .from("profiles")
    .update({
      user_context: {
        ...ctx,
        suppress_child_audiences: !!suppress,
        target_audience_chip_ids: chipIds,
      },
    })
    .eq("telegram_id", String(telegramId));
}

async function appendKidToProfile(telegramId, kid) {
  const existing = await getProfile(telegramId);
  const ctx = existing?.user_context || {};
  const prev = Array.isArray(ctx.kids) ? ctx.kids : [];
  const entry = {
    name: kid.name,
    age: kid.age,
    ...(kid.stages?.length ? { stages: kid.stages } : {}),
  };
  const byName = new Map(prev.map((k) => [String(k.name).trim(), k]));
  byName.set(entry.name, entry);
  const kids = [...byName.values()];
  await saveProfile(
    telegramId,
    {
      kids,
      suppress_child_audiences: false,
    },
    existing,
  );
  return kids;
}

/** Drop child-oriented events when user opted out of kids content. */
function shouldHideChildEventForProfile(event, profile) {
  if (!profileSuppressesChildEvents(profile)) return false;
  return isChildTargetedEvent(event);
}

module.exports = {
  CHILD_AUDIENCES,
  isChildTargetedEvent,
  profileSuppressesChildEvents,
  setSuppressChildAudiences,
  appendKidToProfile,
  shouldHideChildEventForProfile,
  effectiveEventAgeBounds,
};
