-- Transcription ids whose row is gone but whose audio snapshot could not be
-- removed with it. `transcription_delete` deletes the row whether or not the
-- snapshot was removable — on Windows a playing transcript holds its `.wav`
-- without delete sharing — and nothing else can find what is left behind:
-- `purge_stale_transcription_audio` selects `WHERE audio_path IS NOT NULL`, which
-- a deleted row can never satisfy, and the orphan sweep runs only on a full local
-- wipe. This table is what keeps the retry reachable.
--
-- `attempts` bounds the retry: one attempt per sweep, so a record that can never
-- succeed is not retried on every dictation forever. The primary key does the
-- other half — a repeated failure of the same id adds no row.
CREATE TABLE IF NOT EXISTS pending_audio_deletions (
    id TEXT PRIMARY KEY NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0
);