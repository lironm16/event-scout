// ⭐ Event reviews — public star ratings + notes (sql/089).
//
// review_key groups occurrences the way a user thinks about them:
//   • a recurring same-name series → ONE shared review thread
//   • distinct umbrella children (different names) → separate threads
// Keying on the normalized name + age bounds achieves both with no sibling
// lookup: same-name occurrences collapse, differently-named ones stay apart.
const supabase = require("./supabase");

function normName(s) {
  return (s || "").toLowerCase().replace(/[״׳"'`]/g, " ").replace(/\s+/g, " ").trim();
}

function reviewKeyForEvent(event) {
  if (!event) return null;
  const name = normName(event.name);
  const mn = Number.isFinite(event.min_months) ? event.min_months : "";
  const mx = Number.isFinite(event.max_months) ? event.max_months : "";
  return `${name}|${mn}|${mx}`;
}

async function reviewKeyForEventId(eventId) {
  const { data } = await supabase
    .from("events")
    .select("id, name, min_months, max_months")
    .eq("id", parseInt(eventId, 10))
    .maybeSingle();
  return data ? reviewKeyForEvent(data) : null;
}

// Upsert a review (one per user per key). Stars 1-5; note optional.
async function saveReview(telegramId, { eventId, reviewKey, stars, note, reviewerName }) {
  const key = reviewKey || (await reviewKeyForEventId(eventId));
  if (!key) throw new Error("saveReview: could not resolve review_key");
  const s = Math.max(1, Math.min(5, parseInt(stars, 10) || 0));
  const { error } = await supabase
    .from("reviews")
    .upsert(
      {
        telegram_id: String(telegramId),
        review_key: key,
        event_id: eventId != null ? parseInt(eventId, 10) : null,
        stars: s,
        note: (note || "").toString().slice(0, 800) || null,
        reviewer_name: (reviewerName || "").toString().slice(0, 80) || null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "telegram_id,review_key" },
    );
  if (error) throw new Error(`saveReview failed: ${error.message}`);
  return key;
}

// Aggregate + list for a key: { count, average, reviews: [{stars,note,name,at,mine}] }
async function getReviews(reviewKey, { telegramId } = {}) {
  const { data, error } = await supabase
    .from("reviews")
    .select("telegram_id, stars, note, reviewer_name, created_at")
    .eq("review_key", reviewKey)
    .order("created_at", { ascending: false });
  if (error) return { count: 0, average: null, reviews: [] };
  const rows = data || [];
  const count = rows.length;
  const average = count ? Math.round((rows.reduce((a, r) => a + r.stars, 0) / count) * 10) / 10 : null;
  return {
    count,
    average,
    reviews: rows.map((r) => ({
      stars: r.stars,
      note: r.note || null,
      name: r.reviewer_name || null,
      at: r.created_at,
      mine: telegramId != null && String(r.telegram_id) === String(telegramId),
    })),
  };
}

async function getMyReview(telegramId, reviewKey) {
  const { data } = await supabase
    .from("reviews")
    .select("stars, note")
    .eq("telegram_id", String(telegramId))
    .eq("review_key", reviewKey)
    .maybeSingle();
  return data || null;
}

module.exports = {
  reviewKeyForEvent,
  reviewKeyForEventId,
  saveReview,
  getReviews,
  getMyReview,
  normName,
};
