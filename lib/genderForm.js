// Hebrew copy keyed off profile.user_context.gender (female / male / neutral).

/**
 * @param {object|string|null} profileOrGender profile row, user_context slice, or "female"|"male"
 * @param {{ f: string, m: string, n: string }} forms
 */
function genderForm(profileOrGender, { f, m, n }) {
  const g =
    typeof profileOrGender === "string"
      ? profileOrGender
      : profileOrGender?.user_context?.gender ||
        profileOrGender?.gender ||
        null;
  if (g === "female") return f;
  if (g === "male") return m;
  return n;
}

function registeredToCommunitiesLabel(gender) {
  return genderForm(gender, {
    f: "רשומה לקהילות",
    m: "רשום לקהילות",
    n: "רשום/ה לקהילות",
  });
}

function registeredToAllCommunitiesLabel(gender) {
  return genderForm(gender, {
    f: "רשומה לכל הקהילות",
    m: "רשום לכל הקהילות",
    n: "רשום/ה לכל הקהילות",
  });
}

module.exports = {
  genderForm,
  registeredToCommunitiesLabel,
  registeredToAllCommunitiesLabel,
};
