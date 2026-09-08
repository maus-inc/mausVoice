-- Auto-learn dictionary terms from manual transcript corrections.
-- 1 = enabled (default), 0 = disabled. When enabled, saving a corrected
-- transcription adds the corrected names and words as glossary terms.
ALTER TABLE user_preferences ADD COLUMN auto_learn_dictionary_enabled INTEGER NOT NULL DEFAULT 1;
