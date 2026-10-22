ALTER TABLE watched_videos
  ADD COLUMN provider text NOT NULL DEFAULT 'official' CHECK (provider IN ('official', 'apify')),
  ADD COLUMN results_limit integer NOT NULL DEFAULT 1000 CHECK (results_limit BETWEEN 1 AND 10000),
  ADD COLUMN poll_minutes integer NOT NULL DEFAULT 60 CHECK (poll_minutes BETWEEN 15 AND 10080),
  ADD COLUMN max_charge_cents integer NOT NULL DEFAULT 100 CHECK (max_charge_cents BETWEEN 10 AND 10000),
  ADD COLUMN source_text text,
  ADD COLUMN last_run_id text,
  ADD COLUMN last_run_count integer;
ALTER TABLE watched_videos ADD CONSTRAINT watched_videos_apify_platform_check
  CHECK (provider <> 'apify' OR platform IN ('instagram', 'facebook'));
