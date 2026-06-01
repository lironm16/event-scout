// Upcoming sibling rows for a city umbrella programme (sql/054).
// Shared by the bot card buttons and the agent presenter so counts
// match the full "כל אירועי …" list, not the user's search date window.

const { DateTime } = require("luxon");
const supabase = require("./supabase");

const UMBRELLA_SIBLING_SELECT =
  "id, source, external_slug, external_url, online_url, umbrella_title, name, date, start_time, end_time, tickets_left, description, min_months, max_months, audience, tag_ids, access, category, location_key, locations:location_key(raw_address, lat, lng)";

async function fetchUmbrellaSiblingRows(slug) {
  const today = DateTime.now().setZone("Asia/Jerusalem").toISODate();
  return supabase
    .from("events")
    .select(UMBRELLA_SIBLING_SELECT)
    .eq("umbrella_slug", slug)
    .eq("archived", false)
    .gte("date", today)
    .order("date", { ascending: true })
    .order("start_time", { ascending: true });
}

module.exports = {
  UMBRELLA_SIBLING_SELECT,
  fetchUmbrellaSiblingRows,
};
