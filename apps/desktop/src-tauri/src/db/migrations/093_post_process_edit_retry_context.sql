-- Persist the style and language the failed run used, so a claimed recovery
-- pass restyles with them instead of whatever the user has selected at resume.
-- An empty string records "the failed run used none"; NULL records that no
-- claim ever wrote the value.
ALTER TABLE transcriptions ADD COLUMN post_process_edit_retry_tone_id TEXT;
ALTER TABLE transcriptions ADD COLUMN post_process_edit_retry_language_code TEXT;
