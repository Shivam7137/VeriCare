import assert from "node:assert/strict";
import test from "node:test";
import { chanceWithin, departmentOutlook, minutesPastTold, nextStage } from "../lib/forecast";
import type { DeskPatient } from "../lib/journey";

const stage = { stage: "provider" as const, lowMinutes: 30, typicalMinutes: 60, highMinutes: 120 };
const patient = (overrides: Partial<DeskPatient> = {}): DeskPatient => ({
  id: "p1",
  name: "Test Patient",
  step: "waiting",
  ctas: 3,
  stream: "main",
  area: null,
  flags: [],
  unmapped: false,
  testsInProgress: false,
  waitingMinutes: 40,
  range: null,
  stages: [stage],
  ...overrides,
});

test("chanceWithin passes through the three quantiles and stays in 0..1", () => {
  assert.equal(chanceWithin(stage, 0), 0);
  assert.equal(chanceWithin(stage, 30), 0.1);
  assert.equal(chanceWithin(stage, 60), 0.5);
  assert.equal(chanceWithin(stage, 120), 0.9);
  assert.equal(chanceWithin(stage, 10_000), 1);
  let last = 0;
  for (let minutes = 0; minutes <= 300; minutes += 5) {
    const value = chanceWithin(stage, minutes);
    assert.ok(value >= last && value <= 1);
    last = value;
  }
});

test("the department outlook adds chances and leaves silenced visits out", () => {
  const [row] = departmentOutlook([
    patient(),
    patient({ id: "p2" }),
    patient({ id: "p3", flags: ["confidential"] }),
  ]);
  assert.equal(row!.patients, 2);
  assert.equal(row!.expected[4], 1); // 60 minutes: two patients at 50% each
});

test("minutesPastTold uses the feed clock and only counts waiting patients", () => {
  const told = { lowMinutes: 30, highMinutes: 90, toldAt: "2026-11-16T10:00:00.000Z" };
  const waiting = patient({ range: told });
  assert.equal(minutesPastTold(waiting, "2026-11-16T11:00:00.000Z"), null);
  assert.equal(minutesPastTold(waiting, "2026-11-16T12:00:00.000Z"), 30);
  assert.equal(
    minutesPastTold({ ...waiting, step: "being_seen" }, "2026-11-16T12:00:00.000Z"),
    null,
  );
});

test("nextStage picks the soonest typical milestone", () => {
  const later = {
    stage: "decision" as const,
    lowMinutes: 5,
    typicalMinutes: 200,
    highMinutes: 300,
  };
  assert.equal(nextStage({ stages: [later, stage] })?.stage, "provider");
  assert.equal(nextStage({ stages: [] }), null);
});
