import type { Database } from "../domain.js";
import type { Stage, StageEstimate } from "./stage-model.js";

// Local recalibration. The stage model was trained on another hospital's visits. When this
// department keeps reaching a step sooner than the range said (below its lower bound), every
// range for that step is scaled down so its typical value sits where visits here actually land.
// It is the mirror of widening.ts: it can only shorten a range, never lengthen it.
// Only the steps after being seen: the wait to be seen (what patients are told) and triage
// meet their target and stay as the model gives them.

const LOOK_BACK = 24;
const MIN_SAMPLES = 8;
/** Share of recent visits that came in under the range before the scaling starts. */
const EARLY_SHARE = 0.25;
/** Never trust local data so far that a range shrinks below a third of the model's. */
const FLOOR = 0.35;
export const RECALIBRATED: readonly Stage[] = ["results", "decision", "bed"];

export type RecalibrationSample = {
  actual: number;
  low: number;
  typical: number;
  /** The factor this estimate was made with. */
  scale: number;
};

/** `samples` newest first. Returns 1 (no change) or a factor below 1. */
export function recalibrationScale(samples: readonly RecalibrationSample[]): number {
  if (samples.length < MIN_SAMPLES) return 1;
  const early = samples.filter((sample) => sample.actual < sample.low).length / samples.length;
  // Once scaling is on it stays on while the evidence holds, or ranges would flip back and forth.
  const applied = (samples[0]?.scale ?? 1) < 1;
  if (early < EARLY_SHARE && !applied) return 1;
  // Each ratio compares what happened with the model's own, unscaled typical value.
  const ratios = samples
    .map((sample) => (sample.actual * sample.scale) / Math.max(1, sample.typical))
    .sort((a, b) => a - b);
  const median = ratios[Math.floor(ratios.length / 2)]!;
  return Math.min(1, Math.max(FLOOR, median));
}

/** The factor for each step at one site, from the latest scored estimate of each recent visit. */
export async function recalibrationBySite(db: Database, site: string): Promise<Map<Stage, number>> {
  const rows = await db.query<RecalibrationSample & { stage: Stage }>(
    `SELECT stage, actual, low, typical, scale FROM (
       SELECT *, row_number() OVER (PARTITION BY stage ORDER BY at DESC) AS position
       FROM (
         SELECT DISTINCT ON (s.encounter_id, s.stage)
                s.stage, s.actual_minutes AS actual, s.low_minutes AS low,
                s.typical_minutes AS typical, s.local_scale AS scale, s.computed_at AS at
         FROM ed_stage_estimates s JOIN ed_encounters c ON c.id = s.encounter_id
         WHERE c.site = $1 AND s.actual_minutes IS NOT NULL AND NOT s.censored
         ORDER BY s.encounter_id, s.stage, s.computed_at DESC) latest) ranked
     WHERE position <= $2 ORDER BY stage, position`,
    [site, LOOK_BACK],
  );
  const recent = new Map<Stage, RecalibrationSample[]>();
  for (const row of rows.rows)
    recent.set(row.stage, [
      ...(recent.get(row.stage) ?? []),
      {
        actual: Number(row.actual),
        low: Number(row.low),
        typical: Number(row.typical),
        scale: Number(row.scale),
      },
    ]);
  return new Map(
    [...recent]
      .filter(([stage]) => RECALIBRATED.includes(stage))
      .map(([stage, list]) => [stage, recalibrationScale(list)]),
  );
}

/** Scales the whole range toward zero. */
export function recalibrate(estimate: StageEstimate, scale: number): StageEstimate {
  if (scale >= 1) return estimate;
  return {
    ...estimate,
    lowMinutes: estimate.lowMinutes * scale,
    typicalMinutes: estimate.typicalMinutes * scale,
    highMinutes: estimate.highMinutes * scale,
  };
}
