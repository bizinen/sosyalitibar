CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Fast admin full-text-ish substring search without introducing a separate search service.
CREATE INDEX IF NOT EXISTS social_items_text_trgm_idx
  ON social_items USING gin (text gin_trgm_ops);

-- Stable review ordering / reconciliation lookups.
CREATE INDEX IF NOT EXISTS social_items_ingested_id_idx
  ON social_items (ingested_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS social_items_connection_source_created_idx
  ON social_items (connection_id, source_created_at DESC);

-- Queue workers filter by status + available_at and then claim rows.
CREATE INDEX IF NOT EXISTS social_items_analysis_queue_idx
  ON social_items (analysis_status, analysis_available_at, ingested_at);
CREATE INDEX IF NOT EXISTS webhook_events_queue_received_idx
  ON webhook_events (status, available_at, received_at);
CREATE INDEX IF NOT EXISTS alert_outbox_queue_created_idx
  ON alert_outbox (status, available_at, created_at);

-- Common reputation-review filters.
CREATE INDEX IF NOT EXISTS social_analyses_sentiment_severity_idx
  ON social_analyses (sentiment, severity DESC);
CREATE INDEX IF NOT EXISTS social_analyses_category_severity_idx
  ON social_analyses (category, severity DESC);
