-- 079: Translation history (LLM-backed, local).
-- Stores source and result so history search works without re-translating.
CREATE TABLE IF NOT EXISTS translations (
    id TEXT PRIMARY KEY,
    source_text TEXT NOT NULL,
    translated_text TEXT NOT NULL,
    source_language TEXT NOT NULL,
    target_language TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_translations_created_at ON translations (created_at DESC);
