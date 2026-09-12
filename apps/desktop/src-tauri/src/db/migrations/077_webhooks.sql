-- 077: Webhooks and delivery log for the local automation event pipeline.
-- Secrets reuse the api_keys encryption envelope (nonce salt + ciphertext,
-- machine-bound); a NULL secret means unsigned delivery.
CREATE TABLE IF NOT EXISTS webhooks (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    events TEXT NOT NULL DEFAULT '[]',
    secret_salt TEXT,
    secret_ciphertext TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id TEXT PRIMARY KEY,
    webhook_id TEXT NOT NULL,
    event TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    last_attempt_at INTEGER,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (webhook_id) REFERENCES webhooks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook_created
    ON webhook_deliveries (webhook_id, created_at DESC);
