CREATE TABLE youtube_settings (
  id text PRIMARY KEY CHECK (id = 'primary'),
  api_key_encrypted text NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Preserve the existing configured key without decrypting it during migration.
INSERT INTO youtube_settings (id, api_key_encrypted)
SELECT 'primary', api_key_encrypted FROM watched_videos
WHERE platform = 'youtube' AND provider = 'official' AND api_key_encrypted IS NOT NULL
ORDER BY updated_at DESC, id LIMIT 1;
