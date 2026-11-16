-- Estimates for every step of a visit, not only the wait to be seen, logged so each
-- can be scored against what happened. Every person and visit here is fictional.

CREATE TABLE ed_stage_estimates (
  id bigserial PRIMARY KEY,
  encounter_id text NOT NULL REFERENCES ed_encounters(id),
  stage text NOT NULL CHECK (stage IN ('triage', 'provider', 'results', 'decision', 'bed')),
  -- Feed time the estimate was made at.
  computed_at timestamptz NOT NULL,
  low_minutes real NOT NULL,
  typical_minutes real NOT NULL,
  high_minutes real NOT NULL CHECK (high_minutes >= low_minutes),
  model_version text NOT NULL,
  -- For 'results': the orders that were open, so the estimate is scored on those alone.
  open_orders text[] NOT NULL DEFAULT '{}',
  -- Minutes from computed_at to the milestone, filled in when it happens.
  actual_minutes real,
  -- The visit ended before the milestone (for example a walkout before being seen).
  -- actual_minutes is then how long the patient stayed: a lower bound, not the answer.
  censored boolean NOT NULL DEFAULT false
);
CREATE INDEX ed_stage_estimates_encounter ON ed_stage_estimates (encounter_id, stage, computed_at);
CREATE INDEX ed_stage_estimates_open ON ed_stage_estimates (encounter_id) WHERE actual_minutes IS NULL;
