CREATE TABLE llm_settings (
  id text PRIMARY KEY CHECK (id = 'primary'),
  base_url text NOT NULL,
  model text NOT NULL,
  api_key_encrypted text NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
