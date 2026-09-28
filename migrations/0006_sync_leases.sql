ALTER TABLE social_connections
  ADD COLUMN IF NOT EXISTS sync_locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS sync_lock_id text;

CREATE INDEX IF NOT EXISTS social_connections_sync_claim_idx
  ON social_connections (status, sync_attempted_at ASC NULLS FIRST, sync_locked_at);
