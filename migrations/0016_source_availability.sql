ALTER TABLE social_items
  ADD COLUMN source_checked_at timestamptz,
  ADD COLUMN source_unavailable_at timestamptz;

CREATE INDEX social_items_source_check_idx ON social_items (connection_id, source_checked_at, id)
  WHERE deleted_at IS NULL;
