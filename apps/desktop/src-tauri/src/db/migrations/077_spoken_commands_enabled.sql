-- Spoken formatting commands ("new line", "scratch that"). Default on.
-- PR #63 already uses 075 (tone structured fields) and 076
-- (hallucination_filter_enabled + other feature prefs). This column is 077
-- so both PRs can land without stealing each other's versions.
ALTER TABLE user_preferences ADD COLUMN spoken_commands_enabled INTEGER NOT NULL DEFAULT 1;
