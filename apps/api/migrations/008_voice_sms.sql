-- Private provider-bound destination. Never expose the raw caller number in call views.
ALTER TABLE voice_calls ADD COLUMN caller_number text;

CREATE TABLE voice_sms (
  id text PRIMARY KEY,
  call_id text NOT NULL REFERENCES voice_calls(id),
  tool_call_id text NOT NULL,
  template text NOT NULL CHECK (template IN ('portal_link','request_status','appointment_summary')),
  appointment_id text,
  actor_id text REFERENCES principals(id),
  mode text NOT NULL CHECK (mode IN ('simulated','twilio')),
  recipient_number text,
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 1000),
  content_fingerprint text NOT NULL,
  status text NOT NULL CHECK (status IN ('prepared','dispatching','accepted','sent','delivered','failed','unknown','simulated','cancelled')),
  provider_sid text UNIQUE,
  provider_error_code text,
  last_error text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  confirmed_at timestamptz,
  UNIQUE(call_id,tool_call_id)
);
CREATE INDEX voice_sms_call_time ON voice_sms(call_id,created_at);
CREATE INDEX voice_sms_dispatching ON voice_sms(updated_at) WHERE status='dispatching';
