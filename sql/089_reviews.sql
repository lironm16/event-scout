-- ⭐ Event reviews — public star ratings + optional notes, written after the
-- user attended (prompted when a saved event passes). Keyed by review_key so a
-- recurring same-name series shares one review thread, while distinct umbrella
-- children are reviewed individually:
--   review_key = "name|<min_months>|<max_months>" (normalized) — same-name
--   occurrences collapse; differently-named umbrella children stay separate.
create table if not exists reviews (
  telegram_id   text not null,
  review_key    text not null,
  event_id      bigint,                       -- a representative event (for linking)
  stars         smallint not null check (stars between 1 and 5),
  note          text,
  reviewer_name text,                         -- display name (public reviews)
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (telegram_id, review_key)       -- one review per user per series/event
);

create index if not exists reviews_key_idx on reviews (review_key);

-- Track which past-saved events we already nudged for review, so the prompt
-- fires once per user per review_key (never nags).
create table if not exists review_prompts (
  telegram_id text not null,
  review_key  text not null,
  event_id    bigint,
  sent_at     timestamptz not null default now(),
  primary key (telegram_id, review_key)
);
