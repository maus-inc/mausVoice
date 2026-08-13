-- Where "Reset Pill Position" re-homes the pill: the monitor the pill
-- currently lives on ("current", the historical default) or the monitor
-- under the mouse cursor ("cursor").
ALTER TABLE user_preferences ADD COLUMN pill_reset_monitor_strategy TEXT NOT NULL DEFAULT 'current';
