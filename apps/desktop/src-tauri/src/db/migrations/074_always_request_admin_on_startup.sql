-- Opt-in: request UAC elevation at every startup (Windows). Off by default;
-- when the user declines the prompt the app continues normally.
ALTER TABLE user_preferences ADD COLUMN always_request_admin_on_startup INTEGER NOT NULL DEFAULT 0;
