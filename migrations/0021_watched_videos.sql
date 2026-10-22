CREATE TABLE watched_videos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform text NOT NULL CHECK (platform IN ('youtube', 'facebook', 'instagram')),
  external_id text NOT NULL,
  url text NOT NULL,
  credential_connection_id uuid REFERENCES social_connections(id) ON DELETE SET NULL,
  api_key_encrypted text,
  title text,
  channel_name text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'blocked', 'removed')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  last_synced_at timestamptz,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  lock_id uuid,
  progress_encrypted text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (platform, external_id)
);
CREATE INDEX watched_videos_queue_idx ON watched_videos (available_at, id) WHERE status = 'active';
CREATE INDEX social_items_root_idx ON social_items (platform, root_external_id);
