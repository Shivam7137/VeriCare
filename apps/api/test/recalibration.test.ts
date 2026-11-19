import assert from "node:assert/strict";
import test from "node:test";
import { recalibrate, recalibrationScale } from "../src/journey/recalibration.js";

const sample = (actual: number, scale = 1) => ({ actual, low: 60, typical: 120, scale });

test("ranges are left alone without enough evidence or when visits land inside them", () => {
  assert.equal(recalibrationScale([sample(30), sample(30)]), 1);
  // Ten visits, all inside or over: nothing to tighten (overruns are widening's job).
  assert.equal(recalibrationScale(Array.from({ length: 10 }, () => sample(150))), 1);
});

test("a step this department keeps reaching sooner is scaled to where visits land", () => {
  const early = Array.from({ length: 12 }, (_, index) => sample(index < 6 ? 30 : 90));
  const scale = recalibrationScale(early);
  // The median visit took 90 of the model's 120 typical minutes.
  assert.equal(scale, 0.75);
  const scaled = recalibrate(
    { stage: "decision", lowMinutes: 60, typicalMinutes: 120, highMinutes: 240 },
    scale,
  );
  assert.deepEqual(scaled, {
    stage: "decision",
    lowMinutes: 45,
    typicalMinutes: 90,
    highMinutes: 180,
  });
});

test("once on, it stays on and is worked out against the model's unscaled numbers", () => {
  // Estimates already made at ×0.5 now land inside their (scaled) ranges.
  const settled = Array.from({ length: 10 }, () => ({
    actual: 50,
    low: 30,
    typical: 60,
    scale: 0.5,
  }));
  // 50 × 0.5 / 60 would be wrong; the raw typical was 120, so the factor is 50 / 120.
  assert.equal(Number(recalibrationScale(settled).toFixed(3)), Number((50 / 120).toFixed(3)));
});

test("it never lengthens a range and never shrinks one below a third", () => {
  const tiny = Array.from({ length: 10 }, () => sample(1));
  assert.equal(recalibrationScale(tiny), 0.35);
  const est = { stage: "bed" as const, lowMinutes: 10, typicalMinutes: 20, highMinutes: 40 };
  assert.equal(recalibrate(est, 1), est);
});
