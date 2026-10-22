CREATE TABLE ai_policy (
  id text PRIMARY KEY CHECK (id = 'primary'),
  settings jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE social_analyses
  ADD COLUMN triage_label text CHECK (triage_label IN ('inceleme_gerekmiyor', 'insan_incelemesi_gerekli', 'acil_inceleme')),
  ALTER COLUMN target_match DROP NOT NULL,
  ALTER COLUMN target_confidence DROP NOT NULL,
  ALTER COLUMN sentiment DROP NOT NULL,
  ALTER COLUMN category DROP NOT NULL,
  ALTER COLUMN severity DROP NOT NULL,
  ALTER COLUMN contains_insult DROP NOT NULL,
  ALTER COLUMN contains_threat DROP NOT NULL,
  ALTER COLUMN contains_claim DROP NOT NULL,
  ALTER COLUMN summary DROP NOT NULL;
ALTER TABLE social_analyses ADD CONSTRAINT social_analyses_triage_contract CHECK (
  triage_label IS NULL OR (target_match IS NULL AND target_confidence IS NULL AND matched_target IS NULL
    AND sentiment IS NULL AND category IS NULL AND severity IS NULL AND contains_insult IS NULL
    AND contains_threat IS NULL AND contains_claim IS NULL AND claim_text IS NULL AND summary IS NULL
    AND needs_review = (triage_label <> 'inceleme_gerekmiyor'))
);
CREATE INDEX social_analyses_triage_idx ON social_analyses (triage_label) WHERE triage_label IS NOT NULL;
ALTER TABLE item_translations ADD COLUMN prompt_hash text;
