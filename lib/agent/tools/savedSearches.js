const { SchemaType } = require("@google/generative-ai");
const {
  createSavedSearch,
  updateSavedSearch,
  findOverlappingSavedSearches,
  listSavedSearches,
  archiveSavedSearch,
  promoteToRecurring,
  decrementTicketsRemaining,
  markFoundAndArchive,
} = require("../../savedSearchService");
const { updatePreferences } = require("../../../bot/profileService");
const { resolveTagNamesToIds } = require("../../labelStore");

/**
 * Boost preference weights from a saved-search snapshot.
 * activity_types → category boosts (+25%)
 * tokens (tag label names) → resolve to IDs → tag boosts (+15%)
 *
 * Recurring saves are a stronger signal than one-time (the user is
 * committing to long-term interest), so we apply the boost for both
 * but treat them the same weight-wise — compounding handles intensity.
 */
async function boostFromSavedSearch(telegramId, snapshot) {
  try {
    const adjustments = [];

    // Category boost from activity_types filter
    const activityTypes = snapshot?.filters?.activity_types;
    if (Array.isArray(activityTypes)) {
      for (const cat of activityTypes) {
        if (cat) adjustments.push({ kind: "category", key: cat, preset: "boost" });
      }
    }

    // Tag boost from tokens (resolve names → IDs)
    if (Array.isArray(snapshot?.tokens) && snapshot.tokens.length) {
      const { resolved } = await resolveTagNamesToIds(snapshot.tokens);
      for (const { label_id } of resolved) {
        adjustments.push({ kind: "tag", key: String(label_id), preset: "boost" });
      }
    }

    if (adjustments.length) {
      await updatePreferences(telegramId, adjustments);
    }
  } catch (err) {
    // Non-critical — never let preference updates block the main flow
    console.warn(`[SavedSearch] boostFromSavedSearch failed for ${telegramId}: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Saved-search tools.
//
// The agent uses these AFTER the user has confirmed a snapshot via the
// `present_save_confirmation` tool. The snapshot lives on the agent
// session as `pendingSave` between `present_save_confirmation` and
// `create_saved_search`, so the agent doesn't need to re-pass every field.
// ─────────────────────────────────────────────────────────────────────────

const createSavedSearchDecl = {
  name: "create_saved_search",
  description:
    "Persist the saved search the user just confirmed. Reads the pending snapshot from session state " +
    "(set by `present_save_confirmation`). Pass mode='one_time' for date-bounded saves and 'recurring' " +
    "only when the user explicitly opted into long-running tracking.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      mode: {
        type: SchemaType.STRING,
        format: "enum",
        enum: ["one_time", "recurring"],
      },
    },
    required: ["mode"],
  },
};

async function createSavedSearchTool(args, ctx) {
  const session = ctx.session;
  const snapshot = session?.pendingSave;
  if (!snapshot?.query) {
    return { error: "no_pending_save", message: "No confirmed snapshot. Call present_save_confirmation first." };
  }

  // Auto-expire bounded one_time saves so "סיור עששיות השבוע" doesn't
  // linger past Saturday and start matching next week's events.
  let expiresAt = null;
  if (args.mode === "one_time" && snapshot.filters?.date_to) {
    expiresAt = new Date(`${snapshot.filters.date_to}T23:59:59+03:00`).toISOString();
  }

  const saved = await createSavedSearch(ctx.telegramId, {
    query: snapshot.query,
    tokens: snapshot.tokens,
    filters: snapshot.filters,
    tickets_needed: snapshot.tickets_needed,
    mode: args.mode,
    expires_at: expiresAt,
  });

  // Clear the pending snapshot — anything the agent wants to do next
  // should start fresh.
  session.pendingSave = null;

  // Fire-and-forget: boost preference weights for this topic.
  boostFromSavedSearch(ctx.telegramId, snapshot).catch(() => {});

  return {
    ok: true,
    id: saved.id,
    mode: saved.mode,
    query: saved.query,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Overlap detection — call this BEFORE present_save_confirmation so we can
// warn the user about redundant or conflicting watchers. Without it, the
// user could end up with two near-identical saved searches that double-
// notify on every match (one of the user's reported pain points).
// ─────────────────────────────────────────────────────────────────────────

const findOverlappingDecl = {
  name: "find_overlapping_saved_searches",
  description:
    "BEFORE you call present_save_confirmation, call this to check whether the user already has " +
    "saved-searches that would catch the SAME events. Pass the same `query`/`tokens`/`filters` you're " +
    "about to send to present_save_confirmation (or omit them to use the pending snapshot already in " +
    "session state). " +
    "Returns one of: " +
    "  - { overlaps: [] } — no overlap, proceed straight to present_save_confirmation. " +
    "  - { overlaps: [{ id, query, filters, relationship, existing_is_broader, snapshot_is_broader }, …] }. " +
    "Relationships: " +
    "  'identical' — same scope; the new save is fully redundant. Recommend updating the existing in place. " +
    "  'a_subsumes_b' with snapshot_is_broader=true — the new watcher would catch every event the existing " +
    "one does, plus more. Default: replace by calling update_saved_search on the existing id (preserves " +
    "notification dedup history). Don't double-up. " +
    "  'b_subsumes_a' with existing_is_broader=true — the existing watcher already catches every event the " +
    "new one would. Default: don't add — tell the user; offer to either keep as-is, or NARROW the existing " +
    "to the new scope via update_saved_search. " +
    "  'overlap' — partial overlap (shared tokens/tags/venue) without strict subsumption. Mention it; the " +
    "user picks. Use ask_clarification with options.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      query: { type: SchemaType.STRING, nullable: true, description: "Same as present_save_confirmation.query." },
      tokens: {
        type: SchemaType.ARRAY,
        nullable: true,
        items: { type: SchemaType.STRING },
      },
      filters: {
        type: SchemaType.OBJECT,
        nullable: true,
        // Free-form: matches the present_save_confirmation filters shape.
        // We deliberately don't redeclare every property here to avoid
        // schema drift — sanitisation happens in savedSearchService.
        properties: {},
      },
    },
  },
};

async function findOverlappingTool(args, ctx) {
  // Prefer inline params (lets the agent call this BEFORE
  // present_save_confirmation populates session state) but fall back to
  // the pending snapshot when the agent passes nothing — common for
  // mid-conversation re-checks.
  const snapshot =
    args && args.query
      ? {
        query: String(args.query),
        tokens: Array.isArray(args.tokens) ? args.tokens : [],
        filters: args.filters || {},
      }
      : ctx.session?.pendingSave;

  if (!snapshot?.query) {
    return {
      error: "no_snapshot",
      message: "Pass {query, tokens, filters} inline, or build a snapshot via present_save_confirmation first.",
    };
  }
  const overlaps = await findOverlappingSavedSearches(ctx.telegramId, snapshot);
  return {
    overlaps: overlaps.map((o) => ({
      id: o.existing.id,
      query: o.existing.query,
      tokens: o.existing.tokens,
      filters: o.existing.filters,
      mode: o.existing.mode,
      tickets_remaining: o.existing.tickets_remaining,
      created_at: o.existing.created_at,
      relationship: o.relationship,
      existing_is_broader: o.existing_is_broader,
      snapshot_is_broader: o.snapshot_is_broader,
    })),
  };
}

// Update an existing saved-search in place. Used when the overlap flow
// concludes "replace existing": preserves the row's id and its
// notification dedup history (so we don't re-spam events the user has
// already seen).
const updateSavedSearchDecl = {
  name: "update_saved_search",
  description:
    "Replace the filters / tokens / quantity of an existing saved search with the user's pending " +
    "snapshot. Use this when the overlap flow concludes the user wants to UPDATE an existing watcher " +
    "instead of creating a duplicate (typical: 'identical' or 'snapshot_is_broader' relationships). " +
    "Preserves the saved search's id AND its notification history, so the user doesn't get re-pinged " +
    "about events already seen.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      id: { type: SchemaType.STRING, description: "ID of the existing saved search to update." },
      mode: {
        type: SchemaType.STRING,
        format: "enum",
        enum: ["one_time", "recurring"],
        description: "Same semantics as create_saved_search.",
      },
    },
    required: ["id", "mode"],
  },
};

async function updateSavedSearchTool(args, ctx) {
  const session = ctx.session;
  const snapshot = session?.pendingSave;
  if (!snapshot?.query) {
    return { error: "no_pending_save", message: "No confirmed snapshot. Call present_save_confirmation first." };
  }

  // Mirror the auto-expiry logic from create_saved_search: bounded
  // one_time updates expire at the end of the date_to so a "this week"
  // watcher doesn't linger past Saturday.
  let expiresAt = null;
  if (args.mode === "one_time" && snapshot.filters?.date_to) {
    expiresAt = new Date(`${snapshot.filters.date_to}T23:59:59+03:00`).toISOString();
  }

  const updated = await updateSavedSearch(args.id, ctx.telegramId, {
    query: snapshot.query,
    tokens: snapshot.tokens,
    filters: snapshot.filters,
    tickets_needed: snapshot.tickets_needed,
    mode: args.mode,
    expires_at: expiresAt,
  });

  session.pendingSave = null;

  // Fire-and-forget: boost preference weights for this topic.
  boostFromSavedSearch(ctx.telegramId, snapshot).catch(() => {});

  return {
    ok: true,
    id: updated.id,
    mode: updated.mode,
    query: updated.query,
  };
}

const listSavedSearchesDecl = {
  name: "list_saved_searches",
  description: "List the user's currently active (non-archived) saved searches.",
  parameters: { type: SchemaType.OBJECT, properties: {} },
};

async function listSavedSearchesTool(_args, ctx) {
  const rows = await listSavedSearches(ctx.telegramId);
  return {
    saved_searches: rows.map((r) => ({
      id: r.id,
      query: r.query,
      tokens: r.tokens,
      filters: r.filters,
      mode: r.mode,
      tickets_needed: r.tickets_needed,
      tickets_remaining: r.tickets_remaining,
      expires_at: r.expires_at,
      created_at: r.created_at,
    })),
  };
}

const archiveSavedSearchDecl = {
  name: "archive_saved_search",
  description: "Stop tracking a saved search by ID. The user must own it.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: { id: { type: SchemaType.STRING } },
    required: ["id"],
  },
};

async function archiveSavedSearchTool(args, ctx) {
  await archiveSavedSearch(args.id, ctx.telegramId);
  return { ok: true };
}

const promoteSavedSearchDecl = {
  name: "promote_saved_search_to_recurring",
  description: "Convert a one_time saved search to recurring (clears expiry).",
  parameters: {
    type: SchemaType.OBJECT,
    properties: { id: { type: SchemaType.STRING } },
    required: ["id"],
  },
};

async function promoteSavedSearchTool(args, ctx) {
  await promoteToRecurring(args.id, ctx.telegramId);
  return { ok: true };
}

const decrementSavedSearchDecl = {
  name: "decrement_saved_search_remaining",
  description:
    "Mark N tickets as bought against a saved search. For one_time saves, ANY decrement archives the row.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      id: { type: SchemaType.STRING },
      by: { type: SchemaType.INTEGER, description: "Tickets purchased — usually 1." },
    },
    required: ["id", "by"],
  },
};

async function decrementSavedSearchTool(args) {
  const result = await decrementTicketsRemaining(args.id, Math.max(1, args.by));
  if (result == null) return { error: "no_quantity_tracked" };
  return { remaining: result.remaining, archived: result.archived };
}

const markFoundDecl = {
  name: "mark_saved_search_found",
  description: "User found what they wanted — archive immediately without touching quantity.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: { id: { type: SchemaType.STRING } },
    required: ["id"],
  },
};

async function markFoundTool(args, ctx) {
  await markFoundAndArchive(args.id, ctx.telegramId);
  return { ok: true };
}

module.exports = {
  declarations: [
    createSavedSearchDecl,
    findOverlappingDecl,
    updateSavedSearchDecl,
    listSavedSearchesDecl,
    archiveSavedSearchDecl,
    promoteSavedSearchDecl,
    decrementSavedSearchDecl,
    markFoundDecl,
  ],
  handlers: {
    create_saved_search: createSavedSearchTool,
    find_overlapping_saved_searches: findOverlappingTool,
    update_saved_search: updateSavedSearchTool,
    list_saved_searches: listSavedSearchesTool,
    archive_saved_search: archiveSavedSearchTool,
    promote_saved_search_to_recurring: promoteSavedSearchTool,
    decrement_saved_search_remaining: decrementSavedSearchTool,
    mark_saved_search_found: markFoundTool,
  },
};
