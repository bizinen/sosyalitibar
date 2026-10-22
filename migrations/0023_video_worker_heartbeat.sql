ALTER TABLE worker_heartbeats
  DROP CONSTRAINT worker_heartbeats_job_check,
  ADD CONSTRAINT worker_heartbeats_job_check CHECK (job IN (
    'process-events', 'process-videos', 'process-analyses', 'process-alerts',
    'reconcile', 'check-connections', 'maintenance'
  ));
