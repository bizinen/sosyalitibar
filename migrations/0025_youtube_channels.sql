ALTER TABLE watched_videos
  ADD COLUMN source_kind text NOT NULL DEFAULT 'video',
  ADD COLUMN channel_id uuid REFERENCES watched_videos(id) ON DELETE SET NULL,
  ADD COLUMN uploads_playlist_id text,
  ADD COLUMN analysis_after timestamptz,
  ADD CONSTRAINT watched_videos_source_kind_check CHECK (
    source_kind = 'video' OR (source_kind = 'channel' AND platform = 'youtube' AND provider = 'official'
      AND external_id ~ '^UC[A-Za-z0-9_-]{22}$' AND uploads_playlist_id IS NOT NULL AND analysis_after IS NOT NULL
      AND channel_id IS NULL)),
  ADD CONSTRAINT watched_videos_channel_child_check CHECK (channel_id IS NULL OR
    (source_kind = 'video' AND platform = 'youtube' AND provider = 'official' AND analysis_after IS NOT NULL AND channel_id <> id));
CREATE INDEX watched_videos_channel_idx ON watched_videos(channel_id);
ALTER TABLE social_items ADD COLUMN analysis_excluded boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT social_items_history_only_check CHECK (NOT analysis_excluded OR analysis_status = 'complete');
