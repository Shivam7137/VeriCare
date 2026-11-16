-- Events saved in the same millisecond (for example a request created and verified in one
-- step) were ordered by their random id. Insertion order breaks the tie instead.
ALTER TABLE task_events ADD COLUMN seq bigserial;
