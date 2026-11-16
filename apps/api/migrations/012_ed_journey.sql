-- VeriCare Journey: one emergency visit as a stream of events from the OPOR feed.
-- Every person and visit here is fictional.

CREATE TABLE ed_encounters (
  id text PRIMARY KEY,
  site text NOT NULL,
  department_id text NOT NULL,
  visit_number text NOT NULL,
  mrn text NOT NULL,
  -- Set when the visit belongs to a patient who already has a portal identity.
  patient_id text REFERENCES patients(id),
  display_name text NOT NULL,
  date_of_birth date,
  phone text CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{7,14}$'),
  -- What the last feed message said, kept so the next one can be compared.
  facts jsonb NOT NULL,
  -- Projection of ed_events. Rebuilt from the events on every change.
  state jsonb NOT NULL,
  -- The wait range people were last told, if any.
  published jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  synthetic boolean NOT NULL DEFAULT true CHECK (synthetic),
  UNIQUE (site, visit_number)
);
CREATE INDEX ed_encounters_patient ON ed_encounters (patient_id, created_at DESC);
CREATE INDEX ed_encounters_open ON ed_encounters (site) WHERE NOT (state->>'ended')::boolean;

CREATE TABLE ed_events (
  seq bigserial PRIMARY KEY,
  encounter_id text NOT NULL REFERENCES ed_encounters(id),
  kind text NOT NULL,
  occurred_at timestamptz NOT NULL,
  source text NOT NULL CHECK (source IN ('hl7v2', 'fhir', 'staff')),
  source_event_id text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  received_at timestamptz NOT NULL,
  UNIQUE (encounter_id, source, source_event_id)
);
CREATE INDEX ed_events_kind_time ON ed_events (kind, occurred_at);

-- Raw feed messages, keyed by the sender's control id so a resend is harmless.
CREATE TABLE opor_messages (
  site text NOT NULL,
  control_id text NOT NULL,
  received_at timestamptz NOT NULL,
  outcome text NOT NULL,
  raw text NOT NULL,
  PRIMARY KEY (site, control_id)
);

CREATE TABLE opor_feed (
  site text PRIMARY KEY,
  -- Wall-clock time of the last message: drives the stale-feed check.
  last_message_at timestamptz NOT NULL,
  -- Latest event time in the feed: the clock that estimates run on.
  feed_time timestamptz NOT NULL
);

CREATE TABLE ed_contacts (
  id text PRIMARY KEY,
  encounter_id text NOT NULL REFERENCES ed_encounters(id),
  name text NOT NULL,
  relationship text NOT NULL,
  phone text NOT NULL CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  scopes text[] NOT NULL CHECK (scopes <@ ARRAY['status', 'alerts', 'estimates']),
  created_at timestamptz NOT NULL,
  withdrawn_at timestamptz
);
CREATE INDEX ed_contacts_encounter ON ed_contacts (encounter_id);

CREATE TABLE ed_estimates (
  id bigserial PRIMARY KEY,
  encounter_id text NOT NULL REFERENCES ed_encounters(id),
  computed_at timestamptz NOT NULL,
  low_minutes integer,
  high_minutes integer,
  abstain text,
  reason text,
  basis jsonb NOT NULL DEFAULT '{}',
  published boolean NOT NULL DEFAULT false,
  -- Filled in when the patient is seen: minutes from computed_at to the first provider.
  actual_minutes integer,
  CHECK ((abstain IS NULL) = (low_minutes IS NOT NULL AND high_minutes IS NOT NULL))
);
CREATE INDEX ed_estimates_encounter ON ed_estimates (encounter_id, computed_at);

-- Everything told to, or heard from, the patient and their contacts.
CREATE TABLE ed_messages (
  id text PRIMARY KEY,
  -- Insertion order: messages written in the same instant still read in order.
  seq bigserial NOT NULL,
  encounter_id text NOT NULL REFERENCES ed_encounters(id),
  audience text NOT NULL CHECK (audience IN ('patient', 'contact')),
  contact_id text REFERENCES ed_contacts(id),
  direction text NOT NULL CHECK (direction IN ('out', 'in')),
  channel text NOT NULL CHECK (channel IN ('web', 'sms', 'voice')),
  kind text NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL,
  CHECK ((audience = 'contact') = (contact_id IS NOT NULL))
);
CREATE INDEX ed_messages_encounter ON ed_messages (encounter_id, seq);

CREATE TABLE ed_staff_tasks (
  id text PRIMARY KEY,
  encounter_id text NOT NULL REFERENCES ed_encounters(id),
  kind text NOT NULL CHECK (kind IN ('recheck', 'leaving', 'question', 'interpreter', 'comfort')),
  priority integer NOT NULL CHECK (priority BETWEEN 1 AND 3),
  summary text NOT NULL,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'done', 'not_needed')),
  created_at timestamptz NOT NULL,
  closed_at timestamptz,
  closed_by text
);
CREATE INDEX ed_staff_tasks_open ON ed_staff_tasks (priority, created_at) WHERE state = 'open';

-- Tamper-evident ledger: each row's hash covers the previous row's hash.
CREATE TABLE ed_audit (
  seq bigserial PRIMARY KEY,
  at timestamptz NOT NULL,
  actor text NOT NULL,
  action text NOT NULL,
  encounter_id text,
  detail jsonb NOT NULL DEFAULT '{}',
  prev_hash text NOT NULL,
  hash text NOT NULL
);

CREATE FUNCTION ed_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append_only';
END $$;
CREATE TRIGGER ed_events_append_only BEFORE UPDATE OR DELETE ON ed_events
  FOR EACH ROW EXECUTE FUNCTION ed_append_only();
CREATE TRIGGER ed_audit_append_only BEFORE UPDATE OR DELETE ON ed_audit
  FOR EACH ROW EXECUTE FUNCTION ed_append_only();
