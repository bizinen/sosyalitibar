CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS monitoring_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  aliases jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes text,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS monitoring_targets_name_uidx ON monitoring_targets(name);
CREATE INDEX IF NOT EXISTS monitoring_targets_enabled_idx ON monitoring_targets(enabled);

CREATE TABLE IF NOT EXISTS meta_auth_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meta_user_id text NOT NULL,
  meta_user_name text,
  encrypted_user_access_token text NOT NULL,
  granted_scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  token_expires_at timestamptz,
  token_last_checked_at timestamptz,
  status text NOT NULL DEFAULT 'active',
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS meta_auth_accounts_user_uidx ON meta_auth_accounts(meta_user_id);
CREATE INDEX IF NOT EXISTS meta_auth_accounts_status_idx ON meta_auth_accounts(status);

CREATE TABLE IF NOT EXISTS social_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_account_id uuid REFERENCES meta_auth_accounts(id) ON DELETE CASCADE,
  platform text NOT NULL,
  external_account_id text NOT NULL,
  display_name text NOT NULL,
  username text,
  parent_page_id text,
  encrypted_access_token text NOT NULL,
  granted_scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  token_expires_at timestamptz,
  status text NOT NULL DEFAULT 'active',
  last_error text,
  health_checked_at timestamptz,
  webhook_subscribed boolean NOT NULL DEFAULT false,
  last_synced_at timestamptz,
  sync_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS social_connections_platform_external_uidx ON social_connections(platform, external_account_id);
CREATE INDEX IF NOT EXISTS social_connections_auth_idx ON social_connections(auth_account_id);
CREATE INDEX IF NOT EXISTS social_connections_status_idx ON social_connections(status);

CREATE TABLE IF NOT EXISTS oauth_nonces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nonce_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS oauth_nonces_hash_uidx ON oauth_nonces(nonce_hash);
CREATE INDEX IF NOT EXISTS oauth_nonces_expiry_idx ON oauth_nonces(expires_at);

CREATE TABLE IF NOT EXISTS webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL DEFAULT 'meta',
  object_type text,
  dedupe_key text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  lock_id text,
  error text,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS webhook_events_dedupe_uidx ON webhook_events(dedupe_key);
CREATE INDEX IF NOT EXISTS webhook_events_queue_idx ON webhook_events(status, available_at);
CREATE INDEX IF NOT EXISTS webhook_events_lock_idx ON webhook_events(locked_at);

CREATE TABLE IF NOT EXISTS social_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid REFERENCES social_connections(id) ON DELETE CASCADE,
  platform text NOT NULL,
  external_id text NOT NULL,
  parent_external_id text,
  root_external_id text,
  item_type text NOT NULL DEFAULT 'comment',
  author_id text,
  author_name text,
  text text NOT NULL,
  permalink text,
  source_created_at timestamptz,
  review_status text NOT NULL DEFAULT 'new',
  analysis_status text NOT NULL DEFAULT 'pending',
  analysis_attempts integer NOT NULL DEFAULT 0,
  analysis_available_at timestamptz NOT NULL DEFAULT now(),
  analysis_locked_at timestamptz,
  analysis_lock_id text,
  analysis_error text,
  raw jsonb,
  deleted_at timestamptz,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS social_items_platform_external_uidx ON social_items(platform, external_id);
CREATE INDEX IF NOT EXISTS social_items_connection_idx ON social_items(connection_id);
CREATE INDEX IF NOT EXISTS social_items_ingested_idx ON social_items(ingested_at);
CREATE INDEX IF NOT EXISTS social_items_review_idx ON social_items(review_status);
CREATE INDEX IF NOT EXISTS social_items_analysis_idx ON social_items(analysis_status);

CREATE TABLE IF NOT EXISTS social_analyses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES social_items(id) ON DELETE CASCADE,
  target_match boolean NOT NULL DEFAULT false,
  target_confidence real NOT NULL DEFAULT 0,
  matched_target text,
  sentiment text NOT NULL,
  category text NOT NULL,
  severity integer NOT NULL DEFAULT 0,
  contains_insult boolean NOT NULL DEFAULT false,
  contains_threat boolean NOT NULL DEFAULT false,
  contains_claim boolean NOT NULL DEFAULT false,
  claim_text text,
  needs_review boolean NOT NULL DEFAULT false,
  summary text NOT NULL,
  provider text NOT NULL DEFAULT 'openai-compatible',
  model text NOT NULL,
  prompt_version text NOT NULL,
  input_hash text NOT NULL,
  latency_ms integer,
  raw jsonb,
  analyzed_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS social_analyses_item_uidx ON social_analyses(item_id);
CREATE INDEX IF NOT EXISTS social_analyses_severity_idx ON social_analyses(severity);
CREATE INDEX IF NOT EXISTS social_analyses_sentiment_idx ON social_analyses(sentiment);
CREATE INDEX IF NOT EXISTS social_analyses_review_idx ON social_analyses(needs_review);


CREATE TABLE IF NOT EXISTS alert_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES social_items(id) ON DELETE CASCADE,
  dedupe_key text NOT NULL,
  rule_key text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  lock_id text,
  last_error text,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS alert_outbox_dedupe_uidx ON alert_outbox(dedupe_key);
CREATE INDEX IF NOT EXISTS alert_outbox_queue_idx ON alert_outbox(status, available_at);
CREATE INDEX IF NOT EXISTS alert_outbox_item_idx ON alert_outbox(item_id);
CREATE INDEX IF NOT EXISTS alert_outbox_created_idx ON alert_outbox(created_at);

CREATE TABLE IF NOT EXISTS auth_rate_limits (
  key_hash text PRIMARY KEY,
  attempts integer NOT NULL DEFAULT 0,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  blocked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor text NOT NULL DEFAULT 'system',
  action text NOT NULL,
  entity_type text,
  entity_id text,
  ip_hash text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS audit_logs_action_idx ON audit_logs(action);
