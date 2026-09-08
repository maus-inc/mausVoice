-- Watch the target app after dictation and offer to add corrected names as
-- glossary terms. 1 = enabled, 0 = disabled (default). Off by default because
-- it polls the focused text field through the accessibility APIs.
ALTER TABLE user_preferences ADD COLUMN auto_learn_from_edits_enabled INTEGER NOT NULL DEFAULT 0;
