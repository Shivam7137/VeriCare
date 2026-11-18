import assert from "node:assert/strict";
import test from "node:test";
import {
  arrivalsIn,
  hashSeed,
  mulberry32,
  nameFor,
  nextMove,
  nextStartAfter,
  pickCtas,
  pickNextToSee,
  planFor,
} from "../src/journey/demo/flow.js";
import { parseDemoAction } from "../src/journey/demo/routes.js";

const MIN = 60_000;
const at = (minutes: number) =>
  new Date(Date.parse("2030-01-07T12:00:00Z") + minutes * MIN).toISOString();
const state = (over: Record<string, unknown> = {}) => ({
  step: "arrived" as const,
  testsInProgress: false,
  resultsReady: false,
  consultRequested: false,
  bedRequested: false,
  arrivedAt: at(0),
  triagedAt: null,
  providerAt: null,
  lastEventAt: at(0),
  ...over,
});

test("a visit number always tells the same story, and a pinned level changes the rest", () => {
  assert.deepEqual(planFor("FIN58A0001"), planFor("FIN58A0001"));
  assert.notDeepEqual(planFor("FIN58A0001"), planFor("FIN58A0002"));
  const pinned = planFor("FIN58A0001", { ctas: 1 });
  assert.equal(pinned.ctas, 1);
  assert.equal(pinned.triageMin, 1);
});

test("triage levels follow the intended mix", () => {
  const rng = mulberry32(7);
  const seen = new Map<number, number>();
  for (let index = 0; index < 5000; index += 1) {
    const level = pickCtas(rng);
    seen.set(level, (seen.get(level) ?? 0) + 1);
  }
  const share = (level: number) => (seen.get(level) ?? 0) / 5000;
  assert.ok(share(1) < 0.05 && share(1) > 0.005);
  assert.ok(share(3) > 0.3 && share(3) < 0.46);
  assert.ok(share(4) > 0.26 && share(4) < 0.4);
});

test("a visit moves through every step in order, and each move is later than the last", () => {
  const plan = planFor("FIN58A0042", {
    ctas: 3,
    labs: true,
    imaging: "XR",
    consult: false,
    admit: false,
    raz: false,
  });
  const arrived = nextMove(state(), plan, 0);
  assert.equal(arrived?.act, "triage");
  assert.equal(arrived?.at, Date.parse(at(0)) + plan.triageMin * MIN);

  // After triage the queue, not a timer, decides.
  assert.deepEqual(nextMove(state({ step: "waiting", triagedAt: at(8) }), plan, 0), {
    act: "see",
    at: null,
  });

  const seen = state({ step: "being_seen", providerAt: at(40), lastEventAt: at(40) });
  const order = nextMove(seen, plan, 0);
  assert.equal(order?.act, "order");
  assert.equal(order?.at, Date.parse(at(40)) + plan.orderMin * MIN);

  const testing = state({
    step: "being_seen",
    testsInProgress: true,
    providerAt: at(40),
    lastEventAt: at(48),
  });
  assert.equal(nextMove(testing, plan, 0)?.act, "result");

  const deciding = state({ step: "deciding", resultsReady: true, lastEventAt: at(100) });
  assert.equal(nextMove(deciding, plan, 0)?.act, "discharge");
  assert.equal(nextMove(deciding, { ...plan, admit: true }, 0)?.act, "admit");

  const boarding = state({ step: "admitted_waiting_bed", lastEventAt: at(130) });
  assert.equal(nextMove(boarding, plan, 0)?.act, "bed");
  assert.equal(nextMove({ ...boarding, bedRequested: true }, plan, 0)?.act, "move");
  assert.equal(nextMove(state({ step: "discharged" }), plan, 0), null);
});

test("a visit that needs no tests goes straight to a decision, and a consult adds a wait", () => {
  const plain = planFor("FIN58A0007", { ctas: 5, labs: false, imaging: null, consult: false });
  const seen = state({ step: "being_seen", providerAt: at(30), lastEventAt: at(30) });
  assert.equal(nextMove(seen, plain, 0)?.act, "discharge");

  const consult = { ...plain, consult: true };
  const asked = state({
    step: "being_seen",
    consultRequested: true,
    providerAt: at(30),
    lastEventAt: at(35),
  });
  const move = nextMove(asked, consult, 0);
  assert.equal(move?.act, "discharge");
  assert.ok((move?.at ?? 0) >= Date.parse(at(35)) + 30 * MIN);
});

test("the queue sees the sickest first, then whoever has waited longest", () => {
  const picked = pickNextToSee([
    { id: "a", ctas: 4, triagedAt: 1 },
    { id: "b", ctas: 3, triagedAt: 50 },
    { id: "c", ctas: 3, triagedAt: 20 },
    { id: "d", ctas: 5, triagedAt: 0 },
  ]);
  assert.equal(picked?.id, "c");
  assert.equal(pickNextToSee([]), null);
});

test("more staff means patients start sooner", () => {
  const gaps = (staffing: "low" | "normal" | "high") => {
    const rng = mulberry32(3);
    let total = 0;
    for (let index = 0; index < 200; index += 1) total += nextStartAfter(0, "main", staffing, rng);
    return total / 200;
  };
  assert.ok(gaps("high") < gaps("normal"));
  assert.ok(gaps("normal") < gaps("low"));
});

test("walk-ins average out to the chosen rate when drawn a minute at a time", () => {
  const rng = mulberry32(11);
  let total = 0;
  const hours = 300;
  for (let minute = 0; minute < hours * 60; minute += 1) total += arrivalsIn(rng, 12, MIN);
  assert.ok(Math.abs(total / hours - 12) < 1);
  assert.equal(arrivalsIn(rng, 0, 60 * MIN), 0);
});

test("generated names do not repeat, and seeds are stable", () => {
  const seen = new Set<string>();
  for (let index = 0; index < 1300; index += 1) {
    const name = nameFor(index);
    seen.add(`${name.given} ${name.family}`);
  }
  assert.equal(seen.size, 1300);
  assert.equal(hashSeed("FIN5500001"), hashSeed("FIN5500001"));
});

test("the control bar only accepts actions it understands", () => {
  assert.deepEqual(parseDemoAction({ type: "speed", value: 60 }), { type: "speed", value: 60 });
  assert.deepEqual(parseDemoAction({ type: "add", count: 5 }), { type: "add", count: 5 });
  assert.deepEqual(parseDemoAction({ type: "add", count: 2, ctas: 2 }), {
    type: "add",
    count: 2,
    ctas: 2,
  });
  assert.deepEqual(parseDemoAction({ type: "skip", minutes: 60 }), { type: "skip", minutes: 60 });
  assert.deepEqual(parseDemoAction({ type: "keep" }), { type: "keep" });
  for (const bad of [
    null,
    {},
    { type: "explode" },
    { type: "speed", value: 7 },
    { type: "skip", minutes: 0 },
    { type: "skip", minutes: 9999 },
    { type: "add", count: 0 },
    { type: "add", count: 11 },
    { type: "add", count: 1, ctas: 9 },
    { type: "next", patientId: "not-a-uuid" },
    { type: "arrivals", value: "tsunami" },
    { type: "staffing", value: "everyone" },
  ])
    assert.throws(() => parseDemoAction(bad), { code: "invalid_input" });
});
