-- 078: Snippets (text expansion) with fill-in variables.
-- Body may contain {{variable}} placeholders plus built-ins:
-- {{DATE}} {{TIME}} {{DATETIME}} {{CLIPBOARD}}.
-- Variables are stored as JSON; enabled toggles the trigger without deleting.
CREATE TABLE IF NOT EXISTS snippets (
    id TEXT PRIMARY KEY,
    trigger TEXT NOT NULL UNIQUE,
    body TEXT NOT NULL,
    variables TEXT NOT NULL DEFAULT '[]',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snippets_trigger ON snippets (trigger);
