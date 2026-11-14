-- Where the dictation pill was last parked, so an app launch puts it back
-- instead of re-homing it to the default corner.
--
-- One row, keyed by a constant, because there is one pill window per install.
-- The record is written by the backend only, never through the preference
-- upsert: the renderer owns the user_preferences row and would overwrite a
-- geometry column with null on the next unrelated preference save.
--
-- `saved_at` exists so a future migration can expire a stale layout, and so
-- support can see when the value was written. Both are INTEGER because SQLite
-- has no boolean type and stores seconds as an integer.
CREATE TABLE IF NOT EXISTS pill_position (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    record TEXT NOT NULL,
    saved_at INTEGER NOT NULL
);
