CREATE TABLE voice_calls (
  id text PRIMARY KEY,
  task_id text REFERENCES tasks(id),
  actor_id text REFERENCES principals(id),
  mode text NOT NULL CHECK (mode IN ('simulated', 'twilio')),
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  status text NOT NULL CHECK (status IN ('awaiting_verification', 'queued', 'dialing', 'ringing', 'in_progress', 'completed', 'failed', 'cancelled', 'reconciling', 'handoff')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  due_at timestamptz,
  recipient_number text,
  masked_number text,
  provider_sid text UNIQUE,
  verified_at timestamptz,
  verification_failures integer NOT NULL DEFAULT 0 CHECK (verification_failures BETWEEN 0 AND 5),
  last_error text,
  pending_action jsonb,
  stream_token_hash text,
  stream_expires_at timestamptz,
  stream_claimed_at timestamptz
);
CREATE INDEX voice_calls_due ON voice_calls (due_at) WHERE status = 'queued';
CREATE INDEX voice_calls_actor_time ON voice_calls (actor_id, created_at);
CREATE UNIQUE INDEX voice_calls_active_callback ON voice_calls (task_id)
  WHERE direction = 'outbound' AND status IN ('awaiting_verification', 'queued', 'dialing', 'ringing', 'in_progress', 'reconciling');

CREATE TABLE voice_access_codes (
  id text PRIMARY KEY,
  code_hash text NOT NULL UNIQUE,
  actor_id text NOT NULL REFERENCES principals(id),
  task_id text REFERENCES tasks(id),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  consumed_call_id text REFERENCES voice_calls(id),
  CHECK (expires_at > created_at)
);
CREATE UNIQUE INDEX voice_access_codes_active_actor ON voice_access_codes (actor_id)
  WHERE revoked_at IS NULL AND consumed_call_id IS NULL;

CREATE TABLE voice_events (
  id text PRIMARY KEY,
  call_id text NOT NULL REFERENCES voice_calls(id),
  kind text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  dedupe_key text,
  occurred_at timestamptz NOT NULL,
  UNIQUE (call_id, dedupe_key)
);
CREATE INDEX voice_events_call_time ON voice_events (call_id, occurred_at);

CREATE TABLE voice_tool_results (
  call_id text NOT NULL REFERENCES voice_calls(id),
  tool_call_id text NOT NULL,
  result jsonb NOT NULL,
  PRIMARY KEY (call_id, tool_call_id)
);
