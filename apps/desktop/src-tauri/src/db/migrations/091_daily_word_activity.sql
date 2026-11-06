-- Daily word totals are intentionally stored without transcript text. The
-- event table supplies stable, idempotent keys for live metering and the
-- dashboard's repair/backfill pass; deleting a transcription does not undo
-- statistics, matching the existing profile counters.
CREATE TABLE IF NOT EXISTS daily_word_activity (
    local_date TEXT PRIMARY KEY NOT NULL
        CHECK (local_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    word_count INTEGER NOT NULL DEFAULT 0
        CHECK (word_count >= 0 AND word_count <= 9007199254740991)
);

CREATE TABLE IF NOT EXISTS daily_word_activity_events (
    event_id TEXT PRIMARY KEY NOT NULL CHECK (length(event_id) > 0),
    local_date TEXT NOT NULL
        CHECK (local_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    word_count INTEGER NOT NULL
        CHECK (word_count >= 0 AND word_count <= 9007199254740991),
    source TEXT NOT NULL CHECK (source IN ('live', 'backfill'))
);

-- Backfill walks old history chronologically and uses this index to avoid a
-- table sort. The id tie-breaker makes keyset pagination deterministic.
CREATE INDEX IF NOT EXISTS idx_transcriptions_timestamp_id
    ON transcriptions (timestamp, id);
