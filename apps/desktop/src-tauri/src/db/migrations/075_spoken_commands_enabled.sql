-- Spoken formatting commands ("new line", "scratch that"). Default on.
-- Next unused version after 074. Do not use 076: PR #63 owns
-- hallucination_filter_enabled on that version.
ALTER TABLE user_preferences ADD COLUMN spoken_commands_enabled INTEGER NOT NULL DEFAULT 1;
