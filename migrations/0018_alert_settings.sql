ALTER TABLE alert_outbox ADD COLUMN receiver_key text;

CREATE TABLE alert_settings (
  id text PRIMARY KEY CHECK (id = 'primary'),
  enabled boolean NOT NULL DEFAULT false,
  webhook_url text,
  secret_encrypted text,
  severity_threshold integer NOT NULL DEFAULT 75 CHECK (severity_threshold BETWEEN 0 AND 100),
  on_threat boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT enabled OR (webhook_url IS NOT NULL AND secret_encrypted IS NOT NULL))
);
