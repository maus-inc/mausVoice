-- Optional structured guidance for user-defined writing styles.
-- All columns are nullable so existing free-form tones retain their behavior.
ALTER TABLE tones ADD COLUMN category TEXT;
ALTER TABLE tones ADD COLUMN output_length TEXT;
ALTER TABLE tones ADD COLUMN example_input_output TEXT;
