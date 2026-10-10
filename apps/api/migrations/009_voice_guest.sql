ALTER TABLE voice_calls
  ADD COLUMN authorization_requested_at timestamptz,
  ADD COLUMN department_id text;

CREATE INDEX voice_calls_guest_department_time ON voice_calls (department_id, created_at)
  WHERE actor_id IS NULL AND task_id IS NULL;
