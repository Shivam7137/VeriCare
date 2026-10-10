import assert from "node:assert/strict";
import test from "node:test";
import { activeCallStates, filterRequests, type DesktopProgress } from "../lib/desktop";
import { date, inputDate, windowInput, type Actor, type Progress } from "../lib/ui";
import { enterWorkspace, nextStep, orderRequests } from "../lib/workspace";

const now = Date.parse("2026-10-10T12:00:00Z");
function request(
  id: string,
  state: Progress["task"]["state"],
  endsAt = "2026-10-11T12:00:00Z",
): DesktopProgress {
  return {
    task: {
      id,
      state,
      patientId: "synthetic-patient-001",
      summary: "Appointment change",
      updatedAt: "2026-10-10T10:00:00Z",
      nextAction: "technical backend text",
    },
    patient: { id: "synthetic-patient-001", displayName: "Maya Chen" },
    workflow: { callbackWindow: { startsAt: "2026-10-10T10:00:00Z", endsAt, timeZone: "UTC" } },
  } as DesktopProgress;
}
test("actionable cases precede expired, completed and future-dated starter records without mutating data", () => {
  const template = request("T001", "awaiting_verification");
  template.task.updatedAt = "2030-01-01T00:00:00Z";
  const items = [
    template,
    request("done", "completed"),
    request("expired", "awaiting_proposal", "2026-10-09T00:00:00Z"),
    request("ready", "awaiting_proposal"),
  ];
  assert.deepEqual(
    orderRequests(items, now).map((item) => item.task.id),
    ["ready", "expired", "done", "T001"],
  );
  assert.equal(items[0], template);
});
test("expired windows explain recovery while in-flight and saved bookings preserve their outcomes", () => {
  assert.match(
    nextStep(request("old", "awaiting_patient_confirmation", "2026-10-09T00:00:00Z"), true, now),
    /Set a new window/,
  );
  assert.match(
    nextStep(request("inflight", "reconciling", "2026-10-09T00:00:00Z"), true, now),
    /saved receipt/,
  );
  assert.match(
    nextStep(request("saved", "completed", "2026-10-09T00:00:00Z"), true, now),
    /saved in the demo scheduler/,
  );
});
test("queue search combines patient context and stage filters, and forwarding stays active", () => {
  const items = [request("one", "awaiting_proposal"), request("two", "completed")];
  assert.deepEqual(
    filterRequests(items, [], "maya", "open").map((item) => item.task.id),
    ["one"],
  );
  assert.equal(filterRequests(items, [], "absent", "all").length, 0);
  assert.ok(activeCallStates.has("transferring"));
  assert.ok(!activeCallStates.has("completed"));
});
test("display dates identify the year and Halifax daylight/standard time", () => {
  assert.match(date("2026-07-15T15:00:00Z"), /2026/);
  assert.match(date("2026-07-15T15:00:00Z"), /12:00.*(?:ADT|GMT-3)/);
  assert.match(date("2026-01-15T15:00:00Z"), /11:00.*(?:AST|GMT-4)/);
});
test("device-local inputs round-trip to exact ISO timestamps in summer and winter", () => {
  const original = process.env.TZ;
  try {
    for (const zone of ["America/Halifax", "UTC", "Asia/Kathmandu"]) {
      process.env.TZ = zone;
      for (const instant of ["2026-07-15T15:00:00.000Z", "2026-01-15T15:00:00.000Z"]) {
        const start = Date.parse(instant);
        const input = windowInput(inputDate(start), inputDate(start + 3_600_000));
        assert.equal(input.startsAt, instant);
        assert.equal(Date.parse(input.endsAt) - Date.parse(input.startsAt), 3_600_000);
        assert.equal(input.timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone);
      }
    }
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});
test("action workspaces upgrade an old operator cookie once while preserving patient and overview entry", async () => {
  const original = globalThis.fetch;
  const calls: { method: string; portal: string | null; body?: BodyInit | null }[] = [];
  let actor: Actor = { id: "old-operator", role: "operator" };
  try {
    globalThis.fetch = async (_input, init) => {
      calls.push({
        method: init?.method ?? "GET",
        portal: new Headers(init?.headers).get("x-prc-portal"),
        body: init?.body,
      });
      if (init?.method === "POST") {
        assert.deepEqual(JSON.parse(String(init.body)), { persona: "staff" });
        actor = { id: "staff", role: "staff" };
      }
      return Response.json(actor);
    };
    assert.equal((await enterWorkspace("professional")).role, "operator");
    assert.equal((await enterWorkspace("professional", true)).role, "staff");
    assert.equal((await enterWorkspace("professional", true)).role, "staff");
    actor = { id: "patient", role: "patient" };
    assert.equal((await enterWorkspace("patient")).role, "patient");
    assert.equal(calls.filter((call) => call.method === "POST").length, 1);
    assert.equal(calls.at(-1)?.portal, "patient");
  } finally {
    globalThis.fetch = original;
  }
});
test("failed automatic session entry remains an error and never fabricates a role", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      Response.json({ error: "demo_session_expired" }, { status: 503 });
    await assert.rejects(enterWorkspace("professional", true), /demo host/);
  } finally {
    globalThis.fetch = original;
  }
});
