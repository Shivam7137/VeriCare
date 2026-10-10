-- Signed callbacks may beat the REST acknowledgement. They are evidence only:
-- the message SID remains unset until the send operation acknowledges it.
CREATE TABLE voice_sms_status_evidence (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sms_id text NOT NULL REFERENCES voice_sms(id),
  message_sid text NOT NULL CHECK (message_sid ~ '^SM[0-9a-fA-F]{32}$'),
  status text NOT NULL CHECK (status IN ('accepted','sent','delivered','failed')),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[0-9]{4,6}$'),
  received_at timestamptz NOT NULL,
  UNIQUE(sms_id,message_sid,status)
);
CREATE INDEX voice_sms_status_evidence_order ON voice_sms_status_evidence(sms_id,id);
