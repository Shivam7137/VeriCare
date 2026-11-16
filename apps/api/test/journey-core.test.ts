import assert from "node:assert/strict";
import test from "node:test";
import type { EdEvent, EdEventKind, VisitState } from "@prc/contracts";
import {
  calibrate,
  estimateWait,
  explainChange,
  publishDecision,
  type QueuePatient,
  type QueueSnapshot,
} from "../src/journey/estimate.js";
import { decideDisclosure, type GuardianInput } from "../src/journey/guardian.js";
import { HANDOFF_REPLY, rangeSentence, statusSentence } from "../src/journey/messages.js";
import { deriveVisitState } from "../src/journey/visit-state.js";

const MIN = 60_000;
const base = Date.parse("2026-11-14T12:00:00.000Z");
let sequence = 0;
const event = (kind: EdEventKind, minute: number, detail: EdEvent["detail"] = {}): EdEvent => ({
  kind,
  occurredAt: new Date(base + minute * MIN).toISOString(),
  source: "hl7v2",
  sourceEventId: `m${String(++sequence).padStart(4, "0")}`,
  detail,
});

test("a visit moves through the steps from its events alone", () => {
  const events = [event("arrived", 0, { area: "WAITROOM" }), event("triaged", 12, { ctas: 4 })];
  assert.equal(deriveVisitState(events).step, "waiting");
  assert.equal(deriveVisitState(events).friendlyStep, 2);
  assert.equal(deriveVisitState(events).ctas, 4);

  // Bloodwork can start in the waiting room before a provider is assigned.
  events.push(event("order_placed", 20, { orderId: "o1", orderType: "lab" }));
  const waitingWithTests = deriveVisitState(events);
  assert.equal(waitingWithTests.step, "waiting");
  assert.equal(waitingWithTests.testsInProgress, true);

  events.push(event("provider_assigned", 95));
  assert.equal(deriveVisitState(events).step, "being_seen");
  assert.equal(deriveVisitState(events).friendlyStep, 4);

  events.push(event("result_available", 110, { orderId: "o1" }));
  const deciding = deriveVisitState(events);
  assert.equal(deciding.step, "deciding");
  assert.equal(deciding.resultsReady, true);

  events.push(event("discharged", 150));
  const done = deriveVisitState(events);
  assert.equal(done.step, "discharged");
  assert.equal(done.ended, true);
  assert.equal(done.friendlyStep, 5);
});

test("event order in storage does not change the derived state", () => {
  const events = [
    event("arrived", 0),
    event("triaged", 10, { ctas: 3 }),
    event("provider_assigned", 60),
  ];
  assert.deepEqual(deriveVisitState([...events].reverse()), deriveVisitState(events));
});

test("flags and unmapped messages stick, even after the visit ends", () => {
  const events = [
    event("arrived", 0),
    event("discharged", 30),
    event("flag_set", 40, { flag: "deceased" }),
    event("unmapped", 41, { trigger: "A13" }),
  ];
  const state = deriveVisitState(events);
  assert.deepEqual(state.sensitivity, ["deceased"]);
  assert.equal(state.unmapped, true);
  assert.equal(state.step, "discharged");
  const cleared = deriveVisitState([...events, event("flag_cleared", 50, { flag: "deceased" })]);
  assert.deepEqual(cleared.sensitivity, []);
});

test("admission, walkouts and cancellation end the emergency visit", () => {
  const start = [event("arrived", 0), event("triaged", 5, { ctas: 3 })];
  assert.equal(
    deriveVisitState([...start, event("admit_decision", 200)]).step,
    "admitted_waiting_bed",
  );
  assert.equal(
    deriveVisitState([...start, event("admit_decision", 200), event("moved_to_unit", 900)]).ended,
    true,
  );
  assert.equal(deriveVisitState([...start, event("left_without_being_seen", 240)]).step, "left");
  assert.equal(deriveVisitState([...start, event("cancelled", 6)]).step, "cancelled");
});

const waiting: VisitState = deriveVisitState([
  event("arrived", 0),
  event("triaged", 10, { ctas: 4 }),
]);
const now = new Date(base + 30 * MIN);
const guard = (overrides: Partial<GuardianInput> = {}): GuardianInput => ({
  audience: "contact",
  verified: true,
  consentScopes: ["status", "alerts", "estimates"],
  state: waiting,
  feedLastMessageAt: new Date(base + 28 * MIN),
  now,
  request: "estimate",
  ...overrides,
});

test("a verified, consented contact hears status and the range", () => {
  assert.deepEqual(decideDisclosure(guard()), {
    outcome: "allow",
    tier: 2,
    status: true,
    estimate: true,
  });
  assert.deepEqual(decideDisclosure(guard({ audience: "patient", consentScopes: null })), {
    outcome: "allow",
    tier: 3,
    status: true,
    estimate: true,
  });
});

test("estimates need their own consent scope and a waiting patient", () => {
  const statusOnly = decideDisclosure(guard({ consentScopes: ["status"] }));
  assert.equal(statusOnly.outcome === "allow" && statusOnly.estimate, false);
  const seen = deriveVisitState([
    event("arrived", 0),
    event("triaged", 5, { ctas: 4 }),
    event("provider_assigned", 20),
  ]);
  const beingSeen = decideDisclosure(guard({ state: seen }));
  assert.equal(beingSeen.outcome === "allow" && beingSeen.estimate, false);
});

test("an unknown caller hears the same neutral reply whether or not the patient exists", () => {
  const unverified = decideDisclosure(guard({ verified: false }));
  const noVisit = decideDisclosure(guard({ state: null }));
  const noConsent = decideDisclosure(guard({ consentScopes: null }));
  const alertsOnly = decideDisclosure(guard({ consentScopes: ["alerts"] }));
  for (const decision of [unverified, noVisit, noConsent, alertsOnly])
    assert.equal(decision.outcome, "neutral");
});

test("the Guardian fails closed", async (t) => {
  const flagged = (flag: "deceased" | "confidential" | "vip" | "security" | "critical") =>
    deriveVisitState([
      event("arrived", 0),
      event("triaged", 5, { ctas: 4 }),
      event("flag_set", 6, { flag }),
    ]);
  for (const flag of ["deceased", "confidential", "vip", "security", "critical"] as const)
    await t.test(`${flag} flag hands off`, () => {
      assert.deepEqual(decideDisclosure(guard({ state: flagged(flag) })), {
        outcome: "handoff",
        tier: 0,
        reason: "sensitive_record",
      });
      // The patient's own channel goes quiet too.
      assert.equal(
        decideDisclosure(guard({ state: flagged(flag), audience: "patient" })).outcome,
        "handoff",
      );
    });
  await t.test("an uninterpreted message hands off", () => {
    const state = deriveVisitState([event("arrived", 0), event("unmapped", 5)]);
    assert.equal(decideDisclosure(guard({ state })).outcome, "handoff");
  });
  await t.test(
    "the most urgent triage levels hand off for contacts and never get estimates",
    () => {
      for (const ctas of [1, 2] as const) {
        const state = deriveVisitState([event("arrived", 0), event("triaged", 1, { ctas })]);
        assert.equal(decideDisclosure(guard({ state })).outcome, "handoff");
        const own = decideDisclosure(guard({ state, audience: "patient" }));
        assert.equal(own.outcome === "allow" && own.estimate, false);
      }
    },
  );
  await t.test("a stale or missing feed hands off", () => {
    assert.equal(
      decideDisclosure(guard({ feedLastMessageAt: new Date(base + 14 * MIN) })).outcome,
      "handoff",
    );
    assert.equal(decideDisclosure(guard({ feedLastMessageAt: null })).outcome, "handoff");
  });
  await t.test("a cancelled registration is treated as no visit", () => {
    const state = deriveVisitState([event("arrived", 0), event("cancelled", 2)]);
    assert.equal(decideDisclosure(guard({ state })).outcome, "neutral");
  });
});

test("contact wording is third person and carries no severity words", () => {
  const sentence = statusSentence(waiting, "contact", "Maya");
  assert.equal(sentence, "Maya is waiting to be seen by the care team.");
  assert.equal(statusSentence(waiting, "patient", "Maya").startsWith("You are waiting"), true);
  for (const word of ["stable", "critical", "serious", "urgent", "fine"])
    assert.equal(sentence.toLowerCase().includes(word), false);
  assert.equal(
    rangeSentence(60, 180, "patient"),
    "You'll likely be seen within about 3 hours, possibly sooner. Sicker patients are seen first, so this can change.",
  );
  assert.equal(HANDOFF_REPLY.includes("because"), false);
});

const patient: QueuePatient = { id: "p", ctas: 4, triagedAt: base, stream: "main" };
const others = (count: number, ctas: 3 | 4 | 5, offset: number): QueuePatient[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `${ctas}-${offset}-${index}`,
    ctas,
    triagedAt: base + offset * MIN + index,
    stream: "main" as const,
  }));
const snapshot = (overrides: Partial<QueueSnapshot> = {}): QueueSnapshot => {
  const at = base + 30 * MIN;
  return {
    now: at,
    waiting: [patient, ...others(3, 3, -20), ...others(2, 4, -10), ...others(4, 4, 10)],
    // Six assessments started in the last hour: one every ten minutes.
    starts: Array.from({ length: 6 }, (_, index) => ({
      at: at - index * 10 * MIN,
      stream: "main" as const,
    })),
    arrivals: [],
    ...overrides,
  };
};

test("the estimate counts only patients who will be seen first", () => {
  const result = estimateWait(patient, snapshot());
  assert.equal(result.kind, "range");
  if (result.kind !== "range") return;
  // Three more urgent plus two same-level earlier arrivals; later arrivals do not count.
  assert.equal(result.basis.ahead, 5);
  assert.equal(result.basis.pacePerHour, 6);
  assert.equal(result.basis.pointMinutes, 60);
  assert.equal(result.lowMinutes % 15, 0);
  assert.equal(result.highMinutes % 15, 0);
  assert.equal(result.lowMinutes < 60 && result.highMinutes > 60, true);
});

test("more urgent arrivals lengthen the estimate and explain why", () => {
  const calm = estimateWait(patient, snapshot());
  const at = base + 30 * MIN;
  const surge = estimateWait(
    patient,
    snapshot({
      arrivals: [1, 2, 3].map((index) => ({
        at: at - index * MIN,
        ctas: 2 as const,
        stream: "main" as const,
      })),
    }),
  );
  assert.equal(calm.kind === "range" && surge.kind === "range", true);
  if (calm.kind !== "range" || surge.kind !== "range") return;
  assert.equal(surge.highMinutes > calm.highMinutes, true);
  assert.equal(explainChange(calm.basis, surge.basis), "more_urgent_arrivals");
  assert.equal(explainChange(null, calm.basis), "first");
});

test("the estimate abstains when it would mislead", () => {
  assert.deepEqual(estimateWait(patient, snapshot({ starts: [] })), {
    kind: "abstain",
    why: "too_little_data",
  });
  const at = base + 30 * MIN;
  const flood = Array.from({ length: 6 }, (_, index) => ({
    at: at - index * MIN,
    ctas: 2 as const,
    stream: "main" as const,
  }));
  assert.deepEqual(estimateWait(patient, snapshot({ arrivals: flood })), {
    kind: "abstain",
    why: "saturated",
  });
  assert.deepEqual(estimateWait(patient, snapshot({ waiting: [patient, ...others(40, 3, -30)] })), {
    kind: "abstain",
    why: "too_wide",
  });
  assert.deepEqual(estimateWait(patient, snapshot({ waiting: [] })), {
    kind: "abstain",
    why: "not_waiting",
  });
  // A rapid-assessment patient is not delayed by the main queue.
  const rapid = { ...patient, stream: "rapid_assessment" as const };
  assert.equal(
    estimateWait(rapid, snapshot({ waiting: [rapid, ...others(9, 3, -5)] })).kind,
    "abstain",
  );
});

test("calibration needs enough resolved waits and brackets them", () => {
  assert.equal(calibrate([{ pointMinutes: 60, actualMinutes: 60 }]), null);
  const resolved = Array.from({ length: 100 }, (_, index) => ({
    pointMinutes: 60,
    actualMinutes: 30 + index,
  }));
  const multipliers = calibrate(resolved);
  assert.ok(multipliers);
  const inside = resolved.filter(
    (item) =>
      item.actualMinutes >= multipliers.lo * item.pointMinutes &&
      item.actualMinutes <= multipliers.hi * item.pointMinutes,
  ).length;
  assert.equal(inside >= 80, true);
});

test("range updates are held back unless they matter", () => {
  const first = publishDecision(null, 120, base);
  assert.equal(first.kind, "first");
  // A small wobble is not sent.
  const wobble = publishDecision(first.next, 125, base + 10 * MIN);
  assert.equal(wobble.publish, false);
  // A large worsening goes out at once.
  assert.equal(publishDecision(first.next, 200, base + 10 * MIN).kind, "worse");
  // A moderate worsening must be seen twice.
  const once = publishDecision(first.next, 160, base + 10 * MIN);
  assert.equal(once.publish, false);
  assert.equal(publishDecision(once.next, 150, base + 20 * MIN).kind, "worse");
  // Good news is confirmed three times and not within 30 minutes of the last text.
  let state = first.next;
  for (const minute of [10, 20]) state = publishDecision(state, 30, base + minute * MIN).next;
  assert.equal(publishDecision(state, 20, base + 31 * MIN).kind, "better");
  // Passing the promised time is always said.
  assert.equal(publishDecision(first.next, 30, base + 121 * MIN).kind, "overrun");
});
