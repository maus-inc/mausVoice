-- Persist semantic post-processing edit failures and their per-row retry-chain count.
ALTER TABLE transcriptions ADD COLUMN post_process_edit_failed INTEGER;
ALTER TABLE transcriptions ADD COLUMN post_process_edit_failure_count INTEGER;
ALTER TABLE transcriptions ADD COLUMN post_process_edit_auto_retry_used INTEGER;
