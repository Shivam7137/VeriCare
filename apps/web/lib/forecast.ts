import type { DeskPatient, DeskStage, StageName } from "./journey";

// Read-side helpers for the stage-time model's output. The API computes every
// number; these functions only combine the 10th / 50th / 90th percentiles it
// returns into the views staff plan with. Nothing here invents a prediction.

/** Milestones in the order a visit reaches them. */
export const stageOrder: StageName[] = ["triage", "provider", "results", "decision", "bed"];

export const stageLong: Record<StageName, string> = {
  triage: "Triaged",
  provider: "Seen by a clinician",
  results: "Test results back",
  decision: "Decision on next steps",
  bed: "Inpatient bed ready",
};

/** The milestone the patient will most likely reach first, by its typical time. */
export function nextStage(patient: Pick<DeskPatient, "stages">): DeskStage | null {
  let best: DeskStage | null = null;
  for (const stage of patient.stages) {
    if (!best || stage.typicalMinutes < best.typicalMinutes) best = stage;
  }
  return best;
}

/**
 * Probability the milestone has happened within `minutes`, read off the three
 * quantiles by straight lines between them: 0 at now, 10% at low, 50% at typical,
 * 90% at high, reaching 100% a quarter of the range past high. A planning
 * approximation of the model's distribution, not a fourth model.
 */
export function chanceWithin(stage: DeskStage, minutes: number): number {
  if (minutes <= 0) return 0;
  const low = Math.max(stage.lowMinutes, 0.5);
  const typical = Math.max(stage.typicalMinutes, low + 0.5);
  const high = Math.max(stage.highMinutes, typical + 0.5);
  const end = high + Math.max((high - low) * 0.25, 5);
  const points: [number, number][] = [
    [0, 0],
    [low, 0.1],
    [typical, 0.5],
    [high, 0.9],
    [end, 1],
  ];
  for (let index = 1; index < points.length; index++) {
    const [x1, y1] = points[index]!;
    const [x0, y0] = points[index - 1]!;
    if (minutes <= x1) return y0 + ((minutes - x0) / (x1 - x0)) * (y1 - y0);
  }
  return 1;
}

export type StageOutlook = {
  stage: StageName;
  /** Patients the model has an estimate for at this stage. */
  patients: number;
  /** Expected number reaching the milestone by each minute in `horizon`. */
  expected: number[];
};

/** Hours ahead, in 15-minute steps, used by every department outlook chart. */
export const horizon = Array.from({ length: 33 }, (_, index) => index * 15);

/** Expected milestones across the department: the sum of each patient's chance. */
export function departmentOutlook(patients: DeskPatient[]): StageOutlook[] {
  return stageOrder.flatMap((name) => {
    const stages = patients.flatMap((patient) =>
      patient.flags.length || patient.unmapped
        ? []
        : patient.stages.filter((stage) => stage.stage === name),
    );
    if (!stages.length) return [];
    return [
      {
        stage: name,
        patients: stages.length,
        expected: horizon.map((minutes) =>
          stages.reduce((sum, stage) => sum + chanceWithin(stage, minutes), 0),
        ),
      },
    ];
  });
}

/**
 * Minutes a waiting patient has gone past the longest wait they were told, or
 * null while they are still inside it. Uses the feed's clock, not the browser's.
 */
export function minutesPastTold(patient: DeskPatient, feedTime: string | undefined) {
  if (patient.step !== "waiting" || !patient.range?.toldAt || !feedTime) return null;
  const since = (Date.parse(feedTime) - Date.parse(patient.range.toldAt)) / 60_000;
  const past = Math.round(since - patient.range.highMinutes);
  return past > 0 ? past : null;
}

/** A shared scale for range bars: minutes to a 0..1 position, clamped at the end. */
export function scale(maxMinutes: number) {
  return (minutes: number) => Math.min(Math.max(minutes / maxMinutes, 0), 1);
}
