const { SchemaType } = require("@google/generative-ai");
const supabase = require("../../supabase");
const { resolveVenue } = require("../../venueResolver");
const venueMemory = require("../../venueMemory");
const sessionStore = require("../sessionStore");

// ─────────────────────────────────────────────────────────────────────────
// resolve_venue
//
// Fuzzy-match a user-spoken venue name ("גאולים", "פיס") against the
// `locations` table, layered with adaptive memory:
//
//   1. Consult `venueMemory.lookup` — if the user (or the global cohort)
//      has confirmed this alias before with high enough confidence, we
//      return `matched` and skip asking.
//   2. Otherwise fall through to the deterministic `resolveVenue`. A
//      clean single hit returns `matched` (the agent now auto-confirms
//      without prompting); multiple close candidates return `ambiguous`
//      (agent calls ask_clarification).
//
// The result carries a `from_memory` flag so the agent can phrase its
// auto-confirmation differently ("✅ אני זוכרת שאת מתכוונת ל-X" vs
// "✅ הבנתי שאת מתכוונת ל-X").
// ─────────────────────────────────────────────────────────────────────────
const resolveVenueDecl = {
  name: "resolve_venue",
  description:
    "Look up a venue name in the locations cache. Use whenever the user mentions a place. " +
    "Returns { status: 'matched'|'ambiguous'|'not_found', candidates, from_memory, alias_text }. " +
    "When status='matched' you may auto-confirm in your reply (no need to ask_clarification).",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      text: {
        type: SchemaType.STRING,
        description: "The venue text exactly as the user wrote it. Stop-words are stripped server-side.",
      },
    },
    required: ["text"],
  },
};

async function getRawAddress(locationKey) {
  if (!locationKey) return null;
  const { data, error } = await supabase
    .from("locations")
    .select("raw_address")
    .eq("key", locationKey)
    .maybeSingle();
  if (error) {
    console.warn("[ResolveVenue] raw_address lookup failed:", error.message);
    return null;
  }
  return data?.raw_address || null;
}

async function resolveVenueTool(args, ctx) {
  const text = String(args?.text || "").trim();
  if (!text) return { status: "not_found", candidates: [], alias_text: text };

  const telegramId = ctx?.telegramId || null;

  // Phase 1: consult learned memory. We only short-circuit when the
  // mapping has crossed the trust threshold; lower-confidence rows still
  // exist but are treated as advisory and pass through to the resolver.
  const hit = await venueMemory.lookup(text, telegramId).catch((err) => {
    console.warn("[ResolveVenue] memory lookup failed:", err.message);
    return null;
  });

  let result;
  if (hit?.location_key) {
    const raw = await getRawAddress(hit.location_key);
    result = {
      status: "matched",
      candidates: [{ key: hit.location_key, raw_address: raw }],
      from_memory: true,
      memory_source: hit.source,
      alias_text: text,
    };
  } else {
    // Phase 2: deterministic fuzzy resolver.
    const r = await resolveVenue(text);
    if (r.status === "matched") {
      result = {
        status: "matched",
        candidates: [{ key: r.location_key, raw_address: r.raw_address }],
        from_memory: false,
        alias_text: text,
      };
    } else if (r.status === "ambiguous") {
      result = {
        status: "ambiguous",
        candidates: r.candidates,
        from_memory: false,
        alias_text: text,
      };
    } else {
      result = { status: "not_found", candidates: [], from_memory: false, alias_text: text };
    }
  }

  // Stash on session so the clr: callback (when the user later picks /
  // corrects an option) can record the right (alias → location_key)
  // signal in venue_aliases without parsing the agent's prose reply.
  if (telegramId) {
    sessionStore.setLastResolveVenue(telegramId, {
      alias_text: text,
      status: result.status,
      candidate_keys: (result.candidates || []).map((c) => c.key).filter(Boolean),
      from_memory: result.from_memory || false,
      askedAt: Date.now(),
    });

    // Weak signal: when the deterministic resolver auto-resolves a single
    // hit (status='matched', not from memory), and the agent will surface
    // it to the user without a picker, we tentatively bump confidence.
    // The user can still correct in the next turn — recordCorrection will
    // undo this.
    if (result.status === "matched" && !result.from_memory) {
      const key = result.candidates?.[0]?.key;
      if (key) {
        venueMemory.recordAutoAccepted(text, key, telegramId).catch((err) =>
          console.warn("[ResolveVenue] auto-accept signal failed:", err.message),
        );
      }
    }
  }

  return result;
}

module.exports = {
  declarations: [resolveVenueDecl],
  handlers: {
    resolve_venue: resolveVenueTool,
  },
};
