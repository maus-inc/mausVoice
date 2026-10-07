-- Fast local styling for short dictations.
--
-- Stored as 1/0 because SQLite has no boolean type. A row written before this
-- step has no value, and the reader treats a missing or unreadable column as
-- NULL, which the domain default maps to on: short dictations were already
-- styled locally by the no-LLM path, and the preference only decides whether
-- that same path is used while a provider is configured.
ALTER TABLE user_preferences
ADD COLUMN fast_style_short_dictations_enabled INTEGER NOT NULL DEFAULT 1;
