-- Keep-ready microphone preferences.
--
-- These were added to the TypeScript `UserPreferences` and to the settings UI
-- before they existed here, so `user_preferences_set` dropped them on the way
-- to the database and every launch read back the default: the user moved the
-- slider, saw it stay where they left it for the session, and found it back at
-- the default afterwards.
--
-- The defaults are the ones the recorder already behaves with, so a row that
-- predates this step keeps working without being rewritten:
--   * keep_microphone_ready off -- holding a device lights the OS microphone
--     indicator continuously, which has to be opted into.
--   * microphone_preroll_seconds 0.5 -- what the capture code already used.
--   * microphone_linger_ms 0 -- close at stop.
ALTER TABLE user_preferences
ADD COLUMN keep_microphone_ready INTEGER NOT NULL DEFAULT 0;

ALTER TABLE user_preferences
ADD COLUMN microphone_preroll_seconds REAL NOT NULL DEFAULT 0.5;

ALTER TABLE user_preferences
ADD COLUMN microphone_linger_ms INTEGER NOT NULL DEFAULT 0;
