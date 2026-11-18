import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { StageName } from "./journey";

// Server-only: reads the evaluation the training pipeline wrote
// (ml/artifacts/metrics.json), so the Forecasts view quotes the model card's
// own numbers instead of copies that could drift.

type Score = {
  n: number;
  coverage: number;
  ran_over: number;
  median_width_min: number;
  mae_min: number;
};
type Metrics = {
  version: string;
  rows: Record<StageName, { train: number; calibrate: number }>;
  evaluation: Record<
    StageName,
    Record<"test_reference" | "test_unseen", { model: Score; pinball_gain_vs_table?: number }>
  > & {
    provider: { test_reference: { at_triage?: Record<string, Score | number> } };
  };
};

export type ModelCardStage = {
  stage: StageName;
  trainRows: number;
  reference: { coverage: number; ranOver: number; width: number; error: number };
  unseen: { coverage: number; ranOver: number; width: number; error: number };
  gainVsTable: number | null;
};
export type ModelCard = {
  version: string;
  stages: ModelCardStage[];
  atTriage: { model: number; rolling: number; formula: number } | null;
};

const stages: StageName[] = ["triage", "provider", "results", "decision", "bed"];
const brief = (score: Score) => ({
  coverage: score.coverage,
  ranOver: score.ran_over,
  width: Math.round(score.median_width_min),
  error: Math.round(score.mae_min),
});

export async function loadModelCard(): Promise<ModelCard | null> {
  try {
    const path = resolve(process.cwd(), "../../ml/artifacts/metrics.json");
    const metrics = JSON.parse(await readFile(path, "utf8")) as Metrics;
    const triage = metrics.evaluation.provider.test_reference.at_triage;
    const mae = (key: string) => (triage?.[key] as Score | undefined)?.mae_min;
    return {
      version: metrics.version,
      stages: stages.map((stage) => {
        const evaluation = metrics.evaluation[stage];
        return {
          stage,
          trainRows: metrics.rows[stage].train,
          reference: brief(evaluation.test_reference.model),
          unseen: brief(evaluation.test_unseen.model),
          gainVsTable: evaluation.test_reference.pinball_gain_vs_table ?? null,
        };
      }),
      atTriage:
        mae("model") && mae("rolling_average") && mae("queue_formula")
          ? {
              model: Math.round(mae("model")!),
              rolling: Math.round(mae("rolling_average")!),
              formula: Math.round(mae("queue_formula")!),
            }
          : null,
    };
  } catch {
    return null;
  }
}
