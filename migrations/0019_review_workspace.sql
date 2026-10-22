CREATE TABLE item_review_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  item_id uuid NOT NULL REFERENCES social_items(id) ON DELETE CASCADE,
  analysis_revision integer NOT NULL CHECK (analysis_revision > 0),
  action text NOT NULL CHECK (action IN ('status', 'correction', 'undo')),
  previous_status text NOT NULL CHECK (previous_status IN ('new', 'reviewed', 'ignored', 'escalated')),
  review_status text NOT NULL CHECK (review_status IN ('new', 'reviewed', 'ignored', 'escalated')),
  assessment jsonb,
  source_text text NOT NULL,
  llm_snapshot jsonb,
  undo_of uuid,
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX item_review_events_item_idx ON item_review_events(item_id, sequence DESC);
CREATE TABLE item_translations (
  item_id uuid NOT NULL REFERENCES social_items(id) ON DELETE CASCADE,
  analysis_revision integer NOT NULL CHECK (analysis_revision > 0),
  target_language text NOT NULL DEFAULT 'tr' CHECK (target_language = 'tr'),
  text text NOT NULL,
  model text NOT NULL,
  lock_id uuid,
  locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX item_translations_revision_uidx ON item_translations(item_id, analysis_revision, target_language);
