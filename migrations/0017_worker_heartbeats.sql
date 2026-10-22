CREATE TABLE worker_heartbeats (
  job text PRIMARY KEY CHECK (job IN ('process-events','process-analyses','process-alerts','reconcile','check-connections','maintenance')),
  last_attempt_at timestamptz NOT NULL,
  last_success_at timestamptz,
  stale_after_ms integer NOT NULL CHECK (stale_after_ms > 0),
  last_succeeded boolean NOT NULL
);
