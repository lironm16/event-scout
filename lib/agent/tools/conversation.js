const { SchemaType } = require("@google/generative-ai");
const { Markup } = require("telegraf");
const {
  selectSeriesForRender,
  venueIdentity,
  groupIntoSeries,
  filterOccurrencesByDateWindow,
} = require("../../eventSeries");
const { fetchUmbrellaSiblingRows } = require("../../umbrellaSiblings");
const { flattenEvent, expandLabels } = require("../../../bot/matchingService");
const { describeWindowHe } = require("../../timeContext");
const { countProfileMatches } = require("../../profileEventFilter");
const { getProfile } = require("../../../bot/profileService");
const sessionStore = require("../sessionStore");

// ─────────────────────────────────────────────────────────────────────────
// Conversation tools — the agent's only way to talk to the user.
//
// The orchestrator interprets each tool's return value:
//   { final: true, ... }   → loop ends, no further Gemini round
//   { paused: true, ... }  → loop ends, waits for next user/button input
//   { ok: true, ... }      → loop continues, agent decides next step
//
// Telegraf interaction goes through ctx.* renderers injected by the bot
// at `runAgent` invocation time. Keeping the actual `ctx.reply` calls
// behind injected renderers means these tools don't need to import the
// bot module (avoids a circular dep).
// ─────────────────────────────────────────────────────────────────────────

const replyTextDecl = {
  name: "reply_text",
  description:
    "Send the FINAL natural-language reply to the user. Plain text only — no event lists, no buttons. " +
    "Calling this ends the agent loop. Always call exactly one of reply_text / ask_clarification / " +
    "present_save_confirmation per turn.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      text: { type: SchemaType.STRING, description: "Hebrew text to send. Conjugate to user's gender." },
    },
    required: ["text"],
  },
};

async function replyText(args, ctx) {
  await ctx.tg.reply(String(args?.text || "").trim());
  return { final: true };
}

const askClarificationDecl = {
  name: "ask_clarification",
  description:
    "Ask the user a single question. Pass options when there's a closed set of answers (renders as " +
    "inline buttons); omit options for open-ended questions (user replies with free text). " +
    "Calling this PAUSES the agent loop until the user answers.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      question: { type: SchemaType.STRING, description: "Question text in Hebrew." },
      options: {
        type: SchemaType.ARRAY,
        nullable: true,
        items: {
          type: SchemaType.OBJECT,
          properties: {
            value: { type: SchemaType.STRING, description: "Internal id used when the user clicks." },
            label: { type: SchemaType.STRING, description: "Button label shown to the user." },
          },
          required: ["value", "label"],
        },
      },
      kind: {
        type: SchemaType.STRING,
        nullable: true,
        format: "enum",
        enum: ["venue_pick", "date_pick", "interest_pick", "yes_no", "free_text", "generic"],
        description: "Hint used by the orchestrator to route the answer back to the agent correctly.",
      },
    },
    required: ["question"],
  },
};

async function askClarification(args, ctx) {
  const question = String(args?.question || "").trim();
  const options = Array.isArray(args?.options) ? args.options : [];
  const kind = args?.kind || "generic";

  // Stash on session so the next user input (text or `clr:*` callback)
  // routes back into the agent loop with the answer attached to the right
  // function call.
  ctx.session.pendingClarification = {
    kind,
    question,
    options: options.map((o) => ({ value: String(o.value), label: String(o.label) })),
    askedAt: Date.now(),
  };

  if (options.length) {
    const rows = ctx.session.pendingClarification.options.map((o, i) =>
      [Markup.button.callback(o.label, `clr:${i}`)],
    );
    await ctx.tg.reply(question, Markup.inlineKeyboard(rows));
  } else {
    await ctx.tg.reply(question);
  }
  return { paused: true };
}

// Hard cap on SERIES cards rendered per turn. The server picks at
// most this many distinct series from whatever event_ids the agent
// passes, so a turn always shows at most this many visible cards
// regardless of how many ids the agent threw at us.
//
// One "card" = one event SERIES (see lib/eventSeries.js). A series
// with multiple occurrences renders ONE card with a "כל המופעים"
// button hiding the rest. Counting cards (not events) keeps the
// real visible budget honest.
const MAX_CARDS_PER_TURN = 5;

// Input cap on event_ids. Chosen as 3× the visible cap so the agent
// has slack to pass duplicate-series ids without hitting the cap on
// the input side — but not so much that a confused/runaway model can
// flood us with hundreds of ids. Anything beyond this is sliced off
// before grouping. In practice the server still only renders up to
// MAX_CARDS_PER_TURN series no matter how many ids come in.
const MAX_INPUT_IDS = 15;

const presentEventResultsDecl = {
  name: "present_event_results",
  description:
    "Render up to 5 SERIES cards from the most recent search_events / find_event_by_name call. " +
    "A 'series' = (a) events under the same umbrella_slug (one card per programme, even when child " +
    "titles differ), OR (b) events sharing the same name+age tier ('משחקיית רגעים' 4×/week). " +
    "All occurrences collapse into ONE card ('כל אירועי …' for umbrellas, 'כל המופעים' otherwise). " +
    "INPUT: pass up to 15 event ids — duplicates within the same series are FREE (they don't " +
    "consume a card slot, they just augment the 'כל המופעים' list). The server picks the first " +
    "5 distinct series in the order you sent them. " +
    "PAGINATION: if you pass MORE than 5 distinct series worth of ids, the server automatically " +
    "shows a 'להראות עוד' button so the user can pull up the rest WITHOUT another LLM round. " +
    "Only ids YOU pass become pagination candidates — events you decided to exclude (e.g. " +
    "'too far away', 'wrong topic') MUST NOT appear in this list, or they'll leak back through " +
    "the button. " +
    "Each card includes 'details' link, navigate button, and watch button when sold out. " +
    "Returns { ok, presented, series_rendered, duplicates_absorbed, extras_dropped, " +
    "pagination_offered, more_remaining_series }.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      event_ids: {
        type: SchemaType.ARRAY,
        items: { type: SchemaType.INTEGER },
        description:
          "Up to 15 event ids from the latest search results, ordered by relevance. The server " +
          "picks the first 5 DISTINCT SERIES to render as cards — extra ids that share a series " +
          "with one already picked enrich the 'כל המופעים' list at no card cost; extra ids " +
          "from NEW series become candidates for the auto-generated 'להראות עוד' button. " +
          "To get 5 visible cards: ids from at least 5 different series. To enable pagination: " +
          "include the remaining candidates (up to the 15 cap). Do NOT include ids you have " +
          "deliberately excluded — they'll resurface through the pagination button.",
      },
      intro_text: {
        type: SchemaType.STRING,
        nullable: true,
        description:
          "One-line Hebrew intro shown above the first card. SHOULD mention the search window naturally " +
          "using `window.label_he` from the search result (e.g. 'הנה מה שמצאתי בשבועיים הקרובים', " +
          "'מצאתי שתי סדנאות השבוע'). Keep it short and conversational.",
      },
    },
    required: ["event_ids"],
  },
};

async function presentEventResults(args, ctx) {
  const requested = Array.isArray(args?.event_ids)
    ? args.event_ids.map((n) => parseInt(n, 10)).filter(Number.isFinite)
    : [];
  if (!requested.length) {
    return { ok: true, presented: 0, error: "no_event_ids" };
  }
  // Slice off runaway input before grouping — the server still
  // enforces MAX_CARDS_PER_TURN on the OUTPUT side, but a 1000-id
  // payload would do unnecessary work in selectSeriesForRender.
  const inputIds = requested.slice(0, MAX_INPUT_IDS);
  const inputDropped = requested.length - inputIds.length;
  const hits = ctx.lastSearchHits || [];
  const { series, absorbedIds, missingIds } = selectSeriesForRender(
    inputIds,
    hits,
    MAX_CARDS_PER_TURN,
  );

  if (args?.intro_text) {
    await ctx.tg.reply(String(args.intro_text));
  }

  let rendered = 0;
  const profileForCards = ctx.telegramId
    ? await getProfile(ctx.telegramId).catch(() => null)
    : null;
  // «חיפוש כללי»? Then events that don't fit the profile (wouldn't show in
  // «בשבילי») shouldn't offer "אל תראה לי יותר" — the user opted to see
  // beyond their profile on purpose. Per-card check below.
  const generalSearch = ctx.telegramId
    ? !!sessionStore.getLastSearchFilters(ctx.telegramId)?.ignore_profile
    : false;
  // Collect every event id covered by the cards we render (the
  // representative AND its sibling occurrences) so the next
  // search_events turn can filter them out. Without this, two
  // overlapping queries ("this week" + "family events") that both
  // legitimately match the same event end up showing the card twice
  // — even though one card visually represents all the occurrences
  // via the כל המופעים button.
  const renderedIds = [];
  for (const s of series) {
    const event = s.representative;
    if (!event) continue;
    try {
      // Detect multi-venue series. Workshops like ביכורי תינוקות run
      // the same content at several venues; lib/eventSeries.js now
      // groups them as ONE series (we used to mistakenly split, and
      // sent 6 near-identical cards). The renderer + seq handler
      // change UX based on this flag — see sendEventCard and the
      // seq: handler in bot/telegramBot.js for the two branches.
      //
      // Bucket by PHYSICAL venue identity (geocoded coords if we have
      // them, location_key text otherwise) — see venueIdentity for
      // why. Two rows that resolved to the same building from different
      // raw_address strings (e.g. "מייקרס" vs "מייקרס, מסובים 2, רמת גן",
      // event id 3489) MUST collapse into one bucket — otherwise the
      // card lies "מתקיים במספר מיקומים" when it's actually one place.
      const venueBuckets = new Set();
      for (const o of s.occurrences) {
        venueBuckets.add(venueIdentity(o));
      }
      const multiVenue = venueBuckets.size > 1;
      const filters = sessionStore.getLastSearchFilters(ctx.telegramId) || {};
      const dateFrom = filters.date_from || null;
      const dateTo = filters.date_to || null;
      const windowLabel =
        dateFrom && dateTo ? describeWindowHe(dateFrom, dateTo) : null;
      const inWindow = filterOccurrencesByDateWindow(
        s.occurrences,
        dateFrom,
        dateTo,
      );
      const seriesOccs = inWindow.length ? inWindow : s.occurrences;

      if (seriesOccs.length > 1 && ctx.telegramId) {
        sessionStore.rememberShownSeries(ctx.telegramId, event.id, {
          name: event.name,
          // Top-level location stays the representative's — but the
          // seq handler ignores it when multiVenue is true. Storing
          // both shapes here keeps the payload self-describing.
          location: event.location,
          location_key: event.location_key,
          multiVenue,
          date_from: dateFrom,
          date_to: dateTo,
          window_label_he: windowLabel || null,
          // Persist a small per-occurrence record (not the whole event
          // object — `lastSearchHits` already has the full row). We
          // include `source` per occurrence so the "כל המופעים"
          // callback can build per-tenant booking URLs without an
          // extra DB hit. All occurrences in a series share a tenant
          // in practice, but storing per-row is cheap and survives a
          // future schema where two tenants ever ran the same series.
          //
          // location + location_key per-occurrence so the seq handler
          // can render the venue alongside each date when the series
          // spans multiple venues.
          occurrences: seriesOccs.map((o) => ({
            id: o.id,
            name: o.name ?? event.name,
            source: o.source,
            // external_slug is required by getBookingUrl for the
            // rg-muni tenant (city events, sql/038). Smarticket rows
            // leave it null — getBookingUrl falls back to /event/<id>.
            external_slug: o.external_slug ?? null,
            date: o.date,
            start_time: o.start_time,
            end_time: o.end_time,
            tickets_left: o.tickets_left,
            description: o.description ?? null,
            min_months: o.min_months ?? null,
            max_months: o.max_months ?? null,
            audience: o.audience ?? null,
            location: o.location ?? null,
            location_key: o.location_key ?? null,
            // Persist geocoded coords so the seq: handler can bucket
            // by physical venue identity on cache hit too — without
            // them it would re-introduce the "same place, different
            // text" multi-venue false positive. See venueIdentity in
            // lib/eventSeries.js.
            lat: o._coords?.lat ?? null,
            lng: o._coords?.lng ?? null,
          })),
        });
      }
      let seriesProfileMatchCount = 0;
      let cardOccCount = Math.max(seriesOccs.length, 1);
      if (event.umbrella_slug) {
        const { data: umbRows } = await fetchUmbrellaSiblingRows(event.umbrella_slug);
        const umbN = umbRows?.length || 0;
        if (umbN > cardOccCount) cardOccCount = umbN;
        if (umbRows?.length && profileForCards) {
          const flats = umbRows.map((r) => flattenEvent(r));
          await expandLabels(flats);
          seriesProfileMatchCount = await countProfileMatches(flats, profileForCards);
        }
      } else if (seriesOccs.length > 0 && profileForCards) {
        seriesProfileMatchCount = await countProfileMatches(
          seriesOccs,
          profileForCards,
        );
      }
      let hideNotRelevant = false;
      let profileFit = false;
      if (generalSearch && profileForCards) {
        const fits = await countProfileMatches([event], profileForCards).catch(
          () => 1,
        );
        hideNotRelevant = fits === 0;
        profileFit = fits > 0; // mark the ones that DO fit (general search only)
        // Persist the verdict so "קרא עוד" reproduces the same card.
        if (hideNotRelevant && ctx.telegramId) {
          const ids = [event.id, ...seriesOccs.map((o) => o?.id)].filter(
            (id) => id != null,
          );
          sessionStore.rememberOutOfProfileEvents(ctx.telegramId, ids);
        }
      }
      await ctx.tg.renderEventCard(event, {
        seriesOccurrenceCount: cardOccCount,
        seriesMultiVenue: multiVenue,
        seriesProfileMatchCount,
        hideNotRelevant,
        profileFit,
      });
      rendered++;
      // Mark the rep AND every sibling occurrence as "shown". The
      // sibling ids are reachable via the כל המופעים button, so the
      // user effectively saw them too — re-surfacing them in the
      // next turn would be redundant.
      for (const o of seriesOccs) {
        if (o?.id != null) renderedIds.push(o.id);
      }
    } catch (err) {
      console.error("[Agent] renderEventCard failed:", err.message);
    }
  }
  if (renderedIds.length && ctx.telegramId) {
    sessionStore.rememberShownEvents(ctx.telegramId, renderedIds);
  }

  // ────────────────────────────────────────────────────────────────
  // Pagination offer — count series in the last search that we
  // haven't shown yet, and if any remain, send a follow-up message
  // with an inline "להראות עוד" button. The button (callback
  // `pgn:next`) is handled deterministically in bot/telegramBot.js
  // — no Gemini round-trip, no risk of the LLM misinterpreting
  // "כן" as a topic pivot. We mirror the hits to the session so the
  // callback handler can rebuild the series view across turns.
  //
  // CRITICAL: pagination pool = the IDs the agent EXPLICITLY passed
  // in `event_ids` (capped at MAX_INPUT_IDS), NOT the cumulative
  // `hits` cache. The cache merges results from every search call
  // this turn AND includes events the agent may have decided to
  // exclude (e.g. "only 2 walking events, excluding משחקיית
  // רגעים"). Paginating from the full cache would leak those
  // explicitly-excluded events when the user taps "show more".
  // We intersect with `lastSearchResultIds` as a defensive second
  // layer in case the agent slipped in a stale id from an earlier
  // search call this turn. See screenshot 2026-05-14.
  // ────────────────────────────────────────────────────────────────
  let paginationOffered = false;
  let moreRemainingSeries = 0;
  if (rendered > 0 && hits.length && ctx.telegramId) {
    const inputSet = new Set(inputIds);
    const latestIds = ctx.lastSearchResultIds instanceof Set
      ? ctx.lastSearchResultIds
      : null;
    const paginationPool = hits.filter((e) => {
      if (!inputSet.has(e.id)) return false;
      if (latestIds && latestIds.size > 0 && !latestIds.has(e.id)) return false;
      return true;
    });
    const shownIds = new Set(sessionStore.getShownEventIds(ctx.telegramId));
    const allSeries = groupIntoSeries(paginationPool);
    const remainingSeries = allSeries.filter(
      (s) => !s.occurrences.some((o) => shownIds.has(o.id)),
    );
    moreRemainingSeries = remainingSeries.length;
    if (moreRemainingSeries > 0) {
      sessionStore.setLastSearchHits(ctx.telegramId, paginationPool);
      const label = moreRemainingSeries === 1
        ? "👀 כן, להראות עוד 1"
        : `👀 כן, להראות עוד ${moreRemainingSeries}`;
      const text = moreRemainingSeries === 1
        ? "יש עוד אירוע אחד — להראות?"
        : `יש עוד ${moreRemainingSeries} אירועים — להראות?`;
      // The deterministic router folds this CTA into a single combined
      // post-search keyboard (see searchRouterRunner). When it asks us
      // to suppress, we still wire up the session hits above so the
      // `pgn:next` button works — we just don't send our own message.
      if (args?.suppress_pagination_prompt) {
        paginationOffered = true;
      } else {
        try {
          await ctx.tg.reply(text, Markup.inlineKeyboard([
            [Markup.button.callback(label, "pgn:next")],
          ]));
          paginationOffered = true;
        } catch (err) {
          console.error("[Agent] pagination button send failed:", err.message);
        }
      }
    } else {
      // No more — clear any stale pagination context so a future
      // unrelated "כן" doesn't accidentally trigger pagination on
      // last-search leftovers from earlier in the session.
      sessionStore.clearLastSearchHits(ctx.telegramId);
    }
  }

  return {
    ok: true,
    presented: rendered,
    series_rendered: rendered,
    // How many of the agent's chosen ids were collapsed because they
    // belonged to an already-rendered series (or the SERIES cap was
    // already full). Helps Gemini decide whether to offer "יש עוד"
    // on follow-up.
    duplicates_absorbed: absorbedIds.length,
    missing_ids: missingIds,
    // Number of ids dropped because the input array exceeded MAX_INPUT_IDS.
    // Effectively zero in practice — only signals a runaway model.
    input_truncated: inputDropped,
    extras_dropped: absorbedIds.length,
    // When true, the tool already sent the user a "להראות עוד?"
    // button — the agent MUST NOT add another `reply_text` offering
    // the same. End the turn after this call.
    pagination_offered: paginationOffered,
    more_remaining_series: moreRemainingSeries,
  };
}

const presentSaveConfirmationDecl = {
  name: "present_save_confirmation",
  description:
    "Show the user a summary of the saved-search snapshot they're about to save, with ✅/❌ buttons. " +
    "Pauses the loop until they confirm or cancel. The agent must call this BEFORE create_saved_search.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      query: {
        type: SchemaType.STRING,
        description:
          "DISPLAY LABEL ONLY — short Hebrew title shown in /saved. NEVER feeds matching. Do NOT " +
          "include filter terms in the label ('בקרבת הבית' is wrong — the proximity filter does " +
          "that work; use a generic label like 'אירועים קרובים לבית' instead). Good labels: " +
          "'סיור עששיות', 'מסיבות בערב', 'במרכז פיס'. Bad labels: 'אירועים לגיל 5' (put 5 in ages), " +
          "'אירועים בקרבת הבית' (proximity filter handles it).",
      },
      tokens: {
        type: SchemaType.ARRAY,
        items: { type: SchemaType.STRING },
        description:
          "OPTIONAL explicit title-substring AND filter. ONLY set this when the user asked for a " +
          "literal text constraint on the event name ('עם המילה יין', 'שהשם יכלול ל״ג בעומר'). " +
          "Default to an EMPTY array; rely on structured filters (audience / ages / proximity / " +
          "watch_tag_names / venue) for selectivity. Pre-May-2026 this field used to be auto-filled " +
          "from `query`, which silently turned the display label into an AND filter and killed " +
          "most matches — that behaviour was removed.",
      },
      filters: {
        type: SchemaType.OBJECT,
        nullable: true,
        properties: {
          date_from: { type: SchemaType.STRING, nullable: true },
          date_to: { type: SchemaType.STRING, nullable: true },
          time_after: { type: SchemaType.STRING, nullable: true },
          time_before: { type: SchemaType.STRING, nullable: true },
          proximity: { type: SchemaType.STRING, nullable: true, format: "enum", enum: ["walk", "drive"] },
          format: { type: SchemaType.STRING, nullable: true, format: "enum", enum: ["physical", "virtual"] },
          location_key: { type: SchemaType.STRING, nullable: true },
          location_label: { type: SchemaType.STRING, nullable: true },
          venue: { type: SchemaType.STRING, nullable: true },
          ages: {
            type: SchemaType.ARRAY,
            nullable: true,
            items: { type: SchemaType.INTEGER },
            description:
              "Ages-in-years (e.g. [5] for 'לגיל 5', [4, 9] for 'לאמילי ולתום'). Mirrors " +
              "search_events.ages — an event matches if its min_months/max_months range fits AT " +
              "LEAST ONE of these. USE THIS for any age-related intent instead of stuffing the " +
              "number into the label or tokens. When unset, no age filter is applied.",
          },
          audience: {
            type: SchemaType.STRING,
            nullable: true,
            description:
              "Audience filter ENUM — one of ['תינוקות','ילדים','נוער','הורים','לכל המשפחה','מבוגרים','ותיקים']. " +
              "Pass this only when the user named a SPECIFIC audience tier: 'אירועים לילדים', 'אירועים למבוגרים', 'לכל המשפחה'. " +
              "LEAVE UNSET when the user's intent is 'events that fit me/my family' — the notifier will auto-filter " +
              "to profile-relevant audiences (kids+family for parents, adults+family for non-parents), the same way " +
              "search_events does at query time. Setting a single ENUM here for a multi-audience intent ('המשפחה שלי' " +
              "→ ילדים+תינוקות+לכל המשפחה) would NARROW the watcher and miss legit hits.",
          },
          // Topic watching — pass tag NAMES the user wants to follow. The
          // notifier matches by Hebrew name against `event.tags`, so this
          // works for both existing tags and ones that don't exist yet
          // (the user gets pinged the first time the tag appears on a new
          // event). Examples: ["מוזיקה"], ["סופי שבוע", "פעוטות"].
          watch_tag_names: {
            type: SchemaType.ARRAY,
            nullable: true,
            items: { type: SchemaType.STRING },
            description:
              "Hebrew tag names to watch. Set this when the user asks to be alerted about a TOPIC " +
              "('כל אירוע מוזיקה', 'אירועי ל״ג בעומר'). The notifier will match by tag, " +
              "even for tags that aren't in the dictionary yet — they'll trigger as soon as a new " +
              "event gets enriched with that tag.",
          },
        },
      },
      tickets_needed: { type: SchemaType.INTEGER, nullable: true },
    },
    required: ["query"],
  },
};

async function presentSaveConfirmation(args, ctx) {
  const snapshot = {
    query: String(args.query),
    tokens: Array.isArray(args.tokens) ? args.tokens : [],
    filters: args.filters || {},
    tickets_needed: args.tickets_needed ?? null,
  };
  ctx.session.pendingSave = snapshot;

  // Prefer the rich editable preview card (post-May-2026 redesign). If
  // the renderer isn't wired (e.g. a CLI test harness), fall back to
  // the legacy static text+confirm path so the tool still works.
  if (typeof ctx?.tg?.renderSavePreview === "function") {
    await ctx.tg.renderSavePreview();
    ctx.session.pendingClarification = {
      kind: "save_confirm",
      question: "[editable save preview]",
      options: [],
      askedAt: Date.now(),
    };
    return { paused: true };
  }

  const summaryLines = ctx.tg.describeSnapshot
    ? ctx.tg.describeSnapshot(snapshot).split("\n")
    : [`🔍 ${snapshot.query}`];

  const text =
    `🔔 לפני שאתחיל לעקוב, ככה הבנתי את הבקשה:\n\n` +
    `${summaryLines.join("\n")}\n\n` +
    `אם משהו לא מדויק — תכתבי לי תיקון בחופשיות. אענה עם הסיכום המעודכן.`;

  await ctx.tg.reply(
    text,
    Markup.inlineKeyboard([
      [Markup.button.callback("✅ עקבי", "ss:confirm")],
      [Markup.button.callback("❌ ביטול", "ss:cancel")],
    ]),
  );

  ctx.session.pendingClarification = {
    kind: "save_confirm",
    question: text,
    options: [],
    askedAt: Date.now(),
  };
  return { paused: true };
}

// ─────────────────────────────────────────────────────────────────────────
// present_invite_link
//
// User-facing referral surface. The /invite command renders the same
// card; this tool exists so a free-text intent ("איך להזמין חברים?",
// "תני לי קישור הזמנה", "אני רוצה לשתף את הבוט עם חברה") gets the
// IDENTICAL UI — no agent-generated approximation, no risk of the
// model paraphrasing the link wrong. The bot's `renderInviteCard`
// facade does the heavy lifting (link, share button, count).
//
// No parameters: the inviter is always ctx.telegramId. Always
// paused; the share button is the next action.
// ─────────────────────────────────────────────────────────────────────────
const presentInviteLinkDecl = {
  name: "present_invite_link",
  description:
    "Send the user their personal invite/referral card. Use when the user asks how to invite " +
    "friends or asks for an invite link (\"איך להזמין?\", \"תני קישור הזמנה\", \"איך לשתף את הבוט?\"). " +
    "The card includes the deep-link, a share button, and the user's referral count. " +
    "DO NOT also call reply_text — the card is the response.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {},
  },
};

async function presentInviteLink(_args, ctx) {
  if (typeof ctx?.tg?.renderInviteCard !== "function") {
    return {
      error: "renderer_unavailable",
      message: "Invite renderer not wired in this context.",
    };
  }
  await ctx.tg.renderInviteCard();
  return { paused: true };
}

// ─────────────────────────────────────────────────────────────────────────
// present_interest_picker — surface the same chip-based picker that
// /interests opens.
//
// Why a tool instead of always relying on the slash command:
//   • New users who just gave us a partner's name but no interests
//     ("יש לי גם את יובל" → bot asks age/interests in free text).
//     The agent can offer a button to jump into the structured picker
//     instead of asking "מה הוא אוהב?" as plain text — the user gets
//     to see our vocabulary and pick from chips.
//   • Onboarding moments mid-conversation ("עדיין לא הגדרת תחומי עניין
//     בפרופיל — רוצה לבחור עכשיו?").
//
// Parameters:
//   target — "self" (default) or "partner". When "partner", the bot
//            looks up the partner name from profile.user_context.partner.
//
// Side effects: the bot renders the picker as a fresh message and
// returns { paused: true }. The agent loop ends; the next user
// interaction will be a callback (chip tap or save), at which point
// the bot's `ip:*` handlers take over — NOT the agent. So this tool
// should be the LAST call in its turn.
// ─────────────────────────────────────────────────────────────────────────
const presentInterestPickerDecl = {
  name: "present_interest_picker",
  description:
    "Open the structured interests picker (toggleable inline chips) for the user OR their partner. " +
    "Use when: (a) the user mentions a partner WITHOUT specifying their interests and you want to " +
    "make capturing them painless (set target='partner'), OR (b) the user has empty " +
    "profile.interests and you decide to onboard them now (set target='self'). DO NOT call this in " +
    "every onboarding turn — only when interests are missing AND the conversation has hit a natural " +
    "pause to set them. Always pair with reply_text or end the turn here — the picker IS the next " +
    "interaction.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      target: {
        type: SchemaType.STRING,
        enum: ["self", "partner"],
        description:
          "'self' opens the picker for the user (saves to profile.interests). 'partner' opens it " +
          "for the user's partner (saves to profile.partner.interests). 'partner' requires a " +
          "partner in profile — call update_profile first if you've just learned the name.",
      },
    },
    required: ["target"],
  },
};

async function presentInterestPicker(args, ctx) {
  const target = args?.target === "partner" ? "partner" : "self";
  if (typeof ctx?.tg?.renderInterestPicker !== "function") {
    return {
      error: "renderer_unavailable",
      message: "Interest picker renderer not wired in this context.",
    };
  }
  try {
    await ctx.tg.renderInterestPicker({ target });
    return { paused: true };
  } catch (err) {
    return {
      error: "render_failed",
      message: err?.message || "Could not render interest picker.",
    };
  }
}

module.exports = {
  declarations: [
    replyTextDecl,
    askClarificationDecl,
    presentEventResultsDecl,
    presentSaveConfirmationDecl,
    presentInviteLinkDecl,
    presentInterestPickerDecl,
  ],
  handlers: {
    reply_text: replyText,
    ask_clarification: askClarification,
    present_event_results: presentEventResults,
    present_save_confirmation: presentSaveConfirmation,
    present_invite_link: presentInviteLink,
    present_interest_picker: presentInterestPicker,
  },
};
