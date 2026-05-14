const supabase = require("./supabase");

// Adaptive memory for "what does this short user phrase mean as a venue?".
//
// Architecture: online Bayesian counting (a.k.a. weighted upvote/downvote).
// Every confirmation, correction, or implicit acceptance bumps the
// confidence on the (alias_norm, location_key) pair. When the score
// crosses a threshold, the agent stops asking and just resolves it.
//
// Why not a "real" ML model? At this scale (single-digit thousands of
// locations, slow-burn user base) counting beats both deep learning and
// embedding similarity for accuracy AND interpretability. We can read a
// row and explain exactly why we resolved an alias the way we did.
//
// What ML would help with: novel paraphrases the counting model has
// never seen ("המקום של גלי", "ההוא ליד הפארק"). For Phase 1 those go
// through the deterministic resolver and ask the user. We log the
// confirmation as a normal signal, and the next time it's free.
//
// Public API:
//   lookup(alias, telegramId)   → { source, location_key, confidence } | null
//   recordConfirmation(...)     → user explicitly picked this mapping
//   recordCorrection(...)       → user said "actually I meant X"
//   recordAutoAccepted(...)     → agent auto-resolved, user didn't object
//   maybePromoteToGlobal(...)   → invoked after a user-scope bump

// ───────────────────────────────────────────────────────────────────────
// Tunables — every magic number lives here so we can iterate without
// chasing them through call sites.
// ───────────────────────────────────────────────────────────────────────
const WEIGHTS = {
  explicit_confirm: 1.0,   // user clicked candidate in picker
  auto_accepted: 0.3,      // agent auto-resolved + user proceeded
  corrected_target: 1.5,   // user said "actually THIS one" — strong
  corrected_source: -1.0,  // and they rejected what we'd guessed
};

// Thresholds for trusting a memory hit without re-asking.
const USER_TRUST_THRESHOLD = 0.8;   // 1 explicit + decay headroom
const GLOBAL_TRUST_THRESHOLD = 2.0; // ≥2 users converging

// Promote a user-scope mapping to global once N distinct users have
// confirmed it at user-confidence ≥ this floor.
const PROMOTION_MIN_USERS = 2;
const PROMOTION_MIN_USER_CONFIDENCE = 1.0;

// ───────────────────────────────────────────────────────────────────────
// Normalization — collapse whitespace, lowercase, strip Hebrew/English
// fillers. The same normalization runs at write- and read-time so
// "מרכז גאולים" and "המרכז גאולים" land on the same alias_norm.
// ───────────────────────────────────────────────────────────────────────
const VENUE_STOP_WORDS = new Set([
  "ה", "ב", "ל", "ו", "מ", "ש", "כ",
  "של", "על", "את", "אל", "מן", "עם", "the", "a", "an", "of",
]);

// Hebrew clitic prefixes worth stripping in venue queries:
//   "ה" — definite article ("המרכז" → "מרכז")
//   "ב" — locative preposition ("במרכז" → "מרכז")
// We deliberately AVOID stripping "מ"/"ל"/"ש"/"ו"/"כ" because they're
// genuine first letters of common venue/place nouns (משחקיית, מקום,
// מרכז, ספרייה, …). Over-stripping is "safe" only as long as it's
// consistent — but it inflates the alias_norm space and reduces the
// chance of cross-user consensus, so we err on the side of less stripping.
//
// Threshold 5 so we never touch 3-4 letter nouns (בית, מים, מקום, מרכז).
const HEBREW_CLITIC_PREFIXES = ["ה", "ב"];
const MIN_LEN_BEFORE_STRIP = 5;

function stripCliticPrefix(token) {
  if (!token || token.length < MIN_LEN_BEFORE_STRIP) return token;
  const first = token[0];
  if (HEBREW_CLITIC_PREFIXES.includes(first)) {
    return token.slice(1);
  }
  return token;
}

function normalizeAlias(text) {
  if (!text) return "";
  const tokens = String(text)
    .toLowerCase()
    .normalize("NFC")
    .split(/[\s,.\-_/()"'״׳]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map(stripCliticPrefix)
    .filter((t) => t.length >= 2 && !VENUE_STOP_WORDS.has(t));
  // Sort tokens so "מרכז פיס" and "פיס מרכז" hit the same row.
  // Mostly redundant in Hebrew, but cheap insurance against word-order
  // variation.
  tokens.sort();
  return tokens.join(" ");
}

// ───────────────────────────────────────────────────────────────────────
// Lookup — the ONLY function called on the hot path (every venue query).
// Order: user memory → global memory → null. The caller falls back to
// the deterministic resolveVenue when this returns null.
// ───────────────────────────────────────────────────────────────────────
async function lookup(rawAlias, telegramId) {
  const alias = normalizeAlias(rawAlias);
  if (!alias) return null;

  if (telegramId) {
    const userHit = await fetchUserHit(alias, String(telegramId));
    if (userHit && userHit.confidence >= USER_TRUST_THRESHOLD) {
      // Best-effort touch; we don't await because lookup latency matters
      // but a failed touch is harmless (just doesn't bump last_used_at).
      touchHit(userHit.id).catch(() => {});
      return {
        source: "user_memory",
        location_key: userHit.location_key,
        confidence: userHit.confidence,
      };
    }
  }

  const globalHit = await fetchGlobalHit(alias);
  if (globalHit && globalHit.confidence >= GLOBAL_TRUST_THRESHOLD) {
    touchHit(globalHit.id).catch(() => {});
    return {
      source: "global_memory",
      location_key: globalHit.location_key,
      confidence: globalHit.confidence,
    };
  }

  return null;
}

async function fetchUserHit(aliasNorm, telegramId) {
  const { data, error } = await supabase
    .from("venue_aliases")
    .select("id, location_key, confidence")
    .eq("scope", "user")
    .eq("telegram_id", telegramId)
    .eq("alias_norm", aliasNorm)
    .order("confidence", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    if (isMissingTableError(error)) return null;
    console.warn("[VenueMemory] fetchUserHit:", error.message);
    return null;
  }
  return data;
}

async function fetchGlobalHit(aliasNorm) {
  const { data, error } = await supabase
    .from("venue_aliases")
    .select("id, location_key, confidence")
    .eq("scope", "global")
    .eq("alias_norm", aliasNorm)
    .order("confidence", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    if (isMissingTableError(error)) return null;
    console.warn("[VenueMemory] fetchGlobalHit:", error.message);
    return null;
  }
  return data;
}

async function touchHit(id) {
  await supabase
    .from("venue_aliases")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", id);
}

// ───────────────────────────────────────────────────────────────────────
// Signal recording — applied to USER scope first; promotion to global
// is checked after each user-scope bump.
// ───────────────────────────────────────────────────────────────────────
async function recordSignal(rawAlias, locationKey, telegramId, signal) {
  const alias = normalizeAlias(rawAlias);
  if (!alias || !locationKey || !telegramId) return null;
  const weight = WEIGHTS[signal];
  if (weight === undefined) {
    console.warn(`[VenueMemory] unknown signal: ${signal}`);
    return null;
  }

  // Append to the audit log first (non-fatal if it fails — the rolled-up
  // counter is the source of truth for runtime decisions).
  await supabase
    .from("venue_alias_signals")
    .insert({
      alias_norm: alias,
      location_key: locationKey,
      telegram_id: String(telegramId),
      signal,
      weight,
    })
    .then(({ error }) => {
      if (error && !isMissingTableError(error)) {
        console.warn("[VenueMemory] signal log failed:", error.message);
      }
    });

  // Upsert + bump on the rolled-up counter.
  const updated = await upsertAndBump({
    alias,
    locationKey,
    telegramId: String(telegramId),
    delta: weight,
  });

  if (updated && weight > 0) {
    // Only worth checking promotion when the bump was positive.
    await maybePromoteToGlobal(alias, locationKey).catch((err) =>
      console.warn("[VenueMemory] promotion check failed:", err.message),
    );
  }
  return updated;
}

async function upsertAndBump({ alias, locationKey, telegramId, delta }) {
  // Read-modify-write. Concurrency is a non-issue at our scale (single
  // bot process, one user per turn), but we still do a single upsert so
  // race-loss is bounded to ~one signal.
  const { data: existing, error: readErr } = await supabase
    .from("venue_aliases")
    .select("id, confidence, hit_count")
    .eq("scope", "user")
    .eq("telegram_id", telegramId)
    .eq("alias_norm", alias)
    .eq("location_key", locationKey)
    .maybeSingle();
  if (readErr && !isMissingTableError(readErr)) {
    console.warn("[VenueMemory] upsert read failed:", readErr.message);
    return null;
  }

  const now = new Date().toISOString();
  if (existing) {
    const newConfidence = Math.max(0, existing.confidence + delta);
    const { data, error } = await supabase
      .from("venue_aliases")
      .update({
        confidence: newConfidence,
        hit_count: existing.hit_count + 1,
        last_used_at: now,
      })
      .eq("id", existing.id)
      .select()
      .single();
    if (error) {
      console.warn("[VenueMemory] update failed:", error.message);
      return null;
    }
    return data;
  }

  const { data, error } = await supabase
    .from("venue_aliases")
    .insert({
      alias_norm: alias,
      location_key: locationKey,
      scope: "user",
      telegram_id: telegramId,
      confidence: Math.max(0, delta),
      hit_count: 1,
      last_used_at: now,
    })
    .select()
    .single();
  if (error) {
    if (!isMissingTableError(error)) {
      console.warn("[VenueMemory] insert failed:", error.message);
    }
    return null;
  }
  return data;
}

// ───────────────────────────────────────────────────────────────────────
// Promotion: turn a user-scope alias into a global one once enough
// distinct users have converged. Runs after a positive bump; cheap
// SELECT + idempotent INSERT.
// ───────────────────────────────────────────────────────────────────────
async function maybePromoteToGlobal(aliasNorm, locationKey) {
  const { data, error } = await supabase
    .from("venue_aliases")
    .select("telegram_id, confidence")
    .eq("scope", "user")
    .eq("alias_norm", aliasNorm)
    .eq("location_key", locationKey)
    .gte("confidence", PROMOTION_MIN_USER_CONFIDENCE);
  if (error) {
    if (isMissingTableError(error)) return;
    console.warn("[VenueMemory] promotion fetch failed:", error.message);
    return;
  }

  const distinctUsers = new Set((data || []).map((r) => r.telegram_id));
  if (distinctUsers.size < PROMOTION_MIN_USERS) return;

  // Sum of qualifying user confidences, capped, becomes the seed global
  // confidence. We pick something above the GLOBAL_TRUST_THRESHOLD so
  // the promotion takes effect immediately.
  const seedConfidence = Math.min(
    GLOBAL_TRUST_THRESHOLD + 0.5,
    (data || []).reduce((acc, r) => acc + Math.min(r.confidence, 1.0), 0),
  );

  const now = new Date().toISOString();
  const { error: upsertErr } = await supabase
    .from("venue_aliases")
    .upsert(
      {
        alias_norm: aliasNorm,
        location_key: locationKey,
        scope: "global",
        telegram_id: null,
        confidence: seedConfidence,
        hit_count: distinctUsers.size,
        last_used_at: now,
      },
      { onConflict: "alias_norm,location_key,scope,telegram_id" },
    );
  if (upsertErr) {
    console.warn("[VenueMemory] promotion upsert failed:", upsertErr.message);
    return;
  }
  console.log(
    `[VenueMemory] PROMOTED "${aliasNorm}" → ${locationKey} ` +
    `(${distinctUsers.size} users, seed=${seedConfidence.toFixed(2)})`,
  );
}

// ───────────────────────────────────────────────────────────────────────
// Convenience wrappers — readable call sites in the bot.
// ───────────────────────────────────────────────────────────────────────
function recordConfirmation(alias, locationKey, telegramId) {
  return recordSignal(alias, locationKey, telegramId, "explicit_confirm");
}

function recordAutoAccepted(alias, locationKey, telegramId) {
  return recordSignal(alias, locationKey, telegramId, "auto_accepted");
}

async function recordCorrection(alias, fromLocationKey, toLocationKey, telegramId) {
  // Decrement what we wrongly guessed.
  if (fromLocationKey && fromLocationKey !== toLocationKey) {
    await recordSignal(alias, fromLocationKey, telegramId, "corrected_source");
  }
  // Boost what the user actually meant.
  if (toLocationKey) {
    await recordSignal(alias, toLocationKey, telegramId, "corrected_target");
  }
}

// ───────────────────────────────────────────────────────────────────────
// Migration probe — silence repeated logs when sql/023 hasn't been
// applied yet. The bot still works (memory just no-ops); a single
// startup warning is enough.
// ───────────────────────────────────────────────────────────────────────
let _missingTableLogged = false;
function isMissingTableError(error) {
  if (!error) return false;
  const code = error.code || "";
  const msg = error.message || "";
  // Two distinct error shapes — we hit both depending on which layer
  // surfaces the failure:
  //   • Raw Postgres → SQLSTATE 42P01 + "relation ... does not exist"
  //   • PostgREST/supabase-js → PGRST205 + "Could not find the table
  //     ... in the schema cache" — this is the shape we ACTUALLY
  //     see at runtime, because PostgREST resolves table names against
  //     its cached schema BEFORE issuing SQL, so the SDK never reaches
  //     the raw 42P01 path.
  const isMissing =
    code === "42P01" ||
    code === "PGRST205" ||
    /relation .* does not exist/i.test(msg) ||
    /Could not find the table .* in the schema cache/i.test(msg);
  if (!isMissing) return false;
  if (!_missingTableLogged) {
    _missingTableLogged = true;
    console.warn(
      "[VenueMemory] sql/023_venue_aliases.sql not applied — alias learning disabled until migration runs.",
    );
  }
  return true;
}

module.exports = {
  lookup,
  recordConfirmation,
  recordAutoAccepted,
  recordCorrection,
  recordSignal,
  maybePromoteToGlobal,
  normalizeAlias,
  // exported for visibility / testing
  WEIGHTS,
  USER_TRUST_THRESHOLD,
  GLOBAL_TRUST_THRESHOLD,
};
