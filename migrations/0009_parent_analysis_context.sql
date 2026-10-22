CREATE INDEX IF NOT EXISTS social_items_parent_idx ON social_items(platform, parent_external_id);

UPDATE social_items SET analysis_status = 'pending', analysis_attempts = 0,
  analysis_available_at = now(), analysis_locked_at = NULL, analysis_lock_id = NULL,
  analysis_error = NULL, analysis_revision = analysis_revision + 1, updated_at = now()
WHERE deleted_at IS NULL AND item_type = 'reply';

DELETE FROM social_analyses WHERE item_id IN (
  SELECT id FROM social_items WHERE deleted_at IS NULL AND item_type = 'reply'
);

UPDATE alert_outbox SET status = 'cancelled', locked_at = NULL, lock_id = NULL,
  last_error = 'parent context migration; re-analysis required', updated_at = now()
WHERE item_id IN (SELECT id FROM social_items WHERE deleted_at IS NULL AND item_type = 'reply')
  AND (status IN ('pending', 'retry', 'dead') OR (status = 'processing' AND dispatch_started_at IS NULL));
