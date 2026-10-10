CREATE TABLE proposal_drafts (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES tasks(id),
  version integer NOT NULL CHECK (version > 0),
  payload jsonb NOT NULL,
  UNIQUE (task_id, version),
  CHECK (payload ? 'id' AND payload->>'id' = id),
  CHECK (payload ? 'taskId' AND payload->>'taskId' = task_id),
  CHECK (payload ? 'version' AND payload->'version' = to_jsonb(version)),
  CHECK (payload @> '{"status":"draft"}'::jsonb)
);
