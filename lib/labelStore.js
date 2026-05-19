// Centralised access to event labels.
//
// Schema (sql/032 onwards):
//
//   events.audience  audience_t  native ENUM ('תינוקות'|'ילדים'|...)
//   events.category  category_t  native ENUM ('סדנה'|'הצגה'|...)
//   events.tag_ids   INT[]       FKs into the `labels` dictionary
//
// `labels` is now a TAGS-ONLY dictionary — the `kind` column was
// dropped in sql/032 since audience and category live in their own
// ENUM types directly on `events`.
//
// What this module owns:
//   - the `labels` dictionary lifecycle for tags only (find-or-create
//     with Hebrew normalisation so "ל״ג בעומר" and "לג בעומר" don't
//     end up as two rows)
//   - one-stop reads/writes for an event's three label dimensions:
//     audience (ENUM passthrough), category (ENUM passthrough),
//     tag_ids (FK array → resolved via dict lookup)
//
// Closed enums (audience, category) need no application logic — the
// ENUM type itself rejects unknown values at write time. The Gemini
// enricher emits canonical Hebrew strings that match the type
// declaration; anything that doesn't match throws and we log+skip.

const supabase = require("./supabase");

// Strip Hebrew/Latin gershayim and quote variants, collapse whitespace,
// lowercase Latin runs. We do NOT canonicalise letter doubling
// ("משחקיה" vs "משחקייה") — those are real Hebrew spelling variants,
// and we'd rather the LLM follow the canonical form than risk folding
// a meaningful distinction.
// Strip bureaucratic suffixes that city/department tag feeds attach
// to otherwise clean topic names. Examples seen in the wild:
//   "שבת תרבות - מחלקת תרבות-ר''ג" → "שבת תרבות"
//   "שבת קהילה - מחלקת קהילה-ר''ג"  → "שבת קהילה"
// These suffixes encode which municipal department owns the event
// page on the city CMS — useful for the city's editorial team,
// noise for users browsing topics. Without canonicalisation the
// catalog ends up with duplicate labels that have identical event
// counts and differ only in the trailing organisational metadata.
//
// We match " - מחלקת ..." (note the SPACE-HYPHEN-SPACE prefix) so
// standalone audience tags like "מחלקת נוער וצעירים" — where
// "מחלקת" is the meaningful start of the name, not a suffix —
// are left untouched.
function stripBureaucraticSuffix(s) {
  if (!s) return s;
  return String(s).replace(/\s*[-–]\s*מחלקת\s+.*$/u, "").trim();
}

function normalizeName(s) {
  if (!s) return null;
  return stripBureaucraticSuffix(String(s))
    .replace(/[\u0027\u0022\u05F3\u05F4\u2018\u2019\u201C\u201D`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("he-IL");
}

// In-memory cache: normalisedName → label_id. Populated on first hit
// per process; resets on bot restart. Avoids hammering the labels
// table on every event during a backfill. The key is just the
// normalised name now (no `kind` prefix) since labels is tags-only.
const cache = new Map();
const cacheKey = (name) => normalizeName(name);

function _clearCache() {
  cache.clear();
}

// Look up an existing tag row matching the normalised name. Returns
// the {id, name} row or null. We pull every row once and match in JS
// — the labels table stays under a few hundred rows for the life of
// the project, so this is cheap and avoids trying to push Hebrew
// normalisation into Postgres.
async function findLabel(normalisedTarget) {
  const { data, error } = await supabase.from("labels").select("id, name");
  if (error) {
    console.warn(`[Labels] read failed:`, error.message);
    return null;
  }
  return (data || []).find((r) => normalizeName(r.name) === normalisedTarget) || null;
}

// Get-or-create a tag label. The signature dropped its `kind` arg in
// sql/032 — labels is tags-only now. Renaming would force every
// caller to update; keeping the name minimises churn.
async function getOrCreateLabel(rawName) {
  if (!rawName) return null;
  // First-pass cleanup: collapse whitespace. The bureaucratic-suffix
  // strip (see normalizeName) happens *after* — we need the cleaned
  // form (without "- מחלקת ...") for BOTH the lookup key and the
  // value we persist, so that the city-feed variant
  // "שבת תרבות - מחלקת תרבות-ר''ג" stores as plain "שבת תרבות".
  const cleaned = stripBureaucraticSuffix(
    String(rawName).replace(/\s+/g, " "),
  ).trim();
  if (!cleaned) return null;

  const key = cacheKey(cleaned);
  if (cache.has(key)) return cache.get(key);

  const target = normalizeName(cleaned);
  const existing = await findLabel(target);
  if (existing) {
    cache.set(key, existing.id);
    return existing.id;
  }

  const { data, error } = await supabase
    .from("labels")
    .insert({ name: cleaned })
    .select("id")
    .maybeSingle();
  if (error) {
    // Race with a parallel insert of the same row.
    if (error.code === "23505") {
      const again = await findLabel(target);
      if (again) {
        cache.set(key, again.id);
        return again.id;
      }
    }
    console.warn(`[Labels] insert failed ("${cleaned}"):`, error.message);
    return null;
  }
  cache.set(key, data.id);
  return data.id;
}

// Resolve an array of tag names into label ids, in source order,
// dropping duplicates and unresolvable values.
async function resolveMany(names) {
  if (!Array.isArray(names) || !names.length) return [];
  const seen = new Set();
  const ids = [];
  for (const n of names) {
    const id = await getOrCreateLabel(n);
    if (id != null && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

// Read one event's label dimensions and return the
// `{audience, category, tags}` shape used by the bot UI.
async function getLabelsForEvent(eventId) {
  const { data: row, error: rowErr } = await supabase
    .from("events")
    .select("audience, category, tag_ids")
    .eq("id", eventId)
    .maybeSingle();
  if (rowErr || !row) return { audience: null, category: null, tags: [] };
  return await expandIds(row);
}

// Bulk version. Takes an array of event ids; returns Map<eventId, grouped>.
async function getLabelsForEvents(eventIds) {
  if (!Array.isArray(eventIds) || !eventIds.length) return new Map();
  const { data: rows, error } = await supabase
    .from("events")
    .select("id, audience, category, tag_ids")
    .in("id", eventIds);
  if (error) {
    console.warn(`[Labels] bulk read failed:`, error.message);
    return new Map();
  }

  // Collect every tag id we need to expand, fetch in one round-trip.
  // audience/category are already strings on the row, no lookup needed.
  const allIds = new Set();
  for (const r of rows || []) {
    for (const id of r.tag_ids || []) allIds.add(id);
  }
  const dict = await fetchLabelDict([...allIds]);

  const out = new Map();
  for (const r of rows || []) {
    out.set(r.id, expandWithDict(r, dict));
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────
// User-facing keyword resolution. Takes Hebrew strings the user typed
// (or that the agent extracted as keywords) and tries to match them
// against existing tag labels. Returns:
//
//   {
//     resolved:   [{ name, label_id, label_name }],
//     unresolved: [name1, name2, ...]
//   }
//
// Matching strategy (per term):
//   1. Exact match after normalisation (label.name)
//   2. Substring match either way (input ⊂ label or label ⊂ input)
//   3. Token-overlap (input shares a meaningful word with a label)
//   4. Hebrew morphology fallback (long shared prefix)
//
// Falls through to `unresolved` if nothing fits — caller decides what
// to do with those (typical: offer "save as topic watcher" so the user
// gets pinged the FIRST time we see an event with that tag).
// ──────────────────────────────────────────────────────────────────────
async function resolveTagNamesToIds(rawNames) {
  if (!Array.isArray(rawNames) || !rawNames.length) {
    return { resolved: [], unresolved: [] };
  }

  const { data: tagRows, error } = await supabase
    .from("labels")
    .select("id, name");
  if (error) {
    console.warn(`[Labels] resolveTagNames lookup failed:`, error.message);
    return { resolved: [], unresolved: rawNames };
  }
  const tags = (tagRows || []).map((r) => ({
    id: r.id,
    name: r.name,
    norm: normalizeName(r.name),
  }));

  const resolved = [];
  const unresolved = [];
  const seenIds = new Set();

  for (const raw of rawNames) {
    if (!raw) continue;
    const norm = normalizeName(raw);
    if (!norm) continue;

    // Tiered fuzzy match. Each tier produces zero or more candidates;
    // ties within a tier are broken by smallest length-difference (the
    // closer the candidate's normalised name to the input, the more
    // specific the match — "התפתחות" beats "פיזיותרפיה התפתחותית"
    // when the user said "התפתחותי").
    const pickClosest = (cands) => {
      if (!cands.length) return null;
      cands.sort(
        (a, b) =>
          Math.abs(a.norm.length - norm.length) -
          Math.abs(b.norm.length - norm.length),
      );
      return cands[0];
    };

    // Tier 1: exact match.
    let hit = tags.find((t) => t.norm === norm);

    // Tier 1.5: covers-ALL-words. For multi-word inputs like
    // "שבת קהילה" we prefer a label that *contains all of the input
    // words* (e.g. "שבת משפחה קהילה") over a shorter single-word
    // label that happens to be a substring (e.g. "קהילה"). Otherwise
    // the length-distance heuristic in tier 2/3 picks "קהילה" — the
    // single closest-length match — and the user's intent is lost.
    //
    // Single-word inputs degenerate to a no-op here and fall through
    // to tier 2, preserving today's behavior on the common path.
    if (!hit) {
      const inputWords = norm.split(/\s+/).filter((w) => w.length >= 2);
      if (inputWords.length >= 2) {
        hit = pickClosest(
          tags.filter((t) =>
            inputWords.every((w) =>
              t.norm.split(/\s+/).some((tw) => tw === w),
            ),
          ),
        );
      }
    }

    // Tier 2: substring containment (either direction).
    if (!hit) {
      hit = pickClosest(
        tags.filter((t) => t.norm.includes(norm) || norm.includes(t.norm)),
      );
    }

    // Tier 3: shared >=2-char word (handles "סיור עששיות" → "עששיות").
    if (!hit) {
      const words = new Set(norm.split(/\s+/).filter((w) => w.length >= 2));
      if (words.size) {
        hit = pickClosest(
          tags.filter((t) => {
            const tw = t.norm.split(/\s+/).filter((w) => w.length >= 2);
            return tw.some((w) => words.has(w));
          }),
        );
      }
    }

    // Tier 4: Hebrew morphology fallback. Adjective ↔ noun pairs
    // ("מוזיקלי" / "מוזיקה", "ספרותי" / "ספרות") share a long common
    // prefix but diverge in the final letter(s). Conservative: ≥5
    // shared prefix chars AND ≥75% of the shorter word.
    if (!hit) {
      hit = pickClosest(
        tags.filter((t) => {
          const a = t.norm;
          const b = norm;
          if (a.length < 5 || b.length < 5) return false;
          let i = 0;
          const max = Math.min(a.length, b.length);
          while (i < max && a[i] === b[i]) i++;
          if (i < 5) return false;
          const shorter = Math.min(a.length, b.length);
          return i / shorter >= 0.75;
        }),
      );
    }

    if (hit && !seenIds.has(hit.id)) {
      seenIds.add(hit.id);
      resolved.push({ name: raw, label_id: hit.id, label_name: hit.name });
    } else if (!hit) {
      unresolved.push(raw);
    }
  }

  return { resolved, unresolved };
}

// Top N popular tag NAMES, sorted by events_count DESC. Used by the
// enricher to feed Gemini the existing dictionary so the model
// prefers reusing a known string ("קהילה גאה") over emitting a
// near-duplicate ("מחלקת הקהילה הגאה"). Returns just the strings —
// callers don't need the ids since they're going to be re-resolved
// via getOrCreateLabel after Gemini answers.
//
// `gt('events_count', 0)` skips zero-count labels (they're auto-pruned
// by the trigger in sql/050 but defensive in case the migration
// hasn't been applied yet or counts are momentarily stale).
async function getPopularLabelNames(limit = 100) {
  const { data, error } = await supabase
    .from("labels")
    .select("name, events_count")
    .gt("events_count", 0)
    .order("events_count", { ascending: false })
    .order("id", { ascending: true })
    .limit(limit);
  if (error) {
    console.warn(`[Labels] popular fetch failed:`, error.message);
    return [];
  }
  return (data || []).map((r) => r.name);
}

// Read every label row matching the given ids; return a Map<id, {name}>.
// (No `kind` field — labels is tags-only.)
async function fetchLabelDict(ids) {
  if (!ids?.length) return new Map();
  const { data, error } = await supabase
    .from("labels")
    .select("id, name")
    .in("id", ids);
  if (error) {
    console.warn(`[Labels] dict fetch failed:`, error.message);
    return new Map();
  }
  const m = new Map();
  for (const row of data || []) m.set(row.id, { name: row.name });
  return m;
}

// Expand a single events row into the {audience, category, tags}
// shape using a pre-fetched tag dict. Audience and category are
// already strings on the row — pass through.
function expandWithDict(row, dict) {
  const tags = [];
  for (const id of row.tag_ids || []) {
    const l = dict.get(id);
    if (l?.name) tags.push(l.name);
  }
  return {
    audience: row.audience || null,
    category: row.category || null,
    tags,
  };
}

// One-off expand: pulls the tag dict in a single follow-up query.
async function expandIds(row) {
  const ids = new Set(row.tag_ids || []);
  const dict = await fetchLabelDict([...ids]);
  return expandWithDict(row, dict);
}

// Write an event's labels. Audience/category go straight into ENUM
// columns; tags are resolved to ids and stored in tag_ids[]. Idempotent.
async function setEventLabels(eventId, { audience = null, category = null, tags = [] }) {
  const tagIds = await resolveMany(tags);

  const { error } = await supabase
    .from("events")
    .update({
      audience: audience || null,
      category: category || null,
      tag_ids: tagIds,
    })
    .eq("id", eventId);
  if (error) {
    console.warn(`[Labels] events update failed (#${eventId}):`, error.message);
  }
}

// Copy label dimensions from a source event onto a destination event.
// Used by the sibling cache when we know two events share the same
// content but only one has been enriched.
async function copyEventLabels(srcEventId, dstEventId) {
  const { data: src, error: rdErr } = await supabase
    .from("events")
    .select("audience, category, tag_ids")
    .eq("id", srcEventId)
    .maybeSingle();
  if (rdErr || !src) {
    console.warn(`[Labels] copy read failed (#${srcEventId}):`, rdErr?.message || "no row");
    return;
  }
  const { error: wrErr } = await supabase
    .from("events")
    .update({
      audience: src.audience || null,
      category: src.category || null,
      tag_ids: src.tag_ids || [],
    })
    .eq("id", dstEventId);
  if (wrErr) {
    console.warn(`[Labels] copy write failed (#${dstEventId}):`, wrErr.message);
  }
}

// Migration probe — sql/026 + sql/032 might not be applied yet. The
// enricher no-ops gracefully when this returns false instead of
// crashing the scrape loop.
let _schemaOk = null;
async function isSchemaReady() {
  if (_schemaOk !== null) return _schemaOk;
  const { error } = await supabase.from("labels").select("id").limit(1);
  if (error) {
    if (/relation .* does not exist/i.test(error.message) || error.code === "42P01") {
      _schemaOk = false;
      console.warn("[Labels] sql/026_normalized_labels.sql not applied — labels disabled until migration runs.");
      return false;
    }
    console.warn("[Labels] schema probe error:", error.message);
    _schemaOk = false;
    return false;
  }
  _schemaOk = true;
  return true;
}

module.exports = {
  normalizeName,
  getOrCreateLabel,
  resolveMany,
  resolveTagNamesToIds,
  getLabelsForEvent,
  getLabelsForEvents,
  setEventLabels,
  copyEventLabels,
  isSchemaReady,
  // Lower-level helpers for callers that already hold the row data and
  // just want to expand the tag_ids column into Hebrew names without
  // an extra round-trip to events.
  fetchLabelDict,
  expandWithDict,
  getPopularLabelNames,
  _clearCache,
};
