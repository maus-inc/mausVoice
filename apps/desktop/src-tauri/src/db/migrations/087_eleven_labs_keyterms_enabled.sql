-- Opt-in consent for sending dictionary terms as ElevenLabs keyterms.
-- 1 = enabled, 0 = disabled (default). Enabled only after the user
-- acknowledges the 20% transcription surcharge.
ALTER TABLE user_preferences ADD COLUMN eleven_labs_keyterms_enabled INTEGER NOT NULL DEFAULT 0;