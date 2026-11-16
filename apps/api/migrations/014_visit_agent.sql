-- VeriCare Journey: the Visit Agent's work queue and log, text messages, and family links.
-- Every person and visit here is fictional.

-- Something happened that the Visit Agent should look at. Code writes the wake together
-- with the actions the Guardian allows right now; a planner (model or rules) picks from them.
CREATE TABLE ed_agent_wakes (
  id text PRIMARY KEY,
  seq bigserial NOT NULL,
  encounter_id text NOT NULL REFERENCES ed_encounters(id),
  reason text NOT NULL CHECK (reason IN
    ('step_change', 'estimate_shift', 'check_in_due', 'inbound_message', 'contact_question')),
  -- Allowed actions with wording already written by code, plus facts the planner may see.
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  settled_at timestamptz
);
CREATE INDEX ed_agent_wakes_open ON ed_agent_wakes (seq) WHERE settled_at IS NULL;

-- One row per planning run: what woke the agent, what it proposed, what the Guardian allowed.
CREATE TABLE ed_agent_runs (
  id text PRIMARY KEY,
  seq bigserial NOT NULL,
  encounter_id text NOT NULL REFERENCES ed_encounters(id),
  wake text NOT NULL,
  planner text NOT NULL CHECK (planner IN ('model', 'rules')),
  model text,
  -- Why the rules path ran when a model was configured.
  fallback_reason text,
  context_hash text NOT NULL,
  -- [{ tool, args, verdict: 'done' | 'denied', why }]
  plan jsonb NOT NULL,
  latency_ms integer,
  created_at timestamptz NOT NULL
);
CREATE INDEX ed_agent_runs_encounter ON ed_agent_runs (encounter_id, seq);

-- Timers and counters the agent keeps per visit (last check-in question, texts sent).
ALTER TABLE ed_encounters ADD COLUMN agent jsonb NOT NULL DEFAULT '{}';
-- The patient replied YES to text updates.
ALTER TABLE ed_encounters ADD COLUMN sms_opt_in_at timestamptz;

-- A contact's private link to the family page. Only the hash is stored.
ALTER TABLE ed_contacts ADD COLUMN link_hash text UNIQUE;
-- The contact replied YES to text updates.
ALTER TABLE ed_contacts ADD COLUMN sms_opt_in_at timestamptz;

-- Text messages waiting for, or sent through, the provider. One row per attempt to deliver
-- a message that is already in ed_messages.
CREATE TABLE ed_sms (
  id text PRIMARY KEY,
  seq bigserial NOT NULL,
  encounter_id text NOT NULL REFERENCES ed_encounters(id),
  contact_id text REFERENCES ed_contacts(id),
  to_number text NOT NULL CHECK (to_number ~ '^\+[1-9][0-9]{7,14}$'),
  body text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN
    ('queued', 'simulated', 'accepted', 'sent', 'delivered', 'failed', 'blocked')),
  provider_sid text,
  last_error text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX ed_sms_queued ON ed_sms (seq) WHERE status = 'queued';

-- Inbound texts, keyed by the provider's id so a redelivered webhook is harmless.
CREATE TABLE ed_sms_inbound (
  provider_sid text PRIMARY KEY,
  from_number text NOT NULL,
  received_at timestamptz NOT NULL
);

-- A question relayed for a contact: the "picked up" note goes back to that person.
ALTER TABLE ed_staff_tasks ADD COLUMN contact_id text REFERENCES ed_contacts(id);

-- When the background timer last advanced the department clock between feed messages.
ALTER TABLE opor_feed ADD COLUMN ticked_at timestamptz;
