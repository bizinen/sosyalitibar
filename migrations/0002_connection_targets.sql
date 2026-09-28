CREATE TABLE IF NOT EXISTS connection_targets (
  connection_id uuid NOT NULL REFERENCES social_connections(id) ON DELETE CASCADE,
  target_id uuid NOT NULL REFERENCES monitoring_targets(id) ON DELETE CASCADE,
  relation text NOT NULL DEFAULT 'owned_profile',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS connection_targets_connection_target_uidx
  ON connection_targets(connection_id, target_id);
CREATE INDEX IF NOT EXISTS connection_targets_target_idx ON connection_targets(target_id);
CREATE INDEX IF NOT EXISTS connection_targets_connection_idx ON connection_targets(connection_id);
