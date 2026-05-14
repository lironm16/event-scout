-- Clean up duplicate kids entry for Liron (telegram_id 6354544467)
-- Keep only Emily (5) and the boy (1)
UPDATE profiles
SET user_context = jsonb_set(
  user_context,
  '{kids}',
  '[{"name": "אמילי", "age": 5}, {"name": "בן", "age": 1}]'::jsonb
)
WHERE telegram_id = '6354544467';
