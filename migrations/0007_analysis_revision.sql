ALTER TABLE social_items ADD COLUMN IF NOT EXISTS analysis_revision integer NOT NULL DEFAULT 1;
ALTER TABLE alert_outbox ADD COLUMN IF NOT EXISTS analysis_revision integer NOT NULL DEFAULT 0;

-- Legacy pending decisions have no source revision and must be regenerated.
UPDATE social_items SET analysis_status = 'pending', analysis_attempts = 0,
  analysis_available_at = now(), analysis_locked_at = NULL, analysis_lock_id = NULL,
  analysis_error = NULL, analysis_revision = analysis_revision + 1
WHERE deleted_at IS NULL;
DELETE FROM social_analyses;
UPDATE alert_outbox SET status = 'cancelled', locked_at = NULL, lock_id = NULL,
  last_error = 'source revision migration; re-analysis required', updated_at = now()
WHERE status <> 'delivered';
