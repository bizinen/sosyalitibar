CREATE TABLE meta_settings (
  id text PRIMARY KEY CHECK (id = 'primary'),
  app_id text NOT NULL CHECK (app_id ~ '^[0-9]+$'),
  app_secret_encrypted text NOT NULL,
  verify_token_encrypted text NOT NULL,
  public_origin text NOT NULL,
  graph_version text NOT NULL CHECK (graph_version ~ '^v[0-9]+\.[0-9]+$'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
