const { SchemaType } = require("@google/generative-ai");
const {
  addInterest,
  removeInterest,
  isInterested,
  recordInterestSignal,
} = require("../../interestService");

// ─────────────────────────────────────────────────────────────────────────
// mark_event_interest
//
// Agent-facing tool for "תזכיר לי על זה" / "מעניין אותי" requests.
// Complements the ⭐ button on event cards — same underlying service.
// ─────────────────────────────────────────────────────────────────────────

const markEventInterestDecl = {
  name: "mark_event_interest",
  description:
    "Mark or unmark an event as interesting for the user. " +
    "Use when the user says 'מעניין אותי', 'תזכיר לי', 'רוצה לדעת עליו', etc. " +
    "action='add' saves the event and schedules a reminder the evening before. " +
    "action='remove' cancels the reminder. " +
    "Returns { ok, status } where status is 'added', 'removed', or 'already_set'.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      event_id: {
        type: SchemaType.INTEGER,
        description: "ID of the event the user expressed interest in.",
      },
      action: {
        type: SchemaType.STRING,
        format: "enum",
        enum: ["add", "remove"],
        description: "Whether to add or remove interest.",
        nullable: true,
      },
    },
    required: ["event_id"],
  },
};

async function markEventInterest(args, ctx) {
  const eventId = args.event_id;
  const action = args.action || "add";

  if (action === "remove") {
    await removeInterest(ctx.telegramId, eventId);
    return { ok: true, status: "removed" };
  }

  // action === "add"
  const already = await isInterested(ctx.telegramId, eventId);
  if (already) return { ok: true, status: "already_set" };

  await addInterest(ctx.telegramId, eventId);
  recordInterestSignal(ctx.telegramId, eventId).catch(() => {});
  return { ok: true, status: "added" };
}

module.exports = {
  declarations: [markEventInterestDecl],
  handlers: {
    mark_event_interest: markEventInterest,
  },
};
