-- 076: Meeting notes domain tables.
-- Stores meetings, timed transcript segments, and speaker identities.
CREATE TABLE IF NOT EXISTS meetings (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'idle',
    summary TEXT,
    transcript TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'microphone'
);

CREATE INDEX IF NOT EXISTS idx_meetings_created_at ON meetings (created_at DESC);

CREATE TABLE IF NOT EXISTS meeting_segments (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL,
    speaker_id TEXT NOT NULL,
    start_time_ms INTEGER NOT NULL,
    end_time_ms INTEGER NOT NULL,
    text TEXT NOT NULL,
    confidence REAL,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_meeting_segments_meeting_start
    ON meeting_segments (meeting_id, start_time_ms ASC);

CREATE TABLE IF NOT EXISTS meeting_speakers (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL,
    name TEXT NOT NULL,
    label TEXT,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
);
