ALTER TABLE alert_outbox ADD COLUMN IF NOT EXISTS dispatch_started_at timestamptz;
