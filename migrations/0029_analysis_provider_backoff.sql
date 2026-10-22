CREATE TABLE analysis_provider_state (
  key text PRIMARY KEY CHECK (key ~ '^[a-f0-9]{64}$'),
  available_at timestamptz NOT NULL,
  last_status integer NOT NULL CHECK (last_status = 0 OR last_status BETWEEN 100 AND 599),
  updated_at timestamptz NOT NULL DEFAULT now()
);
