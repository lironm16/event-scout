-- Migrate user_context from { kids, preferences } to { kids, constraints, interests }
-- Old: preferences.home_address, preferences.distance_constraint, preferences.interests
-- New: constraints.home_address, constraints.proximity_preference, interests (top-level)

UPDATE profiles
SET user_context = jsonb_build_object(
  'kids', COALESCE(user_context->'kids', '[]'::jsonb),
  'constraints', jsonb_build_object(
    'home_address',
      COALESCE(
        user_context->'preferences'->>'home_address',
        user_context->'preferences'->>'preferred_area'
      ),
    'proximity_preference',
      COALESCE(
        user_context->'preferences'->>'distance_constraint',
        CASE
          WHEN user_context->'preferences'->>'max_walking_minutes' IS NOT NULL
          THEN (user_context->'preferences'->>'max_walking_minutes') || ' min walk'
          ELSE NULL
        END
      )
  ),
  'interests', COALESCE(user_context->'preferences'->'interests', '[]'::jsonb)
)
WHERE user_context ? 'preferences';

NOTIFY pgrst, 'reload schema';
