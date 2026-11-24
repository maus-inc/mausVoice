-- Modifier that replays the pill's outline on a double tap. "none" disables it
-- so upgrading does not change what the keyboard does.
ALTER TABLE user_preferences ADD COLUMN pill_locate_gesture_modifier TEXT NOT NULL DEFAULT 'none';
