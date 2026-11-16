import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import type { EdEvent, EdEventKind, VisitState } from "@prc/contracts";
import { rangeFromModel } from "../src/journey/estimate.js";
import { mayShareOutlook, type GuardianInput } from "../src/journey/guardian.js";
import { outlookSentence } from "../src/journey/messages.js";
import { ageAt, stagesFromVisits } from "../src/journey/stage-estimates.js";
import { departmentSnapshot, timelineOf, type StageVisit } from "../src/journey/stage-features.js";
import {
  displayRange,
  loadStageModel,
  stagesFor,
  type Stage,
  type StageModel,
} from "../src/journey/stage-model.js";
import { deriveVisitState } from "../src/journey/visit-state.js";

type Fixture = {
  timeZone: string;
  visits: StageVisit[];
  ticks: {
    now: string;
    rows: {
      id: string;
      features: Record<string, number | null>;
      estimates: Partial<Record<Stage, [number, number, number]>>;
    }[];
  }[];
};

const fixture = JSON.parse(
  gunzipSync(readFileSync(new URL("./fixtures/stage-fixture.json.gz", import.meta.url))).toString(
    "utf8",
  ),
) as Fixture;
const model = loadStageModel() as StageModel;

test("the bundled model loads and covers every step of a visit", () => {
  assert.ok(model, "apps/api/models/stage-model.json.gz is missing: run the ml pipeline");
  assert.deepEqual(Object.keys(model.targets).sort(), [
    "bed",
    "decision",
    "provider",
    "results",
    "triage",
  ]);
  for (const target of Object.values(model.targets)) {
    assert.deepEqual(Object.keys(target.quantiles).sort(), ["0.1", "0.5", "0.9"]);
    assert.ok(target.quantiles["0.5"].trees.length > 10);
  }
  assert.equal(loadStageModel(new URL("./fixtures/none.json.gz", import.meta.url)), null);
});

test("features rebuilt from feed events match the training code", () => {
  let compared = 0;
  for (const tick of fixture.ticks) {
    const snapshot = departmentSnapshot(fixture.visits, Date.parse(tick.now), fixture.timeZone);
    assert.equal(snapshot.byVisit.size, tick.rows.length, `open visits at ${tick.now}`);
    for (const row of tick.rows) {
      const mine = snapshot.byVisit.get(row.id);
      assert.ok(mine, `${row.id} is open at ${tick.now}`);
      for (const name of model.features) {
        const expected = row.features[name];
        const actual = mine[name]!;
        const where = `${name} for ${row.id} at ${tick.now}`;
        if (expected === null || expected === undefined) assert.ok(Number.isNaN(actual), where);
        else
          assert.ok(
            Math.abs(actual - expected) <= 1e-3 + 1e-5 * Math.abs(expected),
            `${where}: ${actual} != ${expected}`,
          );
        compared += 1;
      }
    }
  }
  assert.ok(compared > 5000, "the fixture exercises thousands of feature values");
});

test("the tree evaluator and calibration reproduce the training code's ranges", () => {
  const seen = new Set<Stage>();
  for (const tick of fixture.ticks) {
    const now = Date.parse(tick.now);
    const { estimates } = stagesFromVisits(model, fixture.visits, now, fixture.timeZone);
    for (const row of tick.rows) {
      const mine = estimates.get(row.id)!;
      assert.deepEqual(mine.map((item) => item.stage).sort(), Object.keys(row.estimates).sort());
      for (const estimate of mine) {
        const [low, mid, high] = row.estimates[estimate.stage]!;
        const near = (a: number, b: number) => Math.abs(a - b) <= 0.05 + 1e-4 * Math.abs(b);
        assert.ok(near(estimate.lowMinutes, low), `${row.id} ${estimate.stage} low`);
        assert.ok(near(estimate.typicalMinutes, mid), `${row.id} ${estimate.stage} typical`);
        assert.ok(near(estimate.highMinutes, high), `${row.id} ${estimate.stage} high`);
        assert.ok(estimate.lowMinutes <= estimate.typicalMinutes);
        assert.ok(estimate.typicalMinutes <= estimate.highMinutes);
        seen.add(estimate.stage);
      }
    }
  }
  assert.deepEqual([...seen].sort(), ["bed", "decision", "provider", "results", "triage"]);
});

// A small hand-built department, so behaviour can be checked without the fixture.
const MIN = 60_000;
const base = Date.parse("2026-11-12T15:00:00.000Z"); // Thursday 11:00 in Halifax
let serial = 0;
const event = (kind: EdEventKind, minute: number, detail: EdEvent["detail"] = {}): EdEvent => ({
  kind,
  occurredAt: new Date(base + minute * MIN).toISOString(),
  source: "hl7v2",
  sourceEventId: `s${String(++serial).padStart(5, "0")}`,
  detail,
});
const visit = (id: string, events: EdEvent[], age = 44): StageVisit => ({ id, age, events });

/** A steady department: one arrival every eight minutes, each seen after `wait` minutes. */
function department(wait: number, queue: number): StageVisit[] {
  const visits: StageVisit[] = [];
  for (let index = 0; index < 40; index += 1) {
    const arrived = -400 + index * 8;
    const events = [event("arrived", arrived), event("triaged", arrived + 6, { ctas: 3 })];
    if (arrived + 6 + wait < 0) {
      events.push(event("provider_assigned", arrived + 6 + wait));
      if (arrived + 6 + wait + 120 < 0) events.push(event("discharged", arrived + 6 + wait + 120));
    }
    visits.push(visit(`bg${index}`, events));
  }
  for (let index = 0; index < queue; index += 1)
    visits.push(
      visit(`q${index}`, [
        event("arrived", -200 + index * 3),
        event("triaged", -195 + index * 3, { ctas: 3 }),
      ]),
    );
  return visits;
}

test("a longer queue and a slower department give a later wait estimate", () => {
  const me = () => visit("me", [event("arrived", -30), event("triaged", -22, { ctas: 4 })]);
  const high = (visits: StageVisit[]) =>
    stagesFromVisits(model, [...visits, me()], base)
      .estimates.get("me")!
      .find((item) => item.stage === "provider")!.highMinutes;
  const quiet = high(department(20, 0));
  const busy = high(department(170, 25));
  assert.ok(quiet > 0);
  assert.ok(busy > quiet + 60, `busy ${busy} should be well above quiet ${quiet}`);
});

test("each step gets the estimates that apply to it, and a CT takes longer than bloodwork", () => {
  const background = department(60, 4);
  const arrived = visit("a", [event("arrived", -3)]);
  const lab = visit("lab", [
    event("arrived", -90),
    event("triaged", -80, { ctas: 3 }),
    event("provider_assigned", -20),
    event("order_placed", -10, { orderId: "L1", orderType: "lab" }),
  ]);
  const ct = visit("ct", [
    event("arrived", -90),
    event("triaged", -80, { ctas: 3 }),
    event("provider_assigned", -20),
    event("order_placed", -10, { orderId: "C1", orderType: "imaging", modality: "ct" }),
  ]);
  const boarding = visit("bed", [
    event("arrived", -400),
    event("triaged", -390, { ctas: 2 }),
    event("provider_assigned", -380),
    event("admit_decision", -120),
  ]);
  const { estimates, snapshot } = stagesFromVisits(
    model,
    [...background, arrived, lab, ct, boarding],
    base,
  );
  const stages = (id: string) => estimates.get(id)!.map((item) => item.stage);
  assert.deepEqual(stages("a"), ["triage"]);
  assert.deepEqual(stages("lab"), ["results", "decision"]);
  assert.deepEqual(stages("bed"), ["bed"]);
  assert.deepEqual(stages("q3"), ["provider", "decision"]);
  assert.deepEqual(snapshot.openOrders.get("ct"), ["C1"]);
  const results = (id: string) => estimates.get(id)!.find((item) => item.stage === "results")!;
  assert.ok(results("ct").typicalMinutes > results("lab").typicalMinutes + 15);
  assert.ok(results("lab").highMinutes < 240);
  const triage = estimates.get("a")![0]!;
  assert.ok(triage.highMinutes < 90, "triage is minutes, not hours");
  // A result that lands closes the order, and the results estimate goes away.
  lab.events = [...lab.events, event("result_available", -1, { orderId: "L1" })];
  assert.deepEqual(
    stagesFromVisits(model, [...background, lab], base)
      .estimates.get("lab")!
      .map((item) => item.stage),
    ["decision"],
  );
});

test("the timeline reads only what the feed has said so far", () => {
  const events = [
    event("arrived", 0, { stream: "rapid_assessment" }),
    event("triaged", 9, { ctas: 4 }),
    event("order_placed", 15, { orderId: "X1", orderType: "imaging", modality: "xray" }),
    event("order_placed", 16, { orderId: "E1", orderType: "other" }),
    event("order_placed", 17, { orderId: "L1", orderType: "lab" }),
    event("order_cancelled", 20, { orderId: "L1" }),
    event("provider_assigned", 70),
    event("result_available", 80, { orderId: "X1" }),
    event("discharged", 100),
  ];
  const early = timelineOf(visit("t", events), base + 30 * MIN)!;
  assert.equal(early.stream, "rapid_assessment");
  assert.equal(early.providerAt, null);
  // The cancelled bloodwork and the untyped order are not tests the model waits on.
  assert.deepEqual(
    early.orders.map((order) => [order.id, order.kind, order.resultAt]),
    [["X1", 1, null]],
  );
  const late = timelineOf(visit("t", events), base + 200 * MIN)!;
  assert.equal(late.decisionAt, base + 100 * MIN);
  assert.equal(late.endedAt, base + 100 * MIN);
  assert.equal(late.orders[0]!.resultAt, base + 80 * MIN);
  assert.equal(timelineOf(visit("t", events), base - MIN), null);
  assert.equal(ageAt("1990-04-12", Date.parse("2026-04-11T12:00:00Z")), 35);
  assert.equal(ageAt("1990-04-12", Date.parse("2026-04-12T12:00:00Z")), 36);
  assert.equal(ageAt(null, base), null);
});

test("ranges are rounded for people and withheld when too wide to mean anything", () => {
  const estimate = (lowMinutes: number, highMinutes: number) => ({
    stage: "results" as const,
    lowMinutes,
    typicalMinutes: (lowMinutes + highMinutes) / 2,
    highMinutes,
  });
  assert.deepEqual(displayRange(estimate(12.4, 47.2), 360), { lowMinutes: 10, highMinutes: 50 });
  assert.deepEqual(displayRange(estimate(38, 131), 360), { lowMinutes: 30, highMinutes: 135 });
  assert.deepEqual(displayRange(estimate(4, 6), 360), { lowMinutes: 0, highMinutes: 10 });
  assert.equal(displayRange(estimate(100, 500), 360), null);
  const basis = { ahead: 3, pacePerHour: 6, moreUrgentPerHour: 1, pointMinutes: 77.77 };
  assert.deepEqual(rangeFromModel(41, 163, basis), {
    kind: "range",
    lowMinutes: 30,
    highMinutes: 165,
    basis: { ...basis, pointMinutes: 77.8 },
  });
  assert.deepEqual(rangeFromModel(200, 400, basis), { kind: "abstain", why: "too_wide" });
  assert.equal(
    outlookSentence("results", 20, 90, "patient", false),
    "Results for the tests under way are usually back within about 1 hour 30 minutes, often sooner. Scans can take longer than blood tests.",
  );
  assert.match(outlookSentence("decision", 60, 300, "patient", true), /^Counting the wait/);
  assert.deepEqual(stagesFor({ step: 1, open_lab: 0, open_xray: 0, open_ct: 0, open_other: 0 }), [
    "provider",
    "decision",
  ]);
});

test("later-step estimates follow the Guardian: never for the sickest, a flagged visit or a bed", () => {
  const state = (events: EdEvent[]): VisitState => deriveVisitState(events);
  const seen = [
    event("arrived", 0),
    event("triaged", 5, { ctas: 3 }),
    event("provider_assigned", 50),
  ];
  const guard = (override: Partial<GuardianInput>): GuardianInput => ({
    audience: "patient",
    verified: true,
    consentScopes: null,
    state: state(seen),
    feedLastMessageAt: new Date(base + 55 * MIN),
    now: new Date(base + 56 * MIN),
    request: "estimate",
    ...override,
  });
  assert.equal(mayShareOutlook(guard({})), true);
  assert.equal(mayShareOutlook(guard({ verified: false })), false);
  const urgent = state([event("arrived", 0), event("triaged", 5, { ctas: 2 })]);
  assert.equal(mayShareOutlook(guard({ state: urgent })), false);
  const flagged = state([...seen, event("flag_set", 51, { flag: "confidential" })]);
  assert.equal(mayShareOutlook(guard({ state: flagged })), false);
  const admitted = state([...seen, event("admit_decision", 52)]);
  assert.equal(mayShareOutlook(guard({ state: admitted })), false);
  assert.equal(mayShareOutlook(guard({ state: state([...seen, event("discharged", 53)]) })), false);
  assert.equal(mayShareOutlook(guard({ feedLastMessageAt: new Date(base) })), false);
  const contact = { audience: "contact" as const };
  assert.equal(mayShareOutlook(guard({ ...contact, consentScopes: ["status"] })), false);
  assert.equal(
    mayShareOutlook(guard({ ...contact, consentScopes: ["status", "estimates"] })),
    true,
  );
});
