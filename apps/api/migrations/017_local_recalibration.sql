-- The local recalibration factor each logged estimate was made with (1 = the model as trained).
-- Kept so the next factor is always worked out against the model's own, unscaled numbers.
ALTER TABLE ed_stage_estimates ADD COLUMN local_scale real NOT NULL DEFAULT 1;
