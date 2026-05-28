// Popular venues for the favorite-locations picker — sorted by active
// event count (see sql/071_top_locations_rpc.sql).

const supabase = require("./supabase");
const { displayLocationText } = require("./locationStore");

const PAGE_SIZE = 10;

function locationLabel(row) {
  const loc = {
    raw_address: row.raw_address,
    display_name: row.display_name,
    found: true,
    kind: "physical",
  };
  return displayLocationText(loc) || row.raw_address || row.location_key;
}

async function fetchTopLocationsPage(offset = 0) {
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  const limit = PAGE_SIZE + 1;
  const { data, error } = await supabase.rpc("top_locations_page", {
    p_offset: offset,
    p_limit: limit,
  });
  if (error) {
    console.warn("[TopLocations] rpc failed, falling back to last_used_at:", error.message);
    return fetchTopLocationsFallback(offset);
  }
  const rows = data || [];
  const hasMore = rows.length > PAGE_SIZE;
  const slice = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
  const locations = slice.map((r, i) => ({
    index: offset + i,
    key: String(r.location_key),
    label: locationLabel(r),
    events_count: Number(r.events_count || 0),
  }));
  return { locations, hasMore };
}

async function fetchTopLocationsFallback(offset = 0) {
  const limit = PAGE_SIZE + 1;
  const { data, error } = await supabase
    .from("locations")
    .select("key, raw_address, display_name, found, kind")
    .eq("found", true)
    .order("last_used_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) {
    console.warn("[TopLocations] fallback failed:", error.message);
    return { locations: [], hasMore: false };
  }
  const rows = (data || []).filter(
    (r) => !r.kind || !["placeholder", "unknown"].includes(r.kind),
  );
  const hasMore = rows.length > PAGE_SIZE;
  const slice = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
  const locations = slice.map((r, i) => ({
    index: offset + i,
    key: String(r.key),
    label: locationLabel(r),
    events_count: 0,
  }));
  return { locations, hasMore };
}

let _countCache = { value: null, fetchedAt: 0 };
const COUNT_TTL_MS = 60_000;

async function countAvailableLocations() {
  const now = Date.now();
  if (_countCache.value != null && now - _countCache.fetchedAt < COUNT_TTL_MS) {
    return _countCache.value;
  }
  const { data, error } = await supabase.rpc("count_top_locations");
  if (error) {
    console.warn("[TopLocations] count rpc failed:", error.message);
    return _countCache.value || 0;
  }
  _countCache = { value: Number(data || 0), fetchedAt: now };
  return _countCache.value;
}

module.exports = {
  PAGE_SIZE,
  fetchTopLocationsPage,
  countAvailableLocations,
  locationLabel,
};
