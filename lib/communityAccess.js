// Community membership: positive `member` flags + default-all before first edit.
//
// Before the user configures communities (empty `{}`): treated as member of all.
// After configuration: only keys with `"member"` count; picker shows ✅ on those.

const { COMMUNITY_CHIPS } = require("./kidsWizardUi");

const ALL_COMMUNITY_KEYS = COMMUNITY_CHIPS.map((c) => c.key);

function hasExplicitCommunityConfig(communities) {
  const c = communities && typeof communities === "object" ? communities : {};
  return ALL_COMMUNITY_KEYS.some((k) => c[k] === "member" || c[k] === "not-member");
}

function isCommunityMember(communities, key) {
  if (!key || typeof key !== "string") return false;
  const c = communities && typeof communities === "object" ? communities : {};
  if (!hasExplicitCommunityConfig(c)) return true;
  if (c[key] === "member") return true;
  // Legacy profiles that only stored not-member (pre-positive picker).
  const hasAnyMember = ALL_COMMUNITY_KEYS.some((k) => c[k] === "member");
  if (!hasAnyMember && c[key] !== "not-member") return true;
  return false;
}

/** Keys to show with ✅ in the community picker. */
function memberKeysForCommunityPicker(communities) {
  const c = communities && typeof communities === "object" ? communities : {};
  if (!hasExplicitCommunityConfig(c)) {
    return [...ALL_COMMUNITY_KEYS];
  }
  const explicitMembers = ALL_COMMUNITY_KEYS.filter((k) => c[k] === "member");
  if (explicitMembers.length) return explicitMembers;
  // Legacy negative-only storage — show checkmarks on all except opt-outs.
  return ALL_COMMUNITY_KEYS.filter((k) => c[k] !== "not-member");
}

function accessScopesForCommunities(communities) {
  const scopes = ["open"];
  const c = communities && typeof communities === "object" ? communities : {};
  if (!hasExplicitCommunityConfig(c)) {
    for (const key of ALL_COMMUNITY_KEYS) {
      if (!scopes.includes(key)) scopes.push(key);
    }
    return scopes;
  }
  const hasAnyMember = ALL_COMMUNITY_KEYS.some((k) => c[k] === "member");
  for (const key of ALL_COMMUNITY_KEYS) {
    if (hasAnyMember) {
      if (c[key] === "member" && !scopes.includes(key)) scopes.push(key);
    } else if (c[key] !== "not-member" && !scopes.includes(key)) {
      scopes.push(key);
    }
  }
  for (const [key, status] of Object.entries(c)) {
    if (status === "member" && !scopes.includes(key)) scopes.push(key);
  }
  return scopes;
}

module.exports = {
  ALL_COMMUNITY_KEYS,
  hasExplicitCommunityConfig,
  isCommunityMember,
  memberKeysForCommunityPicker,
  accessScopesForCommunities,
};
