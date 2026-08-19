-- Spoken formatting commands ("new line", "scratch that"). Default on.
ALTER TABLE user_preferences ADD COLUMN spoken_commands_enabled INTEGER NOT NULL DEFAULT 1;
