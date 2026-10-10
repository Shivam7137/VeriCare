CREATE TABLE voice_monitor_entries (
  position bigserial PRIMARY KEY,
  call_id text NOT NULL REFERENCES voice_calls(id) ON DELETE CASCADE,
  entry_id text NOT NULL,
  payload jsonb NOT NULL,
  UNIQUE (call_id, entry_id)
);
CREATE INDEX voice_monitor_call_position ON voice_monitor_entries(call_id, position);
