-- Persist the row-level marker for a transcription that fell back to local
-- fast styling after post-processing failed. Without this column the flag is
-- written by the TypeScript layer and dropped on the next read, so a degraded
-- row comes back looking clean.
ALTER TABLE transcriptions ADD COLUMN post_process_fallback INTEGER;
