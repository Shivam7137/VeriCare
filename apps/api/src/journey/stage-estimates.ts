import { edEventSchema } from "@prc/contracts";
import type { Database } from "../domain.js";
import { departmentSnapshot, type DepartmentSnapshot, type StageVisit } from "./stage-features.js";
import {
  estimateStages,
  loadStageModel,
  type Stage,
  type StageEstimate,
  type StageModel,
} from "./stage-model.js";
import { widen, wideningBySite } from "./widening.js";

// Stage estimates for a whole department, and the log that scores them.
// The model runs on the feed's clock, like the wait range.

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
/** How often, in feed time, a fresh estimate is written to the log for one visit and stage. */
const LOG_EVERY_MS = 10 * MIN;

export type SiteStages = {
  model: StageModel;
  snapshot: DepartmentSnapshot;
  /** Estimates by visit id for every open visit. */
  estimates: Map<string, StageEstimate[]>;
};

/** Events for every visit that is open or ended in the last day, which the features need. */
export async function loadStageVisits(
  db: Database,
  siteId: string,
  feedNow: number,
): Promise<StageVisit[]> {
  const rows = await db.query<{
    id: string;
    dateOfBirth: string | null;
    kind: string;
    occurredAt: Date;
    source: string;
    sourceEventId: string;
    detail: unknown;
  }>(
    `SELECT c.id, c.date_of_birth::text AS "dateOfBirth", e.kind, e.occurred_at AS "occurredAt",
            e.source, e.source_event_id AS "sourceEventId", e.detail
     FROM ed_encounters c JOIN ed_events e ON e.encounter_id = c.id
     WHERE c.site = $1
       AND (NOT (c.state->>'ended')::boolean OR (c.state->>'endedAt')::timestamptz >= $2)
     ORDER BY c.id, e.seq`,
    [siteId, new Date(feedNow - DAY)],
  );
  const visits = new Map<
    string,
    { id: string; age: number | null; events: StageVisit["events"][number][] }
  >();
  for (const row of rows.rows) {
    let visit = visits.get(row.id);
    if (!visit) {
      visit = { id: row.id, age: ageAt(row.dateOfBirth, feedNow), events: [] };
      visits.set(row.id, visit);
    }
    visit.events.push(
      edEventSchema.parse({
        kind: row.kind,
        occurredAt: row.occurredAt.toISOString(),
        source: row.source,
        sourceEventId: row.sourceEventId,
        detail: row.detail,
      }),
    );
  }
  return [...visits.values()];
}

export function ageAt(dateOfBirth: string | null, now: number): number | null {
  if (!dateOfBirth) return null;
  const born = Date.parse(`${dateOfBirth}T00:00:00Z`);
  if (Number.isNaN(born)) return null;
  const today = new Date(now);
  const birth = new Date(born);
  const before =
    today.getUTCMonth() < birth.getUTCMonth() ||
    (today.getUTCMonth() === birth.getUTCMonth() && today.getUTCDate() < birth.getUTCDate());
  return Math.max(0, today.getUTCFullYear() - birth.getUTCFullYear() - (before ? 1 : 0));
}

/** Pure half: estimates for every open visit, given the department's events. */
export function stagesFromVisits(
  model: StageModel,
  visits: readonly StageVisit[],
  feedNow: number,
  timeZone?: string,
): SiteStages {
  const snapshot = departmentSnapshot(visits, feedNow, timeZone);
  const estimates = new Map<string, StageEstimate[]>();
  for (const [id, features] of snapshot.byVisit)
    estimates.set(id, estimateStages(model, features, feedNow, timeZone));
  return { model, snapshot, estimates };
}

/** Null when no model is bundled, so callers fall back to the queue formula. */
export async function siteStages(
  db: Database,
  siteId: string,
  feedNow: number,
  model: StageModel | null = loadStageModel(),
): Promise<SiteStages | null> {
  if (!model) return null;
  const stages = stagesFromVisits(model, await loadStageVisits(db, siteId, feedNow), feedNow);
  // Recent visits that kept running past the upper bound stretch the range for that step.
  const factors = await wideningBySite(db, siteId);
  if ([...factors.values()].some((factor) => factor > 1))
    for (const [id, list] of stages.estimates)
      stages.estimates.set(
        id,
        list.map((estimate) => widen(estimate, factors.get(estimate.stage) ?? 1)),
      );
  return stages;
}

/** Writes new estimates to the log and scores earlier ones whose milestone has now happened. */
export async function recordStageEstimates(db: Database, stages: SiteStages) {
  const { snapshot, estimates, model } = stages;
  const ids = [...snapshot.timelines.keys()];
  if (ids.length === 0) return;

  const pending = await db.query<{
    id: string;
    encounterId: string;
    stage: Stage;
    computedAt: Date;
    openOrders: string[];
  }>(
    `SELECT id, encounter_id AS "encounterId", stage, computed_at AS "computedAt",
            open_orders AS "openOrders"
     FROM ed_stage_estimates WHERE actual_minutes IS NULL AND encounter_id = ANY($1)`,
    [ids],
  );
  for (const row of pending.rows) {
    const line = snapshot.timelines.get(row.encounterId);
    if (!line) continue;
    let at: number | null = null;
    if (row.stage === "triage") at = line.triagedAt;
    else if (row.stage === "provider") at = line.providerAt;
    else if (row.stage === "decision") at = line.decisionAt;
    else if (row.stage === "bed") at = line.movedToUnit ? line.endedAt : null;
    else {
      // A cancelled order no longer appears on the timeline and no longer holds the estimate open.
      const tracked = line.orders.filter((order) => row.openOrders.includes(order.id));
      if (tracked.length > 0 && tracked.every((order) => order.resultAt !== null))
        at = Math.max(...tracked.map((order) => order.resultAt!));
    }
    const censored = at === null && line.endedAt !== null;
    const end = at ?? (censored ? line.endedAt : null);
    if (end === null) continue;
    await db.query(
      "UPDATE ed_stage_estimates SET actual_minutes = $2, censored = $3 WHERE id = $1",
      [row.id, Math.max(0, (end - row.computedAt.getTime()) / MIN), censored],
    );
  }

  const latest = await db.query<{ encounterId: string; stage: Stage; at: Date }>(
    `SELECT encounter_id AS "encounterId", stage, max(computed_at) AS at
     FROM ed_stage_estimates WHERE encounter_id = ANY($1) GROUP BY encounter_id, stage`,
    [ids],
  );
  const last = new Map(
    latest.rows.map((row) => [`${row.encounterId}|${row.stage}`, row.at.getTime()]),
  );
  for (const [encounterId, list] of estimates)
    for (const estimate of list) {
      const previous = last.get(`${encounterId}|${estimate.stage}`);
      if (previous !== undefined && snapshot.now - previous < LOG_EVERY_MS) continue;
      await db.query(
        `INSERT INTO ed_stage_estimates
           (encounter_id, stage, computed_at, low_minutes, typical_minutes, high_minutes,
            model_version, open_orders)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          encounterId,
          estimate.stage,
          new Date(snapshot.now),
          estimate.lowMinutes,
          estimate.typicalMinutes,
          estimate.highMinutes,
          model.version,
          estimate.stage === "results" ? (snapshot.openOrders.get(encounterId) ?? []) : [],
        ],
      );
    }
}

export type StageAccuracy = { stage: Stage; total: number; inside: number; over: number };

/**
 * How the logged ranges did, per stage. A visit that ended before its milestone counts only
 * when the patient had already stayed past the upper bound: that is a miss whatever would
 * have happened next. Otherwise the outcome is unknown and the row is left out.
 */
export async function stageAccuracy(db: Database, departmentId: string): Promise<StageAccuracy[]> {
  const result = await db.query<StageAccuracy>(
    `SELECT s.stage,
            count(*)::int AS total,
            count(*) FILTER (WHERE s.actual_minutes BETWEEN s.low_minutes AND s.high_minutes
                             AND NOT s.censored)::int AS inside,
            count(*) FILTER (WHERE s.actual_minutes > s.high_minutes)::int AS over
     FROM ed_stage_estimates s JOIN ed_encounters c ON c.id = s.encounter_id
     WHERE c.department_id = $1 AND s.actual_minutes IS NOT NULL
       AND (NOT s.censored OR s.actual_minutes > s.high_minutes)
     GROUP BY s.stage ORDER BY s.stage`,
    [departmentId],
  );
  return result.rows;
}
