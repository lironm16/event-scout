const { SchemaType } = require("@google/generative-ai");
const {
  addWatcher,
  decrementTicketsNeeded,
  removeWatcher,
  isWatching,
  getWatchedEvents,
} = require("../../watchService");
const { recordPositiveSignal } = require("../../interestService");

// ─────────────────────────────────────────────────────────────────────────
// Single-event watchers — used when the user wants a specific sold-out
// event to ping them on restock. Distinct from saved searches (topic
// watchers): a watcher targets ONE event row by id, while a saved search
// is a query over many.
// ─────────────────────────────────────────────────────────────────────────

const watchEventDecl = {
  name: "watch_event",
  description:
    "Subscribe to restock notifications for a specific event by ID. " +
    "Pass tickets_needed when the user mentioned a quantity ('מחפשת 3 כרטיסים').",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      event_id: { type: SchemaType.INTEGER },
      tickets_needed: { type: SchemaType.INTEGER, nullable: true },
    },
    required: ["event_id"],
  },
};

async function watchEvent(args, ctx) {
  await addWatcher(ctx.telegramId, args.event_id, {
    ticketsNeeded: args.tickets_needed ?? null,
  });
  // Watching a specific event is a strong positive signal — treat it the
  // same as "⭐ מעניין אותי": boost the event's category and tag weights.
  recordPositiveSignal(ctx.telegramId, args.event_id).catch(() => {});
  return { ok: true };
}

const unwatchEventDecl = {
  name: "unwatch_event",
  description: "Stop watching a specific event for the user.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: { event_id: { type: SchemaType.INTEGER } },
    required: ["event_id"],
  },
};

async function unwatchEvent(args, ctx) {
  await removeWatcher(ctx.telegramId, args.event_id);
  return { ok: true };
}

const decrementWatcherDecl = {
  name: "decrement_event_watcher",
  description: "Mark N tickets as bought on an event watcher; auto-removes when count reaches 0.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      event_id: { type: SchemaType.INTEGER },
      by: { type: SchemaType.INTEGER },
    },
    required: ["event_id", "by"],
  },
};

async function decrementWatcher(args, ctx) {
  const remaining = await decrementTicketsNeeded(ctx.telegramId, args.event_id, Math.max(1, args.by));
  return { remaining };
}

const listWatchersDecl = {
  name: "list_event_watchers",
  description: "List the events the user is currently watching for restock notifications.",
  parameters: { type: SchemaType.OBJECT, properties: {} },
};

async function listWatchers(_args, ctx) {
  const watched = await getWatchedEvents(ctx.telegramId);
  return {
    watchers: watched.map((w) => ({
      id: w.id,
      name: w.name,
      date: w.date,
      start_time: w.start_time,
      tickets_left: w.tickets_left,
      tickets_needed: w.tickets_needed,
      location: w.location,
    })),
  };
}

const isWatchingDecl = {
  name: "is_event_watched",
  description: "Check if the user is already watching a specific event.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: { event_id: { type: SchemaType.INTEGER } },
    required: ["event_id"],
  },
};

async function isWatchingTool(args, ctx) {
  const watching = await isWatching(ctx.telegramId, args.event_id);
  return { watching };
}

module.exports = {
  declarations: [
    watchEventDecl,
    unwatchEventDecl,
    decrementWatcherDecl,
    listWatchersDecl,
    isWatchingDecl,
  ],
  handlers: {
    watch_event: watchEvent,
    unwatch_event: unwatchEvent,
    decrement_event_watcher: decrementWatcher,
    list_event_watchers: listWatchers,
    is_event_watched: isWatchingTool,
  },
};
