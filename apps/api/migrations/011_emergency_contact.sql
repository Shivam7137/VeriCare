CREATE TABLE emergency_patient_records (
  patient_id text PRIMARY KEY REFERENCES patients(id),
  date_of_birth date NOT NULL,
  contact_name text NOT NULL,
  contact_relationship text NOT NULL,
  contact_number text CHECK (contact_number IS NULL OR contact_number ~ '^\+[1-9][0-9]{7,14}$'),
  facility text NOT NULL,
  department text NOT NULL,
  area text NOT NULL,
  visitor_instructions text NOT NULL,
  location_shareable boolean NOT NULL DEFAULT true,
  synthetic boolean NOT NULL DEFAULT true CHECK (synthetic)
);

ALTER TABLE voice_sms DROP CONSTRAINT voice_sms_template_check;
ALTER TABLE voice_sms ADD CONSTRAINT voice_sms_template_check
  CHECK (template IN ('portal_link','request_status','appointment_summary','emergency_verification'));

CREATE TABLE voice_emergency_sessions (
  call_id text PRIMARY KEY REFERENCES voice_calls(id),
  patient_id text REFERENCES emergency_patient_records(patient_id),
  lookup_attempts integer NOT NULL DEFAULT 0,
  verification_failures integer NOT NULL DEFAULT 0,
  verified_until timestamptz,
  contact_fingerprint text,
  updated_at timestamptz NOT NULL
);

CREATE TABLE voice_emergency_codes (
  sms_id text PRIMARY KEY REFERENCES voice_sms(id),
  call_id text NOT NULL REFERENCES voice_calls(id),
  patient_id text NOT NULL REFERENCES emergency_patient_records(patient_id),
  code_hash text NOT NULL,
  contact_fingerprint text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  invalidated_at timestamptz,
  created_at timestamptz NOT NULL
);
CREATE INDEX voice_emergency_codes_call ON voice_emergency_codes(call_id,created_at DESC);
