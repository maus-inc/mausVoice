-- Daily word totals for the home activity heatmap. The activity table stores
-- only local calendar dates and aggregate word counts; it never stores text.
CREATE TABLE daily_word_activity (
  local_date TEXT PRIMARY KEY NOT NULL,
  word_count INTEGER NOT NULL CHECK (word_count >= 0)
);

-- Stable event IDs make local metering idempotent across duplicate IPC calls
-- and retries. This table intentionally retains no transcript content.
CREATE TABLE daily_word_activity_events (
  event_id TEXT PRIMARY KEY NOT NULL,
  local_date TEXT NOT NULL,
  word_count INTEGER NOT NULL CHECK (word_count > 0)
);

-- Captures the release boundary so the first runtime backfill includes only
-- records that existed before this feature. New recordings are counted through
-- the event path even if the dashboard has not yet triggered backfill.
CREATE TABLE daily_word_activity_backfill_state (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  cutoff_timestamp_ms INTEGER NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1))
);

INSERT INTO daily_word_activity_backfill_state (id, cutoff_timestamp_ms, completed)
VALUES (
  1,
  CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
  0
);

-- Supports the bounded 26-week one-time scan and the existing newest-first feed.
CREATE INDEX IF NOT EXISTS idx_transcriptions_timestamp
  ON transcriptions(timestamp);
