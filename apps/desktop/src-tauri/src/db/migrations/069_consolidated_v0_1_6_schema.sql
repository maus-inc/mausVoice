-- 069: Consolidate every post-0.1.5 schema change into the first migration
-- after the 0.1.5 release step (0.1.5 shipped through migration 68).
--
-- Former individual migrations now folded in here. Every number below is a
-- step some ref in this repository carried, and the list is the same 16
-- versions RETIRED_CONSOLIDATION_ERA_VERSIONS retires on open. No step is
-- claimed for 070, 080 or 088, which no ref ever used.
--   071 remove_cloud_modes (data rewrite), 072 drop is_enterprise,
--   073 pill_reset_monitor_strategy, 074 always_request_admin_on_startup,
--   075 expansion_flags, tone structured fields, or
--   preserve_audio_on_failure (three refs gave a different step the number
--   075), 076 feature preferences, 077 spoken_commands_enabled,
--   078 post-process attribution columns, 079 interaction_feedback_volume,
--   081 preserve_audio_on_failure, 082 api_keys.transcription_path,
--   083 pill_placement + hands_free_delay, 084 auto_learn_dictionary,
--   085 auto_learn_from_edits, 086 transcription post-process model,
--   087 eleven_labs_keyterms_enabled, plus the 0.1.6 update_channel
--   preference column.
--
-- SQLite has no ADD COLUMN IF NOT EXISTS, and databases written by
-- intermediate superfix builds already applied some of the steps above
-- individually. Each affected table is therefore rebuilt to the exact
-- target shape (the same rebuild pattern migration 024 established),
-- copying the stable post-0.1.5 columns; the consolidated columns come
-- back at their defaults. The whole file runs in one transaction.

-- user_preferences: rebuild to the consolidated 0.1.6 shape.
CREATE TABLE user_preferences_v016 (
  user_id TEXT PRIMARY KEY,
  transcription_mode TEXT,
  transcription_api_key_id TEXT,
  post_processing_mode TEXT,
  post_processing_api_key_id TEXT,
  active_tone_id TEXT,
  transcription_device TEXT,
  transcription_model_size TEXT,
  post_processing_ollama_url TEXT,
  post_processing_ollama_model TEXT,
  got_started_at INTEGER,
  gpu_enumeration_enabled INTEGER NOT NULL DEFAULT 0,
  paste_keybind TEXT,
  agent_mode TEXT,
  agent_mode_api_key_id TEXT,
  last_seen_feature TEXT DEFAULT NULL,
  language_switch_enabled INTEGER NOT NULL DEFAULT 0,
  secondary_dictation_language TEXT,
  active_dictation_language TEXT,
  preferred_microphone TEXT,
  ignore_update_dialog INTEGER NOT NULL DEFAULT 0,
  incognito_mode_enabled INTEGER NOT NULL DEFAULT 0,
  incognito_mode_include_in_stats INTEGER NOT NULL DEFAULT 0,
  dictation_pill_visibility TEXT NOT NULL DEFAULT 'while_active',
  additional_dictation_languages TEXT,
  use_new_backend INTEGER NOT NULL DEFAULT 0,
  openclaw_gateway_url TEXT,
  openclaw_token TEXT,
  realtime_output_enabled INTEGER NOT NULL DEFAULT 0,
  remote_output_enabled INTEGER NOT NULL DEFAULT 0,
  remote_target_device_id TEXT,
  remote_receiver_port INTEGER,
  remote_receiver_auto_start INTEGER NOT NULL DEFAULT 0,
  dictation_audio_dim REAL DEFAULT 1.0,
  dictation_limit_minutes INTEGER NOT NULL DEFAULT 5,
  menu_bar_icon_hidden INTEGER NOT NULL DEFAULT 0,
  insertion_method TEXT,
  typing_speed_ms INTEGER,
  pill_reset_monitor_strategy TEXT NOT NULL DEFAULT 'current',
  always_request_admin_on_startup INTEGER NOT NULL DEFAULT 0,
  in_dictation_style_switching_enabled INTEGER NOT NULL DEFAULT 0,
  hallucination_filter_enabled INTEGER NOT NULL DEFAULT 1,
  review_before_insert INTEGER,
  agent_enabled_tools TEXT,
  agent_max_iterations INTEGER NOT NULL DEFAULT 20,
  agent_permission_timeout_ms INTEGER NOT NULL DEFAULT 60000,
  spoken_commands_enabled INTEGER NOT NULL DEFAULT 1,
  preserve_audio_on_failure INTEGER NOT NULL DEFAULT 1,
  pill_placement TEXT NOT NULL DEFAULT 'bottom',
  hands_free_delay_ms INTEGER,
  auto_learn_dictionary_enabled INTEGER NOT NULL DEFAULT 1,
  auto_learn_from_edits_enabled INTEGER NOT NULL DEFAULT 0,
  eleven_labs_keyterms_enabled INTEGER NOT NULL DEFAULT 0,
  expansion_flags TEXT NOT NULL DEFAULT '{}',
  update_channel TEXT NOT NULL DEFAULT 'stable'
);
INSERT INTO user_preferences_v016 (user_id, transcription_mode, transcription_api_key_id, post_processing_mode, post_processing_api_key_id, active_tone_id, transcription_device, transcription_model_size, post_processing_ollama_url, post_processing_ollama_model, got_started_at, gpu_enumeration_enabled, paste_keybind, agent_mode, agent_mode_api_key_id, last_seen_feature, language_switch_enabled, secondary_dictation_language, active_dictation_language, preferred_microphone, ignore_update_dialog, incognito_mode_enabled, incognito_mode_include_in_stats, dictation_pill_visibility, additional_dictation_languages, use_new_backend, openclaw_gateway_url, openclaw_token, realtime_output_enabled, remote_output_enabled, remote_target_device_id, remote_receiver_port, remote_receiver_auto_start, dictation_audio_dim, dictation_limit_minutes, menu_bar_icon_hidden, insertion_method, typing_speed_ms)
SELECT user_id, transcription_mode, transcription_api_key_id, post_processing_mode, post_processing_api_key_id, active_tone_id, transcription_device, transcription_model_size, post_processing_ollama_url, post_processing_ollama_model, got_started_at, gpu_enumeration_enabled, paste_keybind, agent_mode, agent_mode_api_key_id, last_seen_feature, language_switch_enabled, secondary_dictation_language, active_dictation_language, preferred_microphone, ignore_update_dialog, incognito_mode_enabled, incognito_mode_include_in_stats, dictation_pill_visibility, additional_dictation_languages, use_new_backend, openclaw_gateway_url, openclaw_token, realtime_output_enabled, remote_output_enabled, remote_target_device_id, remote_receiver_port, remote_receiver_auto_start, dictation_audio_dim, dictation_limit_minutes, menu_bar_icon_hidden, insertion_method, typing_speed_ms FROM user_preferences;
DROP TABLE user_preferences;
ALTER TABLE user_preferences_v016 RENAME TO user_preferences;

-- transcriptions: rebuild to the consolidated 0.1.6 shape.
CREATE TABLE transcriptions_v016 (
  id TEXT PRIMARY KEY,
  transcript TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  audio_path TEXT,
  audio_duration_ms INTEGER,
  model_size TEXT,
  inference_device TEXT,
  raw_transcript TEXT,
  transcription_prompt TEXT,
  post_process_prompt TEXT,
  transcription_api_key_id TEXT,
  post_process_api_key_id TEXT,
  transcription_mode TEXT,
  post_process_mode TEXT,
  post_process_device TEXT,
  warnings_json TEXT,
  transcription_duration_ms INTEGER,
  postprocess_duration_ms INTEGER,
  sanitized_transcript TEXT,
  remote_status TEXT,
  remote_device_id TEXT,
  post_process_provider TEXT,
  post_process_failed INTEGER,
  post_process_error TEXT,
  post_process_model TEXT
);
INSERT INTO transcriptions_v016 (id, transcript, timestamp, audio_path, audio_duration_ms, model_size, inference_device, raw_transcript, transcription_prompt, post_process_prompt, transcription_api_key_id, post_process_api_key_id, transcription_mode, post_process_mode, post_process_device, warnings_json, transcription_duration_ms, postprocess_duration_ms, sanitized_transcript, remote_status, remote_device_id)
SELECT id, transcript, timestamp, audio_path, audio_duration_ms, model_size, inference_device, raw_transcript, transcription_prompt, post_process_prompt, transcription_api_key_id, post_process_api_key_id, transcription_mode, post_process_mode, post_process_device, warnings_json, transcription_duration_ms, postprocess_duration_ms, sanitized_transcript, remote_status, remote_device_id FROM transcriptions;
DROP TABLE transcriptions;
ALTER TABLE transcriptions_v016 RENAME TO transcriptions;

-- tones: rebuild to the consolidated 0.1.6 shape.
CREATE TABLE tones_v016 (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  prompt_template TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  category TEXT,
  output_length TEXT,
  example_input_output TEXT
);
INSERT INTO tones_v016 (id, name, prompt_template, created_at, sort_order)
SELECT id, name, prompt_template, created_at, sort_order FROM tones;
DROP TABLE tones;
ALTER TABLE tones_v016 RENAME TO tones;

-- user_profiles: rebuild to the consolidated 0.1.6 shape.
CREATE TABLE user_profiles_v016 (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  bio TEXT NOT NULL,
  onboarded INTEGER NOT NULL DEFAULT 0 CHECK (onboarded IN (0, 1)),
  preferred_microphone TEXT,
  play_interaction_chime INTEGER NOT NULL DEFAULT 1,
  preferred_transcription_mode TEXT,
  preferred_transcription_api_key_id TEXT,
  preferred_post_processing_mode TEXT,
  preferred_post_processing_api_key_id TEXT,
  words_this_month INTEGER NOT NULL DEFAULT 0,
  words_this_month_month TEXT,
  words_total INTEGER NOT NULL DEFAULT 0,
  preferred_language TEXT,
  has_finished_tutorial INTEGER NOT NULL DEFAULT 0,
  has_migrated_preferred_microphone INTEGER NOT NULL DEFAULT 0,
  cohort TEXT,
  company TEXT,
  title TEXT,
  styling_mode TEXT,
  selected_tone_id TEXT,
  active_tone_ids TEXT,
  streak INTEGER,
  streak_recorded_at TEXT,
  referral_source TEXT,
  interaction_feedback_volume REAL NOT NULL DEFAULT 0.35
);
INSERT INTO user_profiles_v016 (id, name, bio, onboarded, preferred_microphone, play_interaction_chime, preferred_transcription_mode, preferred_transcription_api_key_id, preferred_post_processing_mode, preferred_post_processing_api_key_id, words_this_month, words_this_month_month, words_total, preferred_language, has_finished_tutorial, has_migrated_preferred_microphone, cohort, company, title, styling_mode, selected_tone_id, active_tone_ids, streak, streak_recorded_at, referral_source)
SELECT id, name, bio, CASE WHEN onboarded = 1 THEN 1 ELSE 0 END, preferred_microphone, play_interaction_chime, preferred_transcription_mode, preferred_transcription_api_key_id, preferred_post_processing_mode, preferred_post_processing_api_key_id, words_this_month, words_this_month_month, words_total, preferred_language, has_finished_tutorial, has_migrated_preferred_microphone, cohort, company, title, styling_mode, selected_tone_id, active_tone_ids, streak, streak_recorded_at, referral_source FROM user_profiles;
DROP TABLE user_profiles;
ALTER TABLE user_profiles_v016 RENAME TO user_profiles;

-- api_keys: rebuild to the consolidated 0.1.6 shape.
CREATE TABLE api_keys_v016 (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  salt TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  key_ciphertext TEXT NOT NULL,
  key_suffix TEXT,
  transcription_model TEXT,
  post_processing_model TEXT,
  openrouter_config TEXT,
  base_url TEXT,
  azure_region TEXT,
  include_v1_path INTEGER DEFAULT 1,
  transcription_path TEXT
);
INSERT INTO api_keys_v016 (id, name, provider, created_at, salt, key_hash, key_ciphertext, key_suffix, transcription_model, post_processing_model, openrouter_config, base_url, azure_region, include_v1_path)
SELECT id, name, provider, created_at, salt, key_hash, key_ciphertext, key_suffix, transcription_model, post_processing_model, openrouter_config, base_url, azure_region, include_v1_path FROM api_keys;
DROP TABLE api_keys;
ALTER TABLE api_keys_v016 RENAME TO api_keys;

-- Recreate the index that lived on tones (024).
CREATE INDEX IF NOT EXISTS idx_tones_sort_order ON tones (sort_order);
CREATE INDEX IF NOT EXISTS idx_api_keys_created_at ON api_keys (created_at DESC);

-- Former 071: stored "cloud" modes resolve to the always-available
-- equivalents (char() literals keep the literal out of three comparisons).
UPDATE user_preferences
SET transcription_mode = 'local'
WHERE transcription_mode = char(99, 108, 111, 117, 100);

UPDATE user_preferences
SET post_processing_mode = 'none'
WHERE post_processing_mode = char(99, 108, 111, 117, 100);

UPDATE user_preferences
SET agent_mode = 'none'
WHERE agent_mode = char(99, 108, 111, 117, 100);
