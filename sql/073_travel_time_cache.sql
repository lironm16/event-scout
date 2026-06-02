-- 073_travel_time_cache.sql — persistent (restart-surviving) cache for
-- Google Routes travel times, shared across users via a COARSE home grid.
--
-- Why: the in-process cache in lib/googleRoutes.js keys on ~11 m precision,
-- so virtually every user is a distinct origin → no cross-user sharing and
-- a full reset on every deploy/restart. At thousands of users that means
-- re-calling the Routes API for the same neighbourhoods over and over.
--
-- This table caches (coarse home cell, venue cell, mode) → minutes. The
-- coarse home cell (~1 km) collapses many users in the same area onto one
-- row, and the row survives restarts. Combined with the borderline gate in
-- lib/geocoding.js (only call the API when the straight-line distance is
-- near the user's walk/drive threshold), API volume stays bounded.

create table if not exists public.travel_time_cache (
  home_cell   text        not null,   -- "lat,lng" rounded to ~1 km
  venue_cell  text        not null,   -- "lat,lng" rounded to ~110 m
  mode        text        not null,   -- 'walk' | 'drive'
  minutes     integer     not null,
  computed_at timestamptz not null default now(),
  primary key (home_cell, venue_cell, mode)
);

-- Cheap eviction of stale rows (callers also enforce a TTL on read).
create index if not exists travel_time_cache_computed_at_idx
  on public.travel_time_cache (computed_at);
