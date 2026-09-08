-- Custom transcription path override for OpenAI-compatible providers
-- (e.g. OpenWebUI uses `/v1/audio/transcriptions` instead of `/audio/transcriptions`).
-- NULL means use the default `/audio/transcriptions` for the configured `includeV1Path`.
ALTER TABLE api_keys ADD COLUMN transcription_path TEXT;
