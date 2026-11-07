ALTER TABLE user_preferences ADD COLUMN pill_reset_monitor_strategy TEXT NOT NULL DEFAULT 'current';
ALTER TABLE user_preferences ADD COLUMN always_request_admin_on_startup INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_preferences ADD COLUMN in_dictation_style_switching_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_preferences ADD COLUMN hallucination_filter_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE user_preferences ADD COLUMN review_before_insert INTEGER;
ALTER TABLE user_preferences ADD COLUMN agent_enabled_tools TEXT;
ALTER TABLE user_preferences ADD COLUMN agent_max_iterations INTEGER NOT NULL DEFAULT 20;
ALTER TABLE user_preferences ADD COLUMN agent_permission_timeout_ms INTEGER NOT NULL DEFAULT 60000;
ALTER TABLE user_preferences ADD COLUMN spoken_commands_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE user_preferences ADD COLUMN preserve_audio_on_failure INTEGER NOT NULL DEFAULT 1;
ALTER TABLE user_preferences ADD COLUMN pill_placement TEXT NOT NULL DEFAULT 'bottom';
ALTER TABLE user_preferences ADD COLUMN hands_free_delay_ms INTEGER;
ALTER TABLE user_preferences ADD COLUMN auto_learn_dictionary_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE user_preferences ADD COLUMN auto_learn_from_edits_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_preferences ADD COLUMN eleven_labs_keyterms_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_preferences ADD COLUMN expansion_flags TEXT NOT NULL DEFAULT '{}';
ALTER TABLE user_preferences ADD COLUMN update_channel TEXT NOT NULL DEFAULT 'stable';
INSERT INTO user_preferences (
    user_id, transcription_mode, post_processing_mode, agent_mode,
    pill_reset_monitor_strategy, always_request_admin_on_startup,
    in_dictation_style_switching_enabled, hallucination_filter_enabled,
    review_before_insert, agent_enabled_tools, agent_max_iterations,
    agent_permission_timeout_ms, spoken_commands_enabled,
    preserve_audio_on_failure, pill_placement, hands_free_delay_ms,
    auto_learn_dictionary_enabled, auto_learn_from_edits_enabled,
    eleven_labs_keyterms_enabled, expansion_flags, update_channel
) VALUES (
    'intermediate-user', 'cloud', char(99, 108, 111, 117, 100), 'cl' || 'oud',
    'primary', 1, 1, 0, 0, '["search"]', 7, 12000, 0, 0,
    'top', 850, 0, 1, 1, '{"example":true}', 'beta'
);

ALTER TABLE tones ADD COLUMN category TEXT;
ALTER TABLE tones ADD COLUMN output_length TEXT;
ALTER TABLE tones ADD COLUMN example_input_output TEXT;
INSERT INTO tones (id, name, prompt_template, created_at, sort_order, category, output_length, example_input_output)
VALUES ('custom-style', 'My style', 'Keep this prompt', 123, 4, 'Custom category', 'Two sentences', 'before -> after'),
       ('null-style', 'Nullable style', 'Keep nulls', 124, 5, NULL, NULL, NULL);

ALTER TABLE transcriptions ADD COLUMN post_process_provider TEXT;
ALTER TABLE transcriptions ADD COLUMN post_process_failed INTEGER;
ALTER TABLE transcriptions ADD COLUMN post_process_error TEXT;
ALTER TABLE transcriptions ADD COLUMN post_process_model TEXT;
INSERT INTO transcriptions (id, transcript, timestamp, post_process_provider, post_process_failed, post_process_error, post_process_model)
VALUES ('existing-transcript', 'Saved speech', 123, 'example-provider', 1, 'Saved failure detail', 'example-model');

ALTER TABLE user_profiles ADD COLUMN interaction_feedback_volume REAL NOT NULL DEFAULT 0.35;
INSERT INTO user_profiles (id, name, bio, interaction_feedback_volume)
VALUES ('intermediate-user', 'Existing user', 'Keep profile', 0.73);

ALTER TABLE api_keys ADD COLUMN transcription_path TEXT;
INSERT INTO api_keys (id, name, provider, created_at, salt, key_hash, key_ciphertext, transcription_path)
VALUES ('existing-key', 'Existing key', 'openai', 123, 'fixture-salt', 'fixture-hash', 'fixture-ciphertext', '/custom/transcribe');

-- Retirement matches on (version, description), so these two rows have to carry names
-- that are in `RETIRED_CONSOLIDATION_ERA_VERSIONS` or the open is refused. 075 is
-- `expansion_flags` and 087 is `eleven_labs_keyterms_enabled`, and both are in the list.
--
-- This comment used to claim that `add_tone_structured_fields` and
-- `add_eleven_labs_keyterms_enabled` "were never the recorded descriptions". They were:
-- `arena/01a01583-mausvoice` and several sibling branches register
-- `version: 75, description: "add_tone_structured_fields"`, and two register
-- `add_eleven_labs_keyterms_enabled` at 087. So those builds' databases are refused by the
-- open today. That is the deliberate trade the list's own comment describes -- surfacing an
-- unknown schema beats deleting its ledger row -- and it is a decision about branch builds,
-- not about the released 0.1.6.
--
-- Which is why this fixture cannot stand in for the shipped upgrade. It covers only the two
-- versions whose names are contested, and none of 071-074, which are the ones the released
-- 0.1.6 actually wrote and the ones whose names were wrong here until
-- `a_database_written_by_the_released_0_1_6_upgrades` was added. Green on this fixture was
-- compatible with the shipped upgrade path being refused outright.
INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time)
VALUES (75, 'expansion_flags', 1, x'deadbeef', 0),
       (87, 'eleven_labs_keyterms_enabled', 1, x'feedface', 0);
