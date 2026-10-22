SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE INDEX social_items_analysis_claim_idx
  ON social_items (analysis_available_at, ingested_at, id)
  WHERE analysis_status IN ('pending', 'retry') AND NOT analysis_excluded;

CREATE INDEX webhook_events_claim_idx
  ON webhook_events (available_at, received_at, id)
  WHERE status IN ('pending', 'retry');

CREATE INDEX alert_outbox_claim_idx
  ON alert_outbox (available_at, created_at, id)
  WHERE status IN ('pending', 'retry');
