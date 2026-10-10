CREATE TABLE patients (
  id text PRIMARY KEY,
  department_id text NOT NULL,
  synthetic boolean NOT NULL DEFAULT true CHECK (synthetic)
);
CREATE TABLE principals (
  id text PRIMARY KEY,
  role text NOT NULL CHECK (role IN ('patient', 'staff', 'operator')),
  patient_id text REFERENCES patients(id),
  department_id text,
  verified boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  CHECK ((role = 'patient' AND patient_id IS NOT NULL) OR (role <> 'patient' AND department_id IS NOT NULL))
);
CREATE TABLE sessions (
  id text PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  actor_id text NOT NULL REFERENCES principals(id),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE TABLE authority_grants (
  id text PRIMARY KEY,
  patient_id text NOT NULL REFERENCES patients(id),
  requester_id text NOT NULL REFERENCES principals(id),
  granted_by text NOT NULL REFERENCES principals(id),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  evidence_ref text NOT NULL,
  UNIQUE (patient_id, requester_id)
);
CREATE TABLE authority_requests (
  id text PRIMARY KEY,
  patient_id text NOT NULL,
  requester_id text NOT NULL REFERENCES principals(id),
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'denied')),
  created_at timestamptz NOT NULL,
  reviewed_by text REFERENCES principals(id),
  evidence_ref text
);
CREATE TABLE scheduler_slots (
  id text PRIMARY KEY,
  department_id text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  available boolean NOT NULL DEFAULT true,
  CHECK (ends_at > starts_at)
);
CREATE TABLE scheduler_bookings (
  id text PRIMARY KEY,
  patient_id text NOT NULL REFERENCES patients(id),
  department_id text NOT NULL,
  slot_id text NOT NULL UNIQUE REFERENCES scheduler_slots(id),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE TABLE scheduler_receipts (
  operation_key text PRIMARY KEY,
  request jsonb NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE TABLE workflow_tasks (
  task_id text PRIMARY KEY REFERENCES tasks(id),
  payload jsonb NOT NULL
);
CREATE TABLE action_requests (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES tasks(id),
  proposal_version integer NOT NULL CHECK (proposal_version > 0),
  kind text NOT NULL CHECK (kind IN ('staff_approval', 'patient_confirmation')),
  assignee_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  expires_at timestamptz NOT NULL,
  responded_by text,
  responded_at timestamptz,
  evidence_ref text,
  UNIQUE (task_id, proposal_version, kind)
);
CREATE TABLE booking_operations (
  id text PRIMARY KEY,
  operation_key text NOT NULL UNIQUE,
  task_id text NOT NULL REFERENCES tasks(id),
  proposal_version integer NOT NULL,
  status text NOT NULL CHECK (status IN ('prepared', 'dispatched', 'reconciling', 'confirmed', 'rejected', 'cancelled')),
  request jsonb NOT NULL,
  result jsonb,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (task_id, proposal_version)
);
CREATE TABLE communication_jobs (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES tasks(id),
  proposal_version integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('callback', 'reminder')),
  recipient_id text NOT NULL,
  due_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'delivered', 'cancelled', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  delivered_at timestamptz,
  UNIQUE (task_id, proposal_version, kind)
);
CREATE INDEX communication_jobs_due ON communication_jobs (due_at) WHERE status = 'pending';
CREATE INDEX booking_operations_pending ON booking_operations (updated_at) WHERE status IN ('prepared', 'dispatched', 'reconciling');
CREATE TABLE mock_deliveries (
  job_id text PRIMARY KEY REFERENCES communication_jobs(id),
  recipient_id text NOT NULL,
  delivered_at timestamptz NOT NULL,
  receipt_ref text NOT NULL UNIQUE
);
