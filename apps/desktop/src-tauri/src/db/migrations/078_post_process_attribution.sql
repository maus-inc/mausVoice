ALTER TABLE transcriptions
    ADD COLUMN post_process_provider TEXT;
ALTER TABLE transcriptions
    ADD COLUMN post_process_failed INTEGER;
ALTER TABLE transcriptions
    ADD COLUMN post_process_error TEXT;
