// Smart "❌ לא מתאים" reason rows — event-specific community + audience labels.

const { Markup } = require("telegraf");
const labelStore = require("./labelStore");
const { displayLocationText } = require("./locationStore");
const { seriesKey } = require("./eventSeries");

/**
 * True when this event is actually part of a recurring series — an
 * umbrella programme, or ≥2 occurrences sharing the series identity
 * (name + age band, venue-agnostic). One-off events return false, so we
 * don't offer the "🔁 אירוע חוזר" feedback option for them.
 */
async function isRecurringEvent(supabase, event) {
  if (!event) return false;
  if (event.umbrella_slug) return true;
  const key = seriesKey(event);
  if (!key) return false;
  const { data } = await supabase
    .from("events")
    .select("id, name, min_months, max_months")
    .eq("name", event.name)
    .eq("archived", false)
    .limit(20);
  if (!Array.isArray(data)) return false;
  let count = 0;
  for (const r of data) {
    if (seriesKey(r) === key) count++;
    if (count > 1) return true;
  }
  return false;
}
const { COMMUNITY_CHIPS } = require("./kidsWizardUi");
const { classifyAllAccessForEvent } = require("./access");
const {
  formatAudienceLine,
  resolveDisplayAgeBounds,
  formatAgeRange,
  ageRangeUsesNumericYears,
} = require("./eventFormat");
const { isChildTargetedEvent } = require("./childEventPrefs");
const { isOnlineEvent, profileSuppressesOnlineEvents } = require("./tagSuppressPrefs");

const COMMUNITY_DISPLAY = Object.fromEntries(
  COMMUNITY_CHIPS.map((c) => [c.key, c.label.replace(/^[^\s]+\s+/, "").trim()]),
);

const AUDIENCE_EXCLUDE = {
  "לכל המשפחה": { label: "לא מעוניין בלכל המשפחה", action: "family" },
  תינוקות: { label: "לא מעוניין באירועי תינוקות", action: "childsuppress" },
  ילדים: { label: "לא מעוניין באירועי ילדים", action: "childsuppress" },
  נוער: { label: "לא מעוניין באירועי נוער", action: "childsuppress" },
  הורים: { label: "לא מעוניין באירועי הורים", action: "hide" },
  ותיקים: { label: "לא מעוניין בותיקים", action: "seniors" },
};

function eventCommunityKeys(event) {
  const acc = event?.access;
  let keys = [];
  if (Array.isArray(acc)) {
    keys = acc.filter((k) => typeof k === "string" && k.startsWith("community-"));
  } else if (typeof acc === "string" && acc.startsWith("community-")) {
    keys = [acc];
  }
  if (!keys.length && event) {
    keys = classifyAllAccessForEvent({
      name: event.name,
      description: event.description,
    }) || [];
  }
  return [...new Set(keys)];
}

function communityDisplayName(key) {
  return COMMUNITY_DISPLAY[key] || key.replace(/^community-/, "");
}

function truncateButtonLabel(text, maxChars = 58) {
  const t = String(text || "").trim();
  if (t.length <= maxChars) return t;
  return `${t.slice(0, maxChars - 1)}…`;
}

/** "לא חלק מקהילה גאה" / "לא חלק מ… או …" */
function communityExcludeButtonLabel(keys) {
  const names = keys.map(communityDisplayName).filter(Boolean);
  if (!names.length) return null;
  if (names.length === 1) return `לא חלק מ${names[0]}`;
  if (names.length === 2) return `לא חלק מ${names[0]} או ${names[1]}`;
  return `לא חלק מ${names[0]}, ${names[1]}…`;
}

function audienceLinePlain(event) {
  const line = formatAudienceLine(event);
  if (!line) return null;
  return line.replace(/^🎯\s*/, "").trim() || null;
}

/**
 * @returns {{ label: string, action: string } | { label: string, callback: string } | null}
 */
function buildAudienceExcludeOption(event) {
  if (!event) return null;

  const plain = audienceLinePlain(event);

  if (isChildTargetedEvent(event) && !plain) {
    return { label: "👥 גיל / קהל לא מתאים", callback: `fb:aud:${event.id}` };
  }

  if (
    isChildTargetedEvent(event) &&
    plain &&
    !/[\d-]/.test(plain) &&
    !AUDIENCE_EXCLUDE[event.audience]
  ) {
    return {
      label: truncateButtonLabel(`לא מעוניין ב${plain}`),
      callback: `fb:aud:${event.id}`,
    };
  }
  const hasSpecificRange =
    plain &&
    plain !== "למבוגרים" &&
    plain !== "לכל המשפחה" &&
    (/[\d]/.test(plain) || /-/.test(plain));

  const aud = event.audience;
  if (aud === "מבוגרים") {
    const { min_months: min, max_months: max } = resolveDisplayAgeBounds(event);
    if (min != null && min >= 216) {
      if (max == null || max >= 600) {
        return { label: "לא מעוניין ב-18+", action: "18plus" };
      }
      if (ageRangeUsesNumericYears(min, max)) {
        const range = formatAgeRange(min, max);
        return {
          label: truncateButtonLabel(`לא מעוניין ב-${range}`),
          action: "18range",
        };
      }
    }
    if (hasSpecificRange) {
      return {
        label: truncateButtonLabel(`לא מעוניין ב-${plain}`),
        action: "hide",
      };
    }
    return { label: "לא מעוניין באירועי מבוגרים", action: "adults" };
  }

  if (hasSpecificRange) {
    const label = plain.includes("-") || /^\d/.test(plain)
      ? `לא מעוניין ב-${plain}`
      : `לא מעוניין ב${plain}`;
    if (isChildTargetedEvent(event)) {
      return {
        label: truncateButtonLabel(label),
        callback: `fb:aud:${event.id}`,
      };
    }
    return { label: truncateButtonLabel(label), action: "hide" };
  }

  const preset = aud ? AUDIENCE_EXCLUDE[aud] : null;
  if (preset) {
    return { label: preset.label, action: preset.action };
  }

  return null;
}

async function loadEventForFeedbackMenu(supabase, eventId) {
  const id = parseInt(eventId, 10);
  const { data: ev } = await supabase
    .from("events")
    // NB: `events` has no `location` column — the human-readable venue
    // lives on the joined `locations` row. Selecting a bare `location`
    // errors the whole query → event comes back null → every per-event
    // button (labels / audience / community / venue) silently vanishes.
    .select(
      "id, name, description, audience, min_months, max_months, access, tag_ids, location_key, umbrella_slug, locations:location_key(raw_address, kind)",
    )
    .eq("id", id)
    .maybeSingle();
  if (!ev) return null;
  // Resolve the display venue text the same way cards do.
  ev.location = displayLocationText(ev.locations) || null;
  const grouped = await labelStore.getLabelsForEvent(id).catch(() => null);
  const tagNames = grouped?.tags || [];
  const ids = Array.isArray(ev.tag_ids) ? ev.tag_ids : [];
  let tagEntries = tagNames.map((name) => ({ name, id: null }));
  if (ids.length) {
    const { data: dictRows } = await supabase
      .from("labels")
      .select("id, name")
      .in("id", ids);
    const byNorm = new Map(
      (dictRows || []).map((r) => [labelStore.normalizeName(r.name), r]),
    );
    tagEntries = tagNames.map((name) => {
      const row = byNorm.get(labelStore.normalizeName(name));
      return { name, id: row?.id ?? null };
    });
  }
  return {
    ...ev,
    tags: tagNames,
    tagEntries,
  };
}

/**
 * Build inline keyboard rows for the לא מתאים root menu.
 * @returns {Promise<{ text: string, rows: Array }>}
 */
function buildLabelExcludeButtons(event, profile) {
  if (!event?.id) return [];
  const suppressed = new Set(
    [...(profile?.user_context?.suppressed_labels || [])].map((s) =>
      String(s).trim().toLowerCase(),
    ),
  );
  const rows = [];
  for (const entry of (event.tagEntries || []).slice(0, 8)) {
    const name = String(entry.name || "").trim();
    if (!name || suppressed.has(name.toLowerCase())) continue;
    const cb = entry.id != null ? `fb:lblx:${event.id}:${entry.id}` : null;
    if (!cb || cb.length > 64) continue;
    rows.push([
      Markup.button.callback(truncateButtonLabel(`🏷️ לא מעוניין ב${name}`), cb),
    ]);
  }
  return rows;
}

async function buildFeedbackReasonMenu(supabase, eventId, profile = null) {
  const event = await loadEventForFeedbackMenu(supabase, eventId);
  const rows = [];

  rows.push(...buildLabelExcludeButtons(event, profile));

  if (event && isOnlineEvent(event) && !profileSuppressesOnlineEvents(profile)) {
    rows.push([
      Markup.button.callback("לא מעוניין באונליין", `fb:onlx:${event.id}`),
    ]);
  }

  const communities = event ? eventCommunityKeys(event) : [];
  if (communities.length) {
    const label = communityExcludeButtonLabel(communities);
    const chip = COMMUNITY_CHIPS.find((c) => c.key === communities[0]);
    const callback =
      communities.length === 1 && chip
        ? `fb:cmex:${eventId}:${chip.short}`
        : `fb:cmex:${eventId}:pick`;
    rows.push([Markup.button.callback(truncateButtonLabel(label), callback)]);
  }

  const audOpt = buildAudienceExcludeOption(event);
  if (audOpt) {
    const cb =
      audOpt.callback || `fb:audx:${eventId}:${audOpt.action}`;
    rows.push([Markup.button.callback(audOpt.label, cb)]);
  }

  // Named per-venue exclusion ("לא מעוניין בבית הצנחן"). Reuses the
  // fb:farvenue handler, which suppresses this location_key for future
  // searches. Only offered when we have both a display name and a key.
  if (event?.location && event?.location_key) {
    rows.push([
      Markup.button.callback(
        truncateButtonLabel(`📍 לא מעוניין ב${event.location}`),
        `fb:farvenue:${eventId}`,
      ),
    ]);
  }

  // Only offer "אירוע חוזר" when the event is genuinely part of a series.
  if (event && (await isRecurringEvent(supabase, event))) {
    rows.push([
      Markup.button.callback("🔁 זה אירוע חוזר — אין צורך להציג לי", `fb:series:${eventId}`),
    ]);
  }
  rows.push(
    [Markup.button.callback("📍 רחוק / לא נוח להגיע", `fb:far:${eventId}`)],
    [Markup.button.callback("🕒 לא בזמן שמתאים לי", `fb:time:${eventId}`)],
    [Markup.button.callback("🎯 הנושא לא מעניין אותי", `fb:ni:${eventId}`)],
    [Markup.button.callback("✏️ אחר…", `fb:other:${eventId}`)],
    [Markup.button.callback("↩️ חזרה", `fb:cancel:${eventId}`)],
  );

  let text = "למה? נעדכן את ההמלצות בהתאם";
  if (event) {
    const plain = audienceLinePlain(event);
    const commNames = communities.map(communityDisplayName);
    const hints = [];
    if (plain) hints.push(`קהל: ${plain}`);
    if (commNames.length) hints.push(`קהילות: ${commNames.join(", ")}`);
    if (hints.length) text += `\n\n${hints.join(" · ")}`;
  }

  return { text, rows };
}

module.exports = {
  buildFeedbackReasonMenu,
  buildLabelExcludeButtons,
  loadEventForFeedbackMenu,
  eventCommunityKeys,
  communityDisplayName,
  buildAudienceExcludeOption,
};
