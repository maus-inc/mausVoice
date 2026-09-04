-- 075: Add expansion_flags column to user_preferences.
-- Stores a JSON object of feature-name -> boolean flags so each expansion
-- feature can be toggled without a schema change per feature.
ALTER TABLE user_preferences ADD COLUMN expansion_flags TEXT NOT NULL DEFAULT '{}';
