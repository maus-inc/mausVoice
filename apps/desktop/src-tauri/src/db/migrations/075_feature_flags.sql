-- Expansion feature flags and ephemeral session mode. All flags off by default;
-- toggled at runtime via the feature flag service.
ALTER TABLE user_preferences ADD COLUMN meeting_notes_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_preferences ADD COLUMN local_automation_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_preferences ADD COLUMN connectors_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_preferences ADD COLUMN webhooks_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_preferences ADD COLUMN translations_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_preferences ADD COLUMN interactive_snippets_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_preferences ADD COLUMN hands_free_toggle_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_preferences ADD COLUMN voice_workflows_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_preferences ADD COLUMN ephemeral_session_enabled INTEGER NOT NULL DEFAULT 0;
