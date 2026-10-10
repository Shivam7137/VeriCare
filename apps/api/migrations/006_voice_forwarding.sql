CREATE TABLE care_team_directory (
  id text PRIMARY KEY,
  name text NOT NULL,
  role text NOT NULL CHECK (role IN ('doctor','nurse','coordinator')),
  department_id text NOT NULL,
  department_name text NOT NULL,
  phone_number text CHECK (phone_number ~ '^\+[1-9][0-9]{7,14}$'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0)
);
INSERT INTO care_team_directory (id,name,role,department_id,department_name) VALUES
  ('synthetic-staff-001','Dr. Anika Rao','doctor','demo-department','Fictional outpatient clinic'),
  ('demo-staff-daniel-morris','Dr. Daniel Morris','doctor','demo-department','Fictional outpatient clinic'),
  ('demo-staff-elena-torres','Elena Torres','coordinator','demo-department','Fictional outpatient clinic'),
  ('demo-staff-grace-lee','Grace Lee','nurse','demo-department','Fictional outpatient clinic');
CREATE TABLE patient_care_team (
  patient_id text NOT NULL REFERENCES patients(id),
  member_id text NOT NULL REFERENCES care_team_directory(id),
  PRIMARY KEY (patient_id,member_id)
);
INSERT INTO patient_care_team (patient_id,member_id)
  SELECT id, CASE WHEN id IN ('demo-patient-jordan-brooks','demo-patient-oliver-reed',
    'demo-patient-lucas-martin','demo-patient-noah-wilson','demo-patient-ethan-park')
    THEN 'demo-staff-daniel-morris' ELSE 'synthetic-staff-001' END
  FROM patients WHERE department_id='demo-department' AND id IN (
    'synthetic-patient-001','synthetic-patient-002','demo-patient-jordan-brooks',
    'demo-patient-priya-shah','demo-patient-oliver-reed','demo-patient-amara-okafor',
    'demo-patient-lucas-martin','demo-patient-sofia-rivera','demo-patient-noah-wilson',
    'demo-patient-aisha-khan','demo-patient-ethan-park');
ALTER TABLE voice_calls DROP CONSTRAINT voice_calls_status_check;
ALTER TABLE voice_calls ADD CONSTRAINT voice_calls_status_check CHECK (status IN (
  'awaiting_verification','queued','dialing','ringing','in_progress','completed','failed',
  'cancelled','reconciling','handoff','transferring'));
CREATE TABLE voice_transfers (
  id text PRIMARY KEY,
  call_id text NOT NULL REFERENCES voice_calls(id),
  member_id text NOT NULL REFERENCES care_team_directory(id),
  patient_id text REFERENCES patients(id),
  destination_name text NOT NULL,
  destination_role text NOT NULL,
  department_id text NOT NULL,
  destination_number text,
  destination_revision integer NOT NULL,
  mode text NOT NULL CHECK (mode IN ('simulated','twilio')),
  status text NOT NULL CHECK (status IN ('prepared','dispatching','dialing','connected',
    'no-answer','busy','failed','cancelled','reconciling')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  last_error text,
  parent_sid text,
  child_sid text
);
CREATE INDEX voice_transfers_call_time ON voice_transfers (call_id,created_at);
-- One provider attempt per call, including uncertain and ended attempts. No blind redial.
CREATE UNIQUE INDEX voice_transfer_once ON voice_transfers(call_id)
  WHERE status NOT IN ('prepared','cancelled');
