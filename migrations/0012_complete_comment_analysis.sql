SELECT pg_advisory_xact_lock(1936289380, 1);

UPDATE social_items SET raw = raw - 'replies'
WHERE platform = 'instagram' AND raw ? 'replies';

UPDATE social_items SET analysis_status = 'pending', analysis_attempts = 0,
  analysis_available_at = now(), analysis_locked_at = NULL, analysis_lock_id = NULL,
  analysis_error = NULL, review_status = 'new', analysis_revision = analysis_revision + 1,
  updated_at = now()
WHERE deleted_at IS NULL AND id IN (
  SELECT item_id FROM social_analyses WHERE prompt_version <> 'reputation-v2.5'
);

UPDATE alert_outbox SET status = 'cancelled', locked_at = NULL, lock_id = NULL,
  last_error = 'complete comment coverage migration; re-analysis required', updated_at = now()
WHERE item_id IN (
  SELECT a.item_id FROM social_analyses a JOIN social_items i ON i.id = a.item_id
  WHERE i.deleted_at IS NULL AND a.prompt_version <> 'reputation-v2.5'
) AND (status IN ('pending', 'retry', 'dead') OR (status = 'processing' AND dispatch_started_at IS NULL));

DELETE FROM social_analyses WHERE prompt_version <> 'reputation-v2.5'
  AND item_id IN (SELECT id FROM social_items WHERE deleted_at IS NULL);
