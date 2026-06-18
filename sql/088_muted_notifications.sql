-- 🔕 Per-user notification mutes. Distinct from profile suppressions: a muted
-- key stops bot pushes / newsletter mentions but the event STILL appears in the
-- Mini App catalog. Keyed by a stable identity ("umb:<slug>" for a series, else
-- "evt:<id>") so muting one occurrence silences the whole recurring series.
create table if not exists muted_notifications (
  telegram_id text not null,
  mute_key    text not null,
  created_at  timestamptz not null default now(),
  primary key (telegram_id, mute_key)
);

create index if not exists muted_notifications_tg_idx
  on muted_notifications (telegram_id);
