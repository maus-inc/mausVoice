-- Pill anchor position (top|bottom) and configurable hands-free delay.
-- NULL pill_placement keeps the historical default "bottom"; NULL
-- hands_free_delay_ms disables the post-stop delay.
ALTER TABLE user_preferences ADD COLUMN pill_placement TEXT NOT NULL DEFAULT 'bottom';
ALTER TABLE user_preferences ADD COLUMN hands_free_delay_ms INTEGER;
