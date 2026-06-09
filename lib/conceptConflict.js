// Conflict detection between a user's SUPPRESSED tag-labels and their POSITIVE
// audience/community memberships.
//
// Model (decided with the product owner): a community concept (e.g. "קהילה
// גאה") is a legitimate TAG *and* a community-access scope, and an age
// audience (e.g. "נוער") is a legitimate tag *and* a positive target-audience.
// We deliberately do NOT silently hide these from the suppression UI. Instead,
// when a user tries to suppress a tag whose concept they also belong to, that's
// a contradiction we surface at SAVE time and force them to resolve (drop the
// membership, or cancel the suppression).
//
// The canonical tag label name is the SAME string as the community / audience
// value (seeded in the labels table), so matching here is a normalized
// string compare against AUDIENCE_CATEGORIES.

const { AUDIENCE_CATEGORIES } = require("./audienceTargets");

function norm(s) {
  return String(s || "").replace(/["'״׳]/g, "").replace(/\s+/g, " ").trim();
}

// Bare audience_t value → the positive target-audience chip id that owns it.
// Only audiences that actually exist as a selectable chip can conflict.
const AUDIENCE_VALUE_TO_CHIP = {
  "ילדים": "kids",
  "תינוקות": "babies",
  "נוער": "teens",
  "צעירים": "young",
};

// name (normalized) → the community AUDIENCE_CATEGORIES entry. Community labels
// ARE the bare community name (e.g. "קהילה גאה", "נשים"), so a suppressed tag
// of the same name maps straight through.
const COMMUNITY_BY_NAME = new Map();
for (const a of AUDIENCE_CATEGORIES) {
  if (a.community) COMMUNITY_BY_NAME.set(norm(a.label), a);
}

/**
 * Map a label NAME to the profile control that "owns" the same concept.
 * Returns null when the name is a plain topical tag (no conflict possible).
 */
function conceptForName(name) {
  const n = norm(name);
  if (!n) return null;
  const comm = COMMUNITY_BY_NAME.get(n);
  if (comm) {
    return { kind: "community", access: comm.community, chipId: comm.id, label: comm.label };
  }
  const chipId = AUDIENCE_VALUE_TO_CHIP[n];
  if (chipId) {
    const aud = AUDIENCE_CATEGORIES.find((a) => a.id === chipId);
    return { kind: "audience", chipId, value: n, label: aud?.label || n };
  }
  return null;
}

// Communities default to "member" (visible) unless explicitly opted out.
function isCommunityMember(communities, access) {
  if (!communities || typeof communities !== "object") return true;
  return communities[access] !== "not-member";
}

/**
 * Detect contradictions on a FINAL (post-patch) profile state.
 * @param {object} p
 * @param {string[]} p.suppressedNames  final suppressed tag-label names
 * @param {string[]} p.audienceChipIds  final positive target-audience chip ids
 * @param {object}   p.communities      final {communityKey: "member"|"not-member"}
 * @returns {Array<{name,control:"audience"|"community",chipId,access?,label}>}
 */
function detectProfileConflicts({ suppressedNames = [], audienceChipIds = [], communities = {} }) {
  const chips = new Set(audienceChipIds);
  const out = [];
  const seen = new Set();
  for (const raw of suppressedNames) {
    const c = conceptForName(raw);
    if (!c) continue;
    const key = norm(raw);
    if (seen.has(key)) continue;
    if (c.kind === "audience" && chips.has(c.chipId)) {
      seen.add(key);
      out.push({ name: raw, control: "audience", chipId: c.chipId, label: c.label });
    } else if (c.kind === "community" && isCommunityMember(communities, c.access)) {
      seen.add(key);
      out.push({ name: raw, control: "community", access: c.access, chipId: c.chipId, label: c.label });
    }
  }
  return out;
}

class ProfileConflictError extends Error {
  constructor(conflicts) {
    super("PROFILE_CONFLICT");
    this.name = "ProfileConflictError";
    this.conflicts = conflicts;
  }
}

module.exports = {
  conceptForName,
  detectProfileConflicts,
  isCommunityMember,
  ProfileConflictError,
  norm,
};
