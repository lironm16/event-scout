CREATE TABLE IF NOT EXISTS profiles (
  phone_number  TEXT PRIMARY KEY,
  first_name    TEXT,
  user_context  JSONB NOT NULL DEFAULT '{}'::jsonb,
  active_watch_list JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_seen     TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_profiles_user_context
  ON profiles USING GIN (user_context);

CREATE INDEX IF NOT EXISTS idx_profiles_watch_list
  ON profiles USING GIN (active_watch_list);
