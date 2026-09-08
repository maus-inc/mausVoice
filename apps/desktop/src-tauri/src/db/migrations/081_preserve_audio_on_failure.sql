-- When true (default), keep the recorded audio snapshot for a failed
-- transcription so the user can recover their words. Off restores the
-- pre-incognito behavior of dropping audio on failure.
ALTER TABLE user_preferences ADD COLUMN preserve_audio_on_failure INTEGER NOT NULL DEFAULT 1;
