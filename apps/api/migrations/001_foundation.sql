CREATE TABLE tasks (
  id text PRIMARY KEY,
  payload jsonb NOT NULL CHECK (payload @> '{"synthetic":true}'::jsonb),
  CHECK (payload ? 'id' AND payload->>'id' = id)
);

CREATE TABLE task_events (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES tasks(id),
  actor_id text NOT NULL,
  action text NOT NULL,
  occurred_at timestamptz NOT NULL,
  evidence_ref text NOT NULL
);

CREATE INDEX task_events_task_time ON task_events (task_id, occurred_at);
