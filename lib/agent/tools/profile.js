const { SchemaType } = require("@google/generative-ai");
const { getProfile, saveProfile, profileToBrainShape } = require("../../../bot/profileService");

// ─────────────────────────────────────────────────────────────────────────
// get_user_profile
//
// Returns the current persisted profile for the calling user. The agent
// already gets a summary in the system prompt, so this is mostly a fallback
// for branches where the agent wants to double-check exact values
// (e.g. before suggesting a default) or list every kid by age.
// ─────────────────────────────────────────────────────────────────────────
const getUserProfileDecl = {
  name: "get_user_profile",
  description:
    "Fetch the calling user's stored profile (name, gender, kids, partner, home address & coords, interests). " +
    "The system prompt already contains a summary; only call this when you need exact field values.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {},
  },
};

async function getUserProfile(_args, ctx) {
  const profile = await getProfile(ctx.telegramId);
  if (!profile) {
    return { profile: null, exists: false };
  }
  return {
    profile: profileToBrainShape(profile),
    exists: true,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// update_profile
//
// Partial merge into `user_context`. Only the fields the agent passes in are
// touched; everything else is preserved by `saveProfile`. Geocoding of a new
// home_address happens automatically inside saveProfile.
// ─────────────────────────────────────────────────────────────────────────
const updateProfileDecl = {
  name: "update_profile",
  description:
    "Persist a partial update to the user's profile. Pass ONLY the fields you want to change. " +
    "Common cases: setting home_address after the user shares it; recording a new kid; storing gender " +
    "when the user reveals it. NEVER overwrite a field with null — omit it instead.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      first_name: { type: SchemaType.STRING, nullable: true },
      gender: {
        type: SchemaType.STRING,
        nullable: true,
        description: "'female' or 'male'. Sticky — once set, only the user can change it.",
      },
      age_range: {
        type: SchemaType.STRING,
        nullable: true,
        description:
          "User's own life-stage tier: 'young_adult' (18-35), 'mid_adult' (35-60), 'senior' (60+). " +
          "Sticky — once set, only an explicit user statement changes it. Used (alongside kids[]) " +
          "to drive the default audience filter in search_events: young/senior subtypes inside " +
          "`מבוגרים` are biased accordingly. Set when the user says \"אני בת 28\", \"בעלי בן 65\", " +
          "\"אנחנו זוג צעיר\", \"אני בגיל הזהב\" — pick the matching tier. The onboarding /start " +
          "flow asks this directly via inline buttons; use this tool ONLY when the user volunteers " +
          "the info mid-conversation.",
      },
      home_address: {
        type: SchemaType.STRING,
        nullable: true,
        description: "Full street + city, e.g. 'נחליאלי 4 רמת גן'. Triggers automatic geocoding.",
      },
      kids: {
        type: SchemaType.ARRAY,
        nullable: true,
        items: {
          type: SchemaType.OBJECT,
          properties: {
            name: { type: SchemaType.STRING },
            age: { type: SchemaType.INTEGER, nullable: true },
          },
          required: ["name"],
        },
        description: "FULL replacement list of kids. Include existing kids when adding new ones.",
      },
      partner: {
        type: SchemaType.OBJECT,
        nullable: true,
        properties: {
          name: { type: SchemaType.STRING },
          age: { type: SchemaType.INTEGER, nullable: true },
          interests: {
            type: SchemaType.ARRAY,
            nullable: true,
            items: { type: SchemaType.STRING },
            description:
              "FULL replacement list of partner-specific interest tags (Hebrew). Use when the user " +
              "describes what the PARTNER likes (\"יובל אוהב יין וקפה\", \"הוא חובב טכנולוגיה\", " +
              "\"לבעלי קלאסי הוא הולך לכל הופעות הג'אז\"). Stored separately from the user's own " +
              "interests so we can match couple-activity intents (\"ערב יין לי וליובל\") and " +
              "calibrate event suggestions to either side. Omit to leave unchanged.",
          },
        },
        required: ["name"],
        description:
          "The user's partner / spouse (single object — replace as a whole when updating). " +
          "Use when the user mentions a partner by name (\"בן הזוג שלי יובל\", \"אישתי דנה\", " +
          "\"בעלי בן 35\"). Useful for date-night / couple-activity intent and for natural " +
          "phrasing in replies (\"מצאתי גם ערב יין שייתאים לך וליובל\"). Omit to leave unchanged. " +
          "After capturing the partner's NAME, the agent should also ask for their AGE and " +
          "INTERESTS in a single follow-up (\"בן כמה הוא? ומה הוא אוהב לעשות?\") so the " +
          "profile is complete enough to drive couple-relevant suggestions.",
      },
      interests: {
        type: SchemaType.ARRAY,
        nullable: true,
        items: { type: SchemaType.STRING },
        description: "FULL replacement list of interest tags (Hebrew).",
      },
      communities: {
        type: SchemaType.OBJECT,
        nullable: true,
        description:
          "Community membership flags. Partial-merge — only the keys you pass are touched. " +
          "Keys must be one of the access_t ENUM values: 'community-disabilities', " +
          "'community-lgbtq', 'community-seniors', 'community-miluim'. Values: 'member' " +
          "(include events for this community in default search) or 'not-member' " +
          "(exclude — and don't ask again). Use 'null' as a value to clear a previously-set " +
          "status. NOTE: the /interests onboarding picker is the CANONICAL UI for these flags — " +
          "its audiences step (🏳️‍🌈 קהילה גאה / 🌷 ותיקים / 🧩 חינוך מיוחד / 🎖️ משרתי " +
          "מילואים) writes directly into this field. Use this tool only when the user " +
          "volunteers their membership in chat, or when you need an immediate answer to " +
          "decide whether to show a community-restricted event. For broader updates " +
          "prefer pointing the user to /interests. " +
          "Examples: " +
          "user says 'we have a kid with disabilities' → " +
          "{ 'community-disabilities': 'member' }. " +
          "User says 'we are not part of the gay community' → " +
          "{ 'community-lgbtq': 'not-member' }. " +
          "User says 'I served in miluim' → " +
          "{ 'community-miluim': 'member' }.",
        properties: {
          "community-disabilities": {
            type: SchemaType.STRING,
            nullable: true,
            description: "'member' or 'not-member'.",
          },
          "community-lgbtq": {
            type: SchemaType.STRING,
            nullable: true,
            description: "'member' or 'not-member'.",
          },
          "community-seniors": {
            type: SchemaType.STRING,
            nullable: true,
            description: "'member' or 'not-member'.",
          },
          "community-miluim": {
            type: SchemaType.STRING,
            nullable: true,
            description: "'member' or 'not-member'.",
          },
        },
      },
    },
  },
};

async function updateProfile(args, ctx) {
  const existing = await getProfile(ctx.telegramId);
  const existingShape = profileToBrainShape(existing);

  // Compose a full-profile object the way `saveProfile` expects, taking
  // existing values where the agent didn't override.
  //
  // `communities` semantics differ from the other fields: the values
  // we want to express are tri-state (member / not-member / unknown)
  // and the agent typically updates one community at a time. We pass
  // the agent's raw `communities` payload through, and `saveProfile`
  // calls `mergeCommunities` to shallow-merge with whatever's in DB.
  // That avoids forcing the agent to round-trip the full object every
  // time and naturally supports per-key updates.
  const merged = {
    ...existingShape,
    first_name: args.first_name ?? existingShape.first_name,
    gender: args.gender ?? existingShape.gender,
    age_range: args.age_range ?? existingShape.age_range,
    kids: Array.isArray(args.kids) ? args.kids : existingShape.kids,
    partner: args.partner && typeof args.partner === "object" && args.partner.name
      ? {
          name: args.partner.name,
          age: args.partner.age ?? null,
          // Partner interests merged in REPLACE semantics (matches the
          // user's own `interests` field above). Passing the partner
          // object always overwrites the partner block as a unit, so
          // an update that omits `interests` clears them — the agent
          // must include the existing list when adding a single
          // interest. The system prompt's profileBlock surfaces the
          // current list to discourage accidental wipes.
          interests: Array.isArray(args.partner.interests)
            ? args.partner.interests
            : (existingShape.partner?.interests ?? []),
        }
      : existingShape.partner,
    interests: Array.isArray(args.interests) ? args.interests : existingShape.interests,
    communities: args.communities && typeof args.communities === "object"
      ? args.communities
      : undefined,
    constraints: {
      ...(existingShape.constraints || {}),
      ...(args.home_address ? { home_address: args.home_address } : {}),
    },
  };

  const saved = await saveProfile(ctx.telegramId, merged, existing);
  return {
    ok: true,
    profile: profileToBrainShape(saved),
  };
}

module.exports = {
  declarations: [getUserProfileDecl, updateProfileDecl],
  handlers: {
    get_user_profile: getUserProfile,
    update_profile: updateProfile,
  },
};
