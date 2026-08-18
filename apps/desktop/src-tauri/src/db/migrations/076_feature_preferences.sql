-- Preferences for dictation style cycling, hallucination filtering, composer
-- review, and agent configuration.
ALTER TABLE user_preferences ADD COLUMN in_dictation_style_switching_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_preferences ADD COLUMN hallucination_filter_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE user_preferences ADD COLUMN review_before_insert INTEGER;
ALTER TABLE user_preferences ADD COLUMN agent_enabled_tools TEXT;
ALTER TABLE user_preferences ADD COLUMN agent_max_iterations INTEGER NOT NULL DEFAULT 20;
ALTER TABLE user_preferences ADD COLUMN agent_permission_timeout_ms INTEGER NOT NULL DEFAULT 60000;
