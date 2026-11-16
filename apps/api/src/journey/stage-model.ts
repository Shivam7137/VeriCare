import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { STEP, localClock, type StageFeatures } from "./stage-features.js";

// The trained stage-time models: gradient-boosted quantile trees exported by
// ml/vericare_ml/train.py, evaluated here with no machine-learning dependency.
// Three models per stage give the 10th, 50th and 90th percentile of the minutes
// left; a per-stratum conformal adjustment then widens the outer two so the
// range held 80% of the time on departments the models never trained on.

export const STAGES = ["triage", "provider", "results", "decision", "bed"] as const;
export type Stage = (typeof STAGES)[number];

type Tree = { f: number[]; t: number[]; l: number[]; r: number[]; m: number[]; v: number[] };
type Packed = { base: number; trees: Tree[] };
type TargetModel = {
  quantiles: Record<"0.1" | "0.5" | "0.9", Packed>;
  conformal: { pooled: [number, number]; cells: Record<string, [number, number]> };
  static: Record<string, [number, number, number]>;
};
export type StageModel = {
  version: string;
  createdAt: string;
  features: string[];
  alpha: number;
  targets: Record<Stage, TargetModel>;
};

export type StageEstimate = {
  stage: Stage;
  /** Minutes from now, before any rounding for display. */
  lowMinutes: number;
  typicalMinutes: number;
  highMinutes: number;
};

const DEFAULT_PATH = new URL("../../models/stage-model.json.gz", import.meta.url);
let cached: StageModel | null | undefined;

/** The bundled model, or null when the file is missing so callers can fall back. */
export function loadStageModel(path: string | URL = DEFAULT_PATH): StageModel | null {
  if (path === DEFAULT_PATH && cached !== undefined) return cached;
  let model: StageModel | null = null;
  try {
    model = JSON.parse(gunzipSync(readFileSync(path)).toString("utf8")) as StageModel;
  } catch {
    model = null;
  }
  if (path === DEFAULT_PATH) cached = model;
  return model;
}

/** Model inputs in training order, at the 32-bit precision the trees were fitted on. */
export function featureVector(model: StageModel, features: StageFeatures): Float64Array {
  const vector = new Float64Array(model.features.length);
  model.features.forEach((name, index) => {
    const value = features[name];
    vector[index] = value === undefined ? NaN : Math.fround(value);
  });
  return vector;
}

export function evaluate(packed: Packed, vector: Float64Array): number {
  let total = packed.base;
  for (const tree of packed.trees) {
    let node = 0;
    while (tree.f[node]! >= 0) {
      const value = vector[tree.f[node]!]!;
      const left = Number.isNaN(value) ? tree.m[node] === 1 : value <= tree.t[node]!;
      node = left ? tree.l[node]! : tree.r[node]!;
    }
    total += tree.v[node]!;
  }
  return total;
}

/** Which milestones are still ahead for a visit in this state. */
export function stagesFor(features: StageFeatures): Stage[] {
  const open =
    features.open_lab! + features.open_xray! + features.open_ct! + features.open_other! > 0;
  switch (features.step) {
    case STEP.arrived:
      return ["triage"];
    case STEP.waiting:
      return open ? ["provider", "results", "decision"] : ["provider", "decision"];
    case STEP.beingSeen:
      return open ? ["results", "decision"] : ["decision"];
    case STEP.boarding:
      return ["bed"];
    default:
      return [];
  }
}

/** Calibration cell: triage band x time of day, plus waiting or seen for the decision outlook. */
export function stratum(stage: Stage, features: StageFeatures, minuteOfDay: number): string {
  const ctas = features.ctas!;
  const band = Number.isNaN(ctas) ? "u" : ctas <= 2 ? "12" : ctas === 3 ? "3" : "45";
  const hour = minuteOfDay / 60;
  const block = hour < 8 ? "n" : hour < 16 ? "d" : "e";
  const prefix = stage === "decision" ? (features.step === STEP.waiting ? "w|" : "s|") : "";
  return `${prefix}${band}|${block}`;
}

export function estimateStage(
  model: StageModel,
  stage: Stage,
  features: StageFeatures,
  minuteOfDay: number,
): StageEstimate {
  const target = model.targets[stage];
  const vector = featureVector(model, features);
  const q10 = evaluate(target.quantiles["0.1"], vector);
  const q50 = evaluate(target.quantiles["0.5"], vector);
  const q90 = evaluate(target.quantiles["0.9"], vector);
  const [lower, upper] =
    target.conformal.cells[stratum(stage, features, minuteOfDay)] ?? target.conformal.pooled;
  const lowMinutes = Math.max(0, q10 - lower);
  const highMinutes = Math.max(q90 + upper, lowMinutes + 1);
  return {
    stage,
    lowMinutes,
    typicalMinutes: Math.min(Math.max(q50, lowMinutes), highMinutes),
    highMinutes,
  };
}

/** Every estimate that applies to the visit right now. */
export function estimateStages(
  model: StageModel,
  features: StageFeatures,
  now: number,
  timeZone = "America/Halifax",
): StageEstimate[] {
  const { minuteOfDay } = localClock(now, timeZone);
  return stagesFor(features).map((stage) => estimateStage(model, stage, features, minuteOfDay));
}

export type DisplayRange = { lowMinutes: number; highMinutes: number };

/**
 * A range fit to read aloud: whole five minutes under an hour, quarter hours above,
 * never narrower than the rounding step. Null when it is too wide to be information.
 */
export function displayRange(estimate: StageEstimate, widestMinutes: number): DisplayRange | null {
  const step = estimate.highMinutes <= 60 ? 5 : 15;
  const lowMinutes = Math.max(0, Math.floor(estimate.lowMinutes / step) * step);
  let highMinutes = Math.ceil(estimate.highMinutes / step) * step;
  if (highMinutes - lowMinutes < 2 * step) highMinutes = lowMinutes + 2 * step;
  return highMinutes > widestMinutes ? null : { lowMinutes, highMinutes };
}
