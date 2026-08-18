-- Spoken formatting commands ("new line", "scratch that"). Default on.
-- Hallucination filtering is always on here; PR #63 migration 076 owns
-- hallucination_filter_enabled so we do not add that column on this branch.
ALTER TABLE user_preferences ADD COLUMN spoken_commands_enabled INTEGER NOT NULL DEFAULT 1;
