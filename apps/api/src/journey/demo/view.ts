import type { VisitState } from "@prc/contracts";
import type { Pool } from "pg";
import { siteStages } from "../stage-estimates.js";
import {
  MOVE_LABEL,
  eventPhrase,
  nextMove,
  type Arrivals,
  type Plan,
  type Staffing,
} from "./flow.js";
import type { DemoLive, DemoPatient, Row, Speed } from "./types.js";

// What the control bar shows: counts, the model's current estimates, a short feed of what
// just happened, and the patient list. Reads only; nothing here changes the department.

const MIN = 60_000;

type ModelWatch = {
  version: string | null;
  source: "model" | "formula";
  waiting: number;
  medianMinutes: number | null;
  longestMinutes: number | null;
  byVisit: Map<string, { low: number; typical: number; high: number; label: string }>;
};
type TrendPoint = { at: number; median: number; waiting: number };

/** What the view remembers between requests: a short history and a one-second cache. */
export type ViewMemory = {
  trend: TrendPoint[];
  watch: { at: number; waiting: number; value: ModelWatch } | null;
};
export const freshView = (): ViewMemory => ({ trend: [], watch: null });

const stageFor = (state: VisitState): { stage: string; label: string } | null => {
  switch (state.step) {
    case "arrived":
      return { stage: "triage", label: "to triage" };
    case "waiting":
      return { stage: "provider", label: "to be seen" };
    case "being_seen":
      return state.testsInProgress
        ? { stage: "results", label: "for results" }
        : { stage: "decision", label: "to a decision" };
    case "deciding":
      return { stage: "decision", label: "to a decision" };
    case "admitted_waiting_bed":
      return { stage: "bed", label: "for a bed" };
    default:
      return null;
  }
};

/** The trained model's estimate for every open visit, summed up for the people still waiting. */
async function watchModel(
  pool: Pool,
  site: string,
  simNow: number,
  memory: ViewMemory,
  open: readonly Row[],
): Promise<ModelWatch> {
  const waiting = open.filter((row) => row.state.step === "waiting").length;
  if (memory.watch && Date.now() - memory.watch.at < 1200 && memory.watch.waiting === waiting)
    return memory.watch.value;
  const stages = await siteStages(pool, site, simNow);
  const byVisit: ModelWatch["byVisit"] = new Map();
  const typical: number[] = [];
  const longest: number[] = [];
  for (const row of open) {
    const want = stageFor(row.state);
    const estimate = want
      ? stages?.estimates.get(row.id)?.find((item) => item.stage === want.stage)
      : undefined;
    if (want && estimate)
      byVisit.set(row.id, {
        label: want.label,
        low: Math.max(0, Math.floor(estimate.lowMinutes / 5) * 5),
        typical: Math.round(estimate.typicalMinutes / 5) * 5,
        high: Math.ceil(estimate.highMinutes / 5) * 5,
      });
    if (row.state.step !== "waiting") continue;
    if (estimate) {
      typical.push(estimate.typicalMinutes);
      longest.push(estimate.highMinutes);
    } else if (row.published) {
      // No trained model: fall back to the range the patient was told.
      typical.push((row.published.lowMinutes + row.published.highMinutes) / 2);
      longest.push(row.published.highMinutes);
    }
  }
  typical.sort((a, b) => a - b);
  const median = typical.length ? typical[Math.floor(typical.length / 2)]! : null;
  const value: ModelWatch = {
    version: stages?.model.version ?? null,
    source: stages ? "model" : "formula",
    waiting,
    medianMinutes: median === null ? null : Math.round(median),
    longestMinutes: longest.length ? Math.round(Math.max(...longest)) : null,
    byVisit,
  };
  memory.watch = { at: Date.now(), waiting, value };
  const lastPoint = memory.trend.at(-1);
  if (
    value.medianMinutes !== null &&
    (!lastPoint || simNow - lastPoint.at >= 3 * MIN || lastPoint.waiting !== waiting)
  ) {
    memory.trend.push({ at: simNow, median: value.medianMinutes, waiting });
    if (memory.trend.length > 90) memory.trend.shift();
  }
  return value;
}

const FEED_KINDS = [
  "arrived",
  "triaged",
  "provider_assigned",
  "order_placed",
  "consult_requested",
  "result_available",
  "admit_decision",
  "bed_requested",
  "moved_to_unit",
  "discharged",
  "left_without_being_seen",
];

export async function buildState(input: {
  pool: Pool;
  site: string;
  simNow: number;
  settings: {
    running: boolean;
    speed: Speed;
    arrivals: Arrivals;
    staffing: Staffing;
    skipLeft: number;
    fault: string | null;
    idleReset: DemoLive["idleReset"];
  };
  memory: ViewMemory;
  open: readonly Row[];
  focus: { patientId?: string | null; encounterId?: string | null };
  planOf: (row: Row) => Plan;
  isScripted: (visit: string) => boolean;
}): Promise<DemoLive> {
  const { pool, site, simNow, settings, memory, open, focus } = input;
  const watch = await watchModel(pool, site, simNow, memory, open);
  const finished = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ed_encounters WHERE site = $1 AND (state->>'ended')::boolean`,
    [site],
  );
  const recent = await pool.query<{
    kind: string;
    at: Date;
    detail: Record<string, unknown>;
    name: string;
    quiet: boolean;
  }>(
    `SELECT e.kind, e.occurred_at AS at, e.detail, c.display_name AS name,
            (jsonb_array_length(c.state->'sensitivity') > 0 OR (c.state->>'unmapped')::boolean) AS quiet
     FROM ed_events e JOIN ed_encounters c ON c.id = e.encounter_id
     WHERE c.site = $1 AND e.kind = ANY($2)
     ORDER BY e.seq DESC LIMIT 6`,
    [site, FEED_KINDS],
  );

  // A patient's bar never names a visit the hospital record marks private.
  const asPatient = Boolean(focus.patientId);
  const view = (row: Row): DemoPatient => {
    const scripted = input.isScripted(row.visit);
    const move = scripted ? null : nextMove(row.state, input.planOf(row), simNow);
    const mine = asPatient && row.patientId === focus.patientId;
    const quiet = row.state.sensitivity.length > 0 || row.state.unmapped;
    return {
      id: row.id,
      name: asPatient && !mine && quiet ? "Private visit" : row.name,
      step: row.state.step,
      ctas: row.state.ctas,
      waitMinutes:
        row.state.step === "waiting" && row.state.triagedAt
          ? Math.max(0, Math.round((simNow - Date.parse(row.state.triagedAt)) / MIN))
          : null,
      next: move ? MOVE_LABEL[move.act] : null,
      scripted,
      mine,
    };
  };
  const patients = open.map(view);
  const mine = patients.find((item) => item.mine);
  const asked = focus.encounterId ? patients.find((item) => item.id === focus.encounterId) : null;
  // Staff start on the visit linked to the demo patient, so "Next step" always has a target.
  const linked = open.find((row) => row.patientId !== null && !input.isScripted(row.visit));
  const chosen = asked ?? mine ?? patients.find((item) => item.id === linked?.id) ?? null;
  const found = chosen ? watch.byVisit.get(chosen.id) : undefined;
  const count = (...steps: string[]) => open.filter((row) => steps.includes(row.state.step)).length;

  return {
    active: true,
    running: settings.running,
    speed: settings.speed,
    arrivals: settings.arrivals,
    staffing: settings.staffing,
    clock: new Date(simNow).toISOString(),
    skipping: settings.skipLeft > 0 ? Math.ceil(settings.skipLeft / MIN) : null,
    fault: settings.fault,
    idleReset: settings.idleReset,
    counts: {
      inDepartment: open.length,
      arrived: count("arrived"),
      waiting: count("waiting"),
      beingSeen: count("being_seen", "deciding"),
      boarding: count("admitted_waiting_bed"),
      finished: finished.rows[0]?.n ?? 0,
    },
    model: {
      version: watch.version,
      source: watch.source,
      waiting: watch.waiting,
      medianMinutes: watch.medianMinutes,
      longestMinutes: watch.longestMinutes,
      trend: memory.trend.map((point) => ({
        at: new Date(point.at).toISOString(),
        median: point.median,
        waiting: point.waiting,
      })),
    },
    focus: chosen
      ? {
          ...chosen,
          estimate: found
            ? { label: found.label, low: found.low, typical: found.typical, high: found.high }
            : null,
        }
      : null,
    // The patient's own visit first, then the newest arrivals.
    patients: [...patients]
      .reverse()
      .sort((a, b) => Number(b.mine) - Number(a.mine))
      .slice(0, 40),
    recent: recent.rows.flatMap((row) => {
      const phrase = asPatient && row.quiet ? null : eventPhrase(row.kind, row.detail);
      return phrase
        ? [{ at: row.at.toISOString(), text: `${row.name.split(" ")[0]} ${phrase}` }]
        : [];
    }),
  };
}
