const supabase = require("../lib/supabase");
const { geocodeAddress } = require("../lib/geocoding");

const VALID_GENDERS = new Set(["female", "male"]);

// User's own life-stage / age tier. Used (alongside `kids[]`) by
// `deriveDefaultAudienceSet` to decide WHICH audience tiers to show
// by default. A 28-year-old parent maps to {kids:true, age_range:
// 'young_adult'} → sees family/kids events AND young-adult-tagged
// adults events; senior-leaning adults events are filtered. Without
// this dimension a single binary "kids vs no kids" can't represent
// a young parent who also wants their own age-tier content.
//
// Stored as a string under `user_context.age_range`. Optional —
// when unset, audience derivation falls back to the legacy
// kids-only logic for backward compatibility.
const VALID_AGE_RANGES = new Set(["young_adult", "mid_adult", "senior"]);

// `communities` is a sub-object of user_context that records the
// user's community membership / non-membership, keyed by the same
// `access_t` ENUM values that appear on `events.access` (sql/039).
// Values are tri-state:
//   present + "member"      → include events restricted to this community
//   present + "not-member"  → never offer events restricted to this community
//   absent                  → unknown; bot may ask once before offering
//
// The closed set of community keys lives in the ENUM. We don't
// mirror it here as a constant — the bot's matcher just uses
// `Object.entries(profile.communities || {}).filter(([_, v]) => v === 'member')`
// which is forward-compatible with any new ENUM value added later.
const VALID_COMMUNITY_STATUSES = new Set(["member", "not-member"]);

// Normalise an incoming `communities` payload. Drops unknown
// statuses (so a Gemini hallucination of "maybe" doesn't end up
// stored), and SHALLOW-MERGES with any existing entries so the
// agent can update one community at a time without having to
// resend the full object.
function mergeCommunities(incoming, existing) {
  const merged = { ...(existing && typeof existing === "object" ? existing : {}) };
  if (incoming && typeof incoming === "object") {
    for (const [key, value] of Object.entries(incoming)) {
      if (typeof key !== "string" || !key) continue;
      if (value === null) {
        // Explicit null → forget what we knew. Lets the agent reset
        // a status if the user changes their mind.
        delete merged[key];
        continue;
      }
      if (!VALID_COMMUNITY_STATUSES.has(value)) continue;
      merged[key] = value;
    }
  }
  return merged;
}

// Sticky gender — once set, only an explicit, valid new value can override it.
function normalizeGender(incoming, existing) {
  if (incoming && VALID_GENDERS.has(incoming)) return incoming;
  if (existing && VALID_GENDERS.has(existing)) return existing;
  return null;
}

// Sticky age_range — same semantics as gender. The user picks it
// during onboarding (after the gender step); once stored, only an
// explicit re-pick changes it. Unrecognised incoming values fall
// back to the existing stored value, and an existing-only invalid
// value (legacy or corrupted) resolves to null.
function normalizeAgeRange(incoming, existing) {
  if (incoming && VALID_AGE_RANGES.has(incoming)) return incoming;
  if (existing && VALID_AGE_RANGES.has(existing)) return existing;
  return null;
}

async function getProfile(telegramId) {
  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("telegram_id", String(telegramId))
    .single();

  if (error && error.code !== "PGRST116") {
    throw new Error(`Profile fetch failed: ${error.message}`);
  }
  return data;
}

/**
 * Save the FULL profile as returned by Gemini's brain.
 * Auto-geocodes home_address (when changed) and caches coordinates in constraints.
 */
async function saveProfile(telegramId, updatedProfile, existing = null) {
  const id = String(telegramId);

  const constraints = updatedProfile.constraints
    ? { ...updatedProfile.constraints }
    : null;

  // Geocode the home address if it changed (or if we don't have coords yet)
  if (constraints?.home_address) {
    const oldAddress = existing?.user_context?.constraints?.home_address || null;
    const oldCoords = existing?.user_context?.constraints?.home_coordinates || null;

    if (constraints.home_address !== oldAddress || !oldCoords) {
      console.log(`[Profile] Geocoding home address: "${constraints.home_address}"`);
      // Profile-city plumbing — when we add a "what city do you live
      // in?" question, set constraints.city and the geocoder uses it.
      // Until then, falling through to DEFAULT_CITY in geocodeAddress
      // is exactly what we want.
      const coords = await geocodeAddress(constraints.home_address, {
        city: constraints.city || undefined,
      });
      if (coords) {
        constraints.home_coordinates = { lat: coords.lat, lng: coords.lng };
        console.log(`[Profile] Coords: ${coords.lat}, ${coords.lng} (${coords.source})`);
      } else {
        constraints.home_coordinates = null;
        console.warn(`[Profile] Could not geocode "${constraints.home_address}"`);
      }
    } else {
      constraints.home_coordinates = oldCoords;
    }
  }

  // Spread the existing user_context FIRST so any field this function
  // doesn't explicitly manage (disliked_tags, disliked_venues,
  // known_series, seen_toplabels, future flags…) survives the round-
  // trip. The explicit assignments below override the managed fields.
  const user_context = {
    ...(existing?.user_context && typeof existing.user_context === "object"
      ? existing.user_context
      : {}),
    gender: normalizeGender(updatedProfile.gender, existing?.user_context?.gender),
    // User's own life-stage tier — separate from `kids[]`. A young
    // parent gets both signals set, which is the whole point of the
    // independent dimension. See `deriveDefaultAudienceSet`.
    age_range: normalizeAgeRange(updatedProfile.age_range, existing?.user_context?.age_range),
    kids: updatedProfile.kids || [],
    // `partner` is a single OBJECT (not an array) — most households
    // have at most one. Preserve existing when the caller doesn't pass
    // one; allow explicit `null` to clear (e.g. "אני לבד עכשיו").
    partner: updatedProfile.partner !== undefined
      ? updatedProfile.partner
      : (existing?.user_context?.partner || null),
    constraints,
    interests: updatedProfile.interests || [],
    communities: mergeCommunities(
      updatedProfile.communities,
      existing?.user_context?.communities,
    ),
  };

  const row = {
    telegram_id: id,
    user_context,
    active_watch_list: updatedProfile.watch_list || [],
    last_seen: new Date().toISOString(),
  };

  if (updatedProfile.first_name) row.first_name = updatedProfile.first_name;

  const { data, error } = await supabase
    .from("profiles")
    .upsert(row, { onConflict: "telegram_id" })
    .select()
    .single();

  if (error) throw new Error(`Profile save failed: ${error.message}`);
  return data;
}

function profileToBrainShape(profile) {
  if (!profile) {
    return {
      first_name: null,
      gender: null,
      age_range: null,
      kids: [],
      partner: null,
      constraints: null,
      interests: [],
      communities: {},
      watch_list: [],
    };
  }

  const ctx = profile.user_context || {};
  return {
    first_name: profile.first_name || null,
    gender: ctx.gender || null,
    age_range: VALID_AGE_RANGES.has(ctx.age_range) ? ctx.age_range : null,
    kids: ctx.kids || [],
    partner: ctx.partner && typeof ctx.partner === "object" && ctx.partner.name
      ? {
          name: ctx.partner.name,
          age: ctx.partner.age ?? null,
          interests: Array.isArray(ctx.partner.interests) ? ctx.partner.interests : [],
        }
      : null,
    constraints: ctx.constraints || null,
    interests: ctx.interests || [],
    communities: ctx.communities && typeof ctx.communities === "object"
      ? ctx.communities
      : {},
    watch_list: profile.active_watch_list || [],
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Preference weights
//
// `user_context.preferences` shape:
//   {
//     tag_weights:      { "<label_id>": number },  // >1 boost, <1 suppress
//     category_weights: { "<category_str>": number },
//     series_suppress:  ["<series_name>", ...]      // recurring series to sink
//   }
//
// Numeric weight presets (chosen by the agent based on signal strength):
//   strong_suppress → 0.05   suppress → 0.2   neutral → 1.0
//   boost → 2.0              strong_boost → 4.0
//
// Weights are clamped to [0.05, 4.0] to avoid extreme compounding when the
// same preference is reinforced repeatedly.
// ─────────────────────────────────────────────────────────────────────────
const WEIGHT_PRESETS = {
  strong_suppress: 0.05,
  suppress:        0.2,
  neutral:         1.0,
  boost:           2.0,
  strong_boost:    4.0,
};
const WEIGHT_MIN = 0.05;
const WEIGHT_MAX = 4.0;

/**
 * Merge a set of preference adjustments into the user's stored preferences.
 * Each adjustment can target a tag (by label_id), a category string, or a
 * series name.
 *
 * @param {string|number} telegramId
 * @param {Array<{kind:"tag"|"category"|"series", key:string, preset:string}>} adjustments
 */
async function updatePreferences(telegramId, adjustments) {
  if (!adjustments || !adjustments.length) return;

  const profile = await getProfile(telegramId);
  const ctx = profile?.user_context || {};
  const prefs = ctx.preferences || {};
  const tagWeights      = { ...(prefs.tag_weights      || {}) };
  const categoryWeights = { ...(prefs.category_weights || {}) };
  let seriesSuppress    = [...(prefs.series_suppress   || [])];

  for (const { kind, key, preset, weight: rawWeight } of adjustments) {
    const k = String(key || "").trim();
    if (!k) continue;
    // `weight` (numeric) takes precedence over `preset` (string alias)
    const w = rawWeight != null ? rawWeight : (WEIGHT_PRESETS[preset] ?? 1.0);

    if (kind === "tag") {
      tagWeights[k] = Math.min(Math.max(w, WEIGHT_MIN), WEIGHT_MAX);
    } else if (kind === "category") {
      categoryWeights[k] = Math.min(Math.max(w, WEIGHT_MIN), WEIGHT_MAX);
    } else if (kind === "series") {
      if (w < 1.0) {
        // Suppress: add to the list if not already there
        if (!seriesSuppress.includes(k)) seriesSuppress.push(k);
      } else {
        // Un-suppress or boost: remove from list
        seriesSuppress = seriesSuppress.filter((s) => s !== k);
      }
    }
  }

  const updatedCtx = {
    ...ctx,
    preferences: { tag_weights: tagWeights, category_weights: categoryWeights, series_suppress: seriesSuppress },
  };

  const { error } = await supabase
    .from("profiles")
    .update({ user_context: updatedCtx })
    .eq("telegram_id", String(telegramId));
  if (error) throw new Error(`updatePreferences failed: ${error.message}`);
}

/**
 * Compute the set of `events.access` ENUM values this profile is
 * allowed to see in a default search.
 *
 * Always includes 'open' (= everyone). Adds each community where
 * the profile says "member". "not-member" and "unknown" are both
 * excluded — but the system prompt knows to ask once before showing
 * an unknown-community event (vs never asking again for not-member).
 *
 * Pure function — safe to call on every search.
 */
function accessScopesForProfile(profile) {
  const scopes = ["open"];
  const communities =
    profile?.user_context?.communities ||
    profile?.communities ||
    {};
  if (communities && typeof communities === "object") {
    for (const [key, status] of Object.entries(communities)) {
      if (status === "member" && !scopes.includes(key)) scopes.push(key);
    }
  }
  return scopes;
}

/**
 * Telegram-id convenience over `accessScopesForProfile`. Fetches the
 * profile and computes scopes in one call so tool entry points
 * don't have to spell out the join.
 *
 * Returns just ['open'] when no profile exists (new user, pre-onboarding).
 */
async function getAccessScopesForUser(telegramId) {
  if (telegramId == null) return ["open"];
  const profile = await getProfile(telegramId);
  return accessScopesForProfile(profile);
}

module.exports = {
  getProfile,
  saveProfile,
  profileToBrainShape,
  accessScopesForProfile,
  getAccessScopesForUser,
  updatePreferences,
  WEIGHT_PRESETS,
};
