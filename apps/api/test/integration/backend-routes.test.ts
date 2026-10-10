import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { type TestContext } from "node:test";
import Fastify, { type InjectOptions } from "fastify";
import type { Pool } from "pg";
import { registerBackendRoutes } from "../../src/backend-routes.js";
import { dispatchDueJobs } from "../../src/delivery.js";
import { createSession } from "../../src/identity.js";
import { seedIdentity } from "../../src/identity-fixtures.js";
import { migrate } from "../../src/migrations.js";
import { seedScheduler } from "../../src/scheduler-fixtures.js";
import { MockScheduler } from "../../src/scheduler.js";
import { isolatedDatabase } from "./database.js";

const ids = {
  patient: "synthetic-patient-001",
  representative: "synthetic-representative-001",
  staff: "synthetic-staff-001",
  operator: "synthetic-operator-001",
  otherStaff: "synthetic-staff-other",
} as const;

async function fixture(t: TestContext) {
  const database = await isolatedDatabase(t);
  const pool = database.open();
  await migrate(pool);
  await seedIdentity(pool);
  let clock = new Date("2030-01-07T12:00:00.000Z");
  await seedScheduler(pool, clock);
  const sessions = new Map<string, Awaited<ReturnType<typeof createSession>>>();
  for (const [name, id] of Object.entries(ids)) {
    sessions.set(
      name,
      await createSession(pool, id, new Date(clock.getTime() + 86_400_000), clock),
    );
  }
  const scheduler = new MockScheduler(pool, { now: () => clock });
  const app = Fastify({ logger: false });
  app.get("/public-health", async () => ({ status: "ok" }));
  registerBackendRoutes(app, pool, { now: () => clock, scheduler });
  t.after(() => app.close());
  const slot = (await scheduler.getSlot("synthetic-slot-002"))!;
  const input = {
    patientId: ids.patient,
    appointmentId: "synthetic-appointment-001",
    summary: "Move the fictional appointment.",
    availability: {
      startsAt: slot.startsAt,
      endsAt: new Date(Date.parse(slot.endsAt) + 3_600_000).toISOString(),
      timeZone: "America/Halifax",
    },
    callbackWindow: {
      startsAt: new Date(clock.getTime() - 60_000).toISOString(),
      endsAt: new Date(clock.getTime() + 3_600_000).toISOString(),
      timeZone: "America/Halifax",
    },
  };
  const inject = (name: keyof typeof ids, url: string, options: Omit<InjectOptions, "url"> = {}) =>
    app.inject({
      ...options,
      url,
      headers: { ...options.headers, authorization: `Bearer ${sessions.get(name)!.token}` },
    });
  const post = (name: keyof typeof ids, url: string, payload: object) =>
    inject(name, url, { method: "POST", payload });
  const create = async () => {
    const response = await post("patient", "/tasks", input);
    assert.equal(response.statusCode, 201);
    return response.json();
  };
  const proposed = async () => {
    let task = await create();
    let response = await post("patient", `/tasks/${task.id}/verify`, {
      expectedRevision: task.revision,
    });
    assert.equal(response.statusCode, 200);
    task = response.json();
    response = await post("staff", `/tasks/${task.id}/proposals`, {
      expectedRevision: task.revision,
      slotId: slot.id,
      expiresAt: new Date(clock.getTime() + 7_200_000).toISOString(),
    });
    assert.equal(response.statusCode, 200);
    return response.json();
  };
  return {
    app,
    pool,
    sessions,
    input,
    scheduler,
    inject,
    post,
    create,
    proposed,
    now: () => clock,
    setNow(value: Date) {
      clock = value;
    },
  };
}

test("all backend routes authenticate while public routes remain public; sessions revoke and expire", async (t) => {
  const f = await fixture(t);
  const paths = [
    "/me",
    "/tasks",
    "/tasks/missing",
    "/tasks/missing/events",
    "/tasks/missing/proposals",
    "/slots?patientId=missing",
    "/bookings/missing",
    "/authority-requests",
    "/operator/queue",
  ];
  for (const url of paths) {
    const response = await f.app.inject(url);
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json(), { error: "unauthorized" });
  }
  for (const url of [
    "/tasks",
    "/tasks/missing/verify",
    "/tasks/missing/proposals",
    "/tasks/missing/staff-approval",
    "/tasks/missing/confirmation",
    "/tasks/missing/callback",
    "/tasks/missing/withdraw",
    "/tasks/missing/takeover",
    "/tasks/missing/execute",
    "/authority-requests",
    "/authority-requests/missing/review",
    "/authority-grants",
    "/agent/tools",
    "/agent/interpret",
  ]) {
    assert.equal((await f.app.inject({ method: "POST", url, payload: {} })).statusCode, 401);
  }
  assert.equal(
    (await f.app.inject({ method: "DELETE", url: "/patients/missing/authority/missing" }))
      .statusCode,
    401,
  );
  assert.equal((await f.app.inject("/public-health")).statusCode, 200);
  assert.equal(
    (
      await f.app.inject({
        url: "/me",
        headers: { authorization: `Bearer ${randomBytes(32).toString("base64url")}` },
      })
    ).statusCode,
    401,
  );
  assert.equal((await f.inject("patient", "/me")).json().id, ids.patient);
  await f.pool.query("UPDATE sessions SET revoked_at=$2 WHERE id=$1", [
    f.sessions.get("patient")!.sessionId,
    f.now(),
  ]);
  assert.equal((await f.inject("patient", "/me")).statusCode, 401);
  f.setNow(new Date(f.now().getTime() + 86_400_000));
  assert.equal((await f.inject("staff", "/me")).statusCode, 401);
  assert.equal(
    (await f.app.inject({ method: "POST", url: "/login", payload: { role: "staff" } })).statusCode,
    404,
  );
});

test("strict payloads reject privilege and completion fields and malformed JSON uses safe errors", async (t) => {
  const f = await fixture(t);
  for (const extra of [
    { role: "staff" },
    { actorId: ids.staff },
    { requesterId: ids.staff },
    { state: "completed" },
    { confirmationRef: "invented" },
  ]) {
    const response = await f.post("patient", "/tasks", { ...f.input, ...extra });
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json(), { error: "invalid_input" });
  }
  assert.equal((await f.pool.query("SELECT id FROM tasks")).rowCount, 0);
  const response = await f.inject("patient", "/tasks", {
    method: "POST",
    payload: "{",
    headers: { "content-type": "application/json" },
  });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), { error: "invalid_input" });
  const task = await f.create();
  assert.equal(
    (await f.post("patient", `/tasks/${task.id}/verify`, { expectedRevision: 0, role: "staff" }))
      .statusCode,
    400,
  );
  assert.equal(
    (
      await f.post("staff", `/tasks/${task.id}/execute`, {
        expectedRevision: 0,
        state: "completed",
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (await f.inject("patient", "/slots?patientId=synthetic-patient-001&role=staff")).statusCode,
    400,
  );
});

test("patient, representative and cross-department reads never leak inaccessible task or booking records", async (t) => {
  const f = await fixture(t);
  const task = await f.create();
  for (const name of ["representative", "otherStaff"] as const) {
    for (const url of [
      `/tasks/${task.id}`,
      `/tasks/${task.id}/events`,
      `/tasks/${task.id}/proposals`,
      `/slots?patientId=${ids.patient}`,
      "/bookings/synthetic-appointment-001",
    ]) {
      const response = await f.inject(name, url);
      assert.equal(response.statusCode, 404);
      assert.deepEqual(response.json(), { error: "not_found" });
    }
    assert.deepEqual((await f.inject(name, "/tasks")).json(), { tasks: [] });
  }
  for (const patientId of ["unknown-patient", "synthetic-patient-other"]) {
    const response = await f.post("patient", "/tasks", { ...f.input, patientId });
    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), { error: "not_found" });
  }
  assert.equal((await f.inject("patient", "/bookings/synthetic-appointment-002")).statusCode, 404);
  assert.equal(
    (await f.inject("patient", "/bookings/synthetic-appointment-001")).json().patientId,
    ids.patient,
  );
  assert.ok((await f.inject("patient", `/slots?patientId=${ids.patient}`)).json().slots.length > 0);
  assert.equal((await f.inject("operator", `/tasks/${task.id}`)).statusCode, 200);
  assert.equal((await f.inject("patient", "/operator/queue")).statusCode, 403);
});

test("HTTP journey requires exact decisions, delivered callback and a single durable booking result", async (t) => {
  const f = await fixture(t);
  let task = await f.proposed();
  const decision = (revision: number, version = 1) => ({
    expectedRevision: revision,
    proposalVersion: version,
    response: "approve",
    evidenceRef: "test:http-decision",
  });
  assert.equal(
    (await f.post("staff", `/tasks/${task.id}/staff-approval`, decision(task.revision, 2))).json()
      .error,
    "proposal_version_conflict",
  );
  assert.equal(
    (await f.post("staff", `/tasks/${task.id}/staff-approval`, decision(task.revision - 1))).json()
      .error,
    "revision_conflict",
  );
  assert.equal(
    (await f.post("operator", `/tasks/${task.id}/staff-approval`, decision(task.revision)))
      .statusCode,
    404,
  );
  assert.equal(
    (await f.post("operator", `/tasks/${task.id}/execute`, { expectedRevision: task.revision }))
      .statusCode,
    404,
  );
  let response = await f.post("staff", `/tasks/${task.id}/staff-approval`, decision(task.revision));
  assert.equal(response.statusCode, 200);
  task = response.json();
  response = await f.post("patient", `/tasks/${task.id}/confirmation`, decision(task.revision));
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error, "callback_required");
  assert.equal((await dispatchDueJobs(f.pool, { now: f.now() })).delivered, 1);
  task = (await f.inject("patient", `/tasks/${task.id}`)).json().task;
  response = await f.post("patient", `/tasks/${task.id}/confirmation`, decision(task.revision));
  assert.equal(response.statusCode, 200);
  task = response.json();
  assert.equal(task.state, "ready_to_execute");
  assert.equal(
    (await f.post("patient", `/tasks/${task.id}/execute`, { expectedRevision: task.revision }))
      .statusCode,
    404,
  );
  assert.equal(
    (
      await f.post("staff", `/tasks/${task.id}/execute`, { expectedRevision: task.revision - 1 })
    ).json().error,
    "revision_conflict",
  );
  response = await f.post("staff", `/tasks/${task.id}/execute`, {
    expectedRevision: task.revision,
  });
  assert.equal(response.statusCode, 200);
  const progress = response.json();
  assert.equal(progress.task.state, "completed");
  assert.equal(progress.operation.status, "confirmed");
  assert.ok(progress.operation.result.confirmationRef);
  assert.ok(
    progress.events.some((event: { action: string }) => event.action === "booking_confirmed"),
  );
  assert.equal(progress.jobs[0].status, "delivered");
  assert.equal(progress.proposals.length, 1);
  assert.equal(progress.actions.length, 2);
  assert.equal(
    (await f.post("staff", `/tasks/${task.id}/execute`, { expectedRevision: task.revision }))
      .statusCode,
    200,
  );
  assert.equal((await f.scheduler.getBooking(f.input.appointmentId))?.version, "2");
  assert.equal((await f.pool.query("SELECT id FROM booking_operations")).rowCount, 1);
  assert.equal(
    (await f.inject("patient", `/tasks/${task.id}/proposals`)).json().proposals.length,
    1,
  );
  assert.ok((await f.inject("patient", `/tasks/${task.id}/events`)).json().events.length > 1);
});

test("authority requests disclose no appointments and consent/revocation governs representative tools immediately", async (t) => {
  const f = await fixture(t);
  const task = await f.create();
  const request = await f.post("representative", "/authority-requests", { patientId: ids.patient });
  assert.equal(request.statusCode, 201);
  assert.equal(request.json().status, "pending");
  assert.equal("appointmentId" in request.json(), false);
  assert.equal(
    (await f.post("representative", "/authority-requests", { patientId: "unknown-patient" }))
      .statusCode,
    201,
  );
  assert.equal((await f.inject("representative", `/tasks/${task.id}`)).statusCode, 404);
  assert.equal((await f.inject("patient", "/authority-requests")).json().requests.length, 1);
  const review = {
    approved: true,
    expiresAt: new Date(f.now().getTime() + 7_200_000).toISOString(),
    evidenceRef: "test:explicit-consent",
  };
  assert.equal(
    (await f.post("operator", `/authority-requests/${request.json().id}/review`, review))
      .statusCode,
    404,
  );
  assert.equal(
    (await f.post("patient", `/authority-requests/${request.json().id}/review`, review)).statusCode,
    200,
  );
  assert.equal(
    (await f.post("representative", "/agent/tools", { tool: "progress", taskId: task.id }))
      .statusCode,
    200,
  );
  assert.equal(
    (
      await f.inject("patient", `/patients/${ids.patient}/authority/${ids.representative}`, {
        method: "DELETE",
      })
    ).statusCode,
    204,
  );
  assert.equal(
    (await f.post("representative", "/agent/tools", { tool: "progress", taskId: task.id }))
      .statusCode,
    404,
  );
  assert.equal(
    (
      await f.post("staff", "/authority-grants", {
        patientId: ids.patient,
        requesterId: ids.representative,
        expiresAt: review.expiresAt,
        evidenceRef: review.evidenceRef,
      })
    ).statusCode,
    201,
  );
  assert.equal((await f.inject("representative", `/tasks/${task.id}`)).statusCode, 200);
});

test("agent actions retain actor permissions and call-ended audit never completes a task", async (t) => {
  const f = await fixture(t);
  let task = await f.proposed();
  for (const tool of ["execute", "staff_approval", "complete"]) {
    const response = await f.post("patient", "/agent/tools", { tool, taskId: task.id });
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json(), { error: "invalid_input" });
  }
  assert.equal(
    (
      await f.post("representative", "/agent/tools", {
        tool: "call_ended",
        taskId: task.id,
        evidenceRef: "test:ended",
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await f.post("staff", "/agent/tools", {
        tool: "call_ended",
        taskId: task.id,
        evidenceRef: "test:ended",
      })
    ).statusCode,
    403,
  );
  const ended = await f.post("patient", "/agent/tools", {
    tool: "call_ended",
    taskId: task.id,
    evidenceRef: "test:ended",
  });
  assert.equal(ended.statusCode, 200);
  assert.equal(ended.json().result.state, "awaiting_staff_approval");
  task = ended.json().result;
  const confirmation = {
    tool: "confirm",
    taskId: task.id,
    input: {
      expectedRevision: task.revision,
      proposalVersion: 1,
      response: "approve",
      evidenceRef: "test:agent-confirm",
    },
  };
  assert.equal((await f.post("operator", "/agent/tools", confirmation)).statusCode, 403);
  assert.equal((await f.post("patient", "/agent/tools", confirmation)).statusCode, 409);
  const callback = {
    tool: "request_callback",
    taskId: task.id,
    input: { expectedRevision: task.revision, callbackWindow: f.input.callbackWindow },
  };
  assert.equal((await f.post("operator", "/agent/tools", callback)).statusCode, 403);
  const updated = await f.post("patient", "/agent/tools", callback);
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.json().result.state, "awaiting_proposal");
  task = updated.json().result;
  const withdrawal = await f.post("patient", "/agent/tools", {
    tool: "withdraw",
    taskId: task.id,
    input: { expectedRevision: task.revision, evidenceRef: "test:agent-withdraw" },
  });
  assert.equal(withdrawal.statusCode, 200);
  assert.equal(withdrawal.json().result.state, "withdrawn");
  assert.equal((await f.pool.query("SELECT id FROM booking_operations")).rowCount, 0);
});

test("interpret endpoint is authenticated, strict and read-only for ambiguous and explicit requests", async (t) => {
  const f = await fixture(t);
  const ambiguous = await f.post("patient", "/agent/interpret", {
    text: "Reschedule my appointment to Thursday afternoon and call after work.",
  });
  assert.equal(ambiguous.statusCode, 200);
  assert.equal(ambiguous.json().ready, false);
  assert.equal(ambiguous.json().availability, null);
  const { availability, callbackWindow } = f.input;
  const explicit = await f.post("patient", "/agent/interpret", {
    text: `Reschedule my appointment; availability: ${availability.startsAt}/${availability.endsAt} [${availability.timeZone}]; callback: ${callbackWindow.startsAt}/${callbackWindow.endsAt} [${callbackWindow.timeZone}]`,
  });
  assert.equal(explicit.json().ready, true);
  assert.equal(
    (await f.post("patient", "/agent/interpret", { text: "Reschedule", role: "staff" })).statusCode,
    400,
  );
  assert.equal((await f.pool.query("SELECT id FROM tasks")).rowCount, 0);
  assert.equal((await f.pool.query("SELECT id FROM task_events")).rowCount, 0);
});

test("callback changes, withdrawal and takeover remain revision checked HTTP mutations", async (t) => {
  const f = await fixture(t);
  let task = await f.proposed();
  const response = await f.post("patient", `/tasks/${task.id}/callback`, {
    expectedRevision: task.revision,
    callbackWindow: f.input.callbackWindow,
  });
  assert.equal(response.statusCode, 200);
  task = response.json();
  assert.equal(task.state, "awaiting_proposal");
  assert.equal(
    (
      await f.post("patient", `/tasks/${task.id}/withdraw`, {
        expectedRevision: task.revision - 1,
        evidenceRef: "test:stale",
      })
    ).json().error,
    "revision_conflict",
  );
  assert.equal(
    (
      await f.post("patient", `/tasks/${task.id}/withdraw`, {
        expectedRevision: task.revision,
        evidenceRef: "test:withdraw",
      })
    ).json().state,
    "withdrawn",
  );
  const takeover = await f.create();
  assert.equal(
    (
      await f.post("operator", `/tasks/${takeover.id}/takeover`, {
        expectedRevision: takeover.revision,
        evidenceRef: "test:operator",
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await f.post("staff", `/tasks/${takeover.id}/takeover`, {
        expectedRevision: takeover.revision,
        evidenceRef: "test:takeover",
      })
    ).json().state,
    "staff_takeover",
  );
});

test("operator queue scopes records and reports overdue actions/jobs, failed delivery and reconciliation", async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 2; index++) {
    const task = await f.proposed();
    assert.equal(
      (
        await f.post("staff", `/tasks/${task.id}/staff-approval`, {
          expectedRevision: task.revision,
          proposalVersion: 1,
          response: "approve",
          evidenceRef: "test:queue",
        })
      ).statusCode,
      200,
    );
  }
  await f.pool.query(
    "UPDATE communication_jobs SET status='failed',last_error='delivery_failed' WHERE id=(SELECT id FROM communication_jobs ORDER BY id LIMIT 1)",
  );
  f.setNow(new Date(f.now().getTime() + 10_800_000));
  const response = await f.inject("operator", "/operator/queue");
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().counts, {
    tasks: 2,
    overduePendingActions: 2,
    overdueJobs: 3,
    failedDeliveries: 1,
    reconciliation: 0,
  });
  assert.equal(response.json().departmentId, "demo-department");
  assert.equal(response.json().tasks.length, 2);
  assert.equal((await f.inject("otherStaff", "/operator/queue")).json().tasks.length, 0);
  assert.equal((await f.inject("patient", "/operator/queue")).statusCode, 403);
});

test("storage failures return no raw database errors or authorization headers", async (t) => {
  const app = Fastify({ logger: false });
  const pool = {
    query: async () => {
      throw new Error("private database details");
    },
  } as unknown as Pool;
  registerBackendRoutes(app, pool);
  t.after(() => app.close());
  const response = await app.inject({
    url: "/me",
    headers: { authorization: `Bearer ${randomBytes(32).toString("base64url")}` },
  });
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), { error: "storage_unavailable" });
});
