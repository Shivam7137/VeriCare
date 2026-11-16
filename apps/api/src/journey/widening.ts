import type { Database } from "../domain.js";
import type { Stage, StageEstimate } from "./stage-model.js";

// Adaptive widening. When the most recent visits keep running past the upper bound for a
// step, the range for that step is stretched until the misses stop. It is a safety net for
// a model trained elsewhere: it can only make a range more cautious, never tighter.

const LOOK_BACK = 8;
const START_AFTER = 3;
const STEP = 0.15;
const MOST = 2;

/** `overruns` is newest first: whether each recent visit ran past its upper bound. */
export function wideningFactor(overruns: readonly boolean[]): number {
  let streak = 0;
  for (const over of overruns) {
    if (!over) break;
    streak += 1;
  }
  if (streak < START_AFTER) return 1;
  return Math.min(MOST, 1 + STEP * (streak - START_AFTER + 1));
}

/** The factor for each step at one site, from the latest scored estimate of each recent visit. */
export async function wideningBySite(db: Database, site: string): Promise<Map<string, number>> {
  const rows = await db.query<{ stage: Stage; over: boolean }>(
    `SELECT stage, over FROM (
       SELECT stage, over, row_number() OVER (PARTITION BY stage ORDER BY at DESC) AS position
       FROM (
         SELECT DISTINCT ON (s.encounter_id, s.stage)
                s.stage, s.actual_minutes > s.high_minutes AS over, s.computed_at AS at
         FROM ed_stage_estimates s JOIN ed_encounters c ON c.id = s.encounter_id
         WHERE c.site = $1 AND s.actual_minutes IS NOT NULL
           AND (NOT s.censored OR s.actual_minutes > s.high_minutes)
         ORDER BY s.encounter_id, s.stage, s.computed_at DESC) latest) ranked
     WHERE position <= $2 ORDER BY stage, position`,
    [site, LOOK_BACK],
  );
  const recent = new Map<string, boolean[]>();
  for (const row of rows.rows) recent.set(row.stage, [...(recent.get(row.stage) ?? []), row.over]);
  return new Map([...recent].map(([stage, list]) => [stage, wideningFactor(list)]));
}

/** Stretches the upper bound away from the typical value. The low and typical values stay. */
export function widen(estimate: StageEstimate, factor: number): StageEstimate {
  if (factor <= 1) return estimate;
  return {
    ...estimate,
    highMinutes:
      estimate.typicalMinutes + (estimate.highMinutes - estimate.typicalMinutes) * factor,
  };
}
