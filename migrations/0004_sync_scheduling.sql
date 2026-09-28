ALTER TABLE social_connections
  ADD COLUMN IF NOT EXISTS sync_attempted_at timestamptz;

CREATE INDEX IF NOT EXISTS social_connections_sync_attempt_idx
  ON social_connections (status, sync_attempted_at ASC NULLS FIRST);
