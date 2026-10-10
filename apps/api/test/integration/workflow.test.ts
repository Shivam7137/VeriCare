import assert from "node:assert/strict";
import test from "node:test";
import { dispatchDueJobs } from "../../src/delivery.js";
import { grantAuthority, revokeAuthority } from "../../src/identity.js";
import { workflowFixture } from "./workflow-fixture.js";

test("complete backend journey requires exact staff approval, delivered callback, confirmation and scheduler evidence", async (t) => {
  const f = await workflowFixture(t);
  let task = await f.proposed();
  assert.equal(task.state, "awaiting_staff_approval");
  await assert.rejects(
    f.service.decide(f.patient, task.id, "patient_confirmation", {
      expectedRevision: task.revision,
      proposalVersion: 1,
      response: "approve",
      evidenceRef: "test:patient",
    }),
  );
  task = await f.service.decide(f.staff, task.id, "staff_approval", {
    expectedRevision: task.revision,
    proposalVersion: 1,
    response: "approve",
    evidenceRef: "test:staff",
  });
  await assert.rejects(
    f.service.decide(f.patient, task.id, "patient_confirmation", {
      expectedRevision: task.revision,
      proposalVersion: 1,
      response: "approve",
      evidenceRef: "test:patient",
    }),
    { code: "callback_required" },
  );
  assert.equal((await dispatchDueJobs(f.pool, { now: f.now() })).delivered, 1);
  task = (await f.service.progress(f.patient, task.id)).task;
  task = await f.service.decide(f.patient, task.id, "patient_confirmation", {
    expectedRevision: task.revision,
    proposalVersion: 1,
    response: "approve",
    evidenceRef: "test:patient",
  });
  assert.equal(task.state, "ready_to_execute");
  await f.executor.execute(task.id);
  const progress = await f.service.progress(f.patient, task.id);
  assert.equal(progress.task.state, "completed");
  assert.equal(progress.operation?.status, "confirmed");
  assert.ok(progress.actions.every((action) => action.status === "approved"));
  assert.ok(progress.operation?.result.confirmationRef);
  assert.equal((await f.scheduler.getBooking(f.input.appointmentId))?.slotId, "synthetic-slot-002");
  await f.executor.execute(task.id);
  assert.equal((await f.scheduler.getBooking(f.input.appointmentId))?.version, "2");
});

test("replacement proposal invalidates old decisions and callbacks", async (t) => {
  const f = await workflowFixture(t);
  let task = await f.proposed();
  task = await f.service.decide(f.staff, task.id, "staff_approval", {
    expectedRevision: task.revision,
    proposalVersion: 1,
    response: "approve",
    evidenceRef: "test:staff",
  });
  task = await f.service.propose(f.staff, task.id, {
    expectedRevision: task.revision,
    slotId: "synthetic-slot-003",
    expiresAt: new Date(f.now().getTime() + 7_200_000).toISOString(),
  });
  assert.equal(task.state, "awaiting_staff_approval");
  await assert.rejects(
    f.service.decide(f.patient, task.id, "patient_confirmation", {
      expectedRevision: task.revision,
      proposalVersion: 1,
      response: "approve",
      evidenceRef: "test:old",
    }),
    { code: "proposal_version_conflict" },
  );
  assert.equal((await dispatchDueJobs(f.pool, { now: f.now() })).delivered, 0);
  const progress = await f.service.progress(f.patient, task.id);
  assert.equal(progress.proposals.length, 2);
  assert.ok(
    progress.actions.filter((a) => a.proposalVersion === 1).every((a) => a.status === "cancelled"),
  );
});

test("representative access requires separate authority and is revoked immediately", async (t) => {
  const f = await workflowFixture(t);
  await assert.rejects(f.service.create(f.representative, f.input), { statusCode: 404 });
  await grantAuthority(
    f.pool,
    f.patient,
    {
      patientId: f.input.patientId,
      requesterId: f.representative.id,
      expiresAt: new Date(f.now().getTime() + 86_400_000).toISOString(),
      evidenceRef: "test:consent",
    },
    f.now(),
  );
  const task = await f.service.create(f.representative, f.input);
  const patientTask = await f.service.create(f.patient, f.input);
  assert.ok(
    (await f.service.list(f.representative)).some((item) => item.task.id === patientTask.id),
  );
  await revokeAuthority(f.pool, f.patient, f.input.patientId, f.representative.id, f.now());
  await assert.rejects(f.service.progress(f.representative, task.id), { statusCode: 404 });
  await assert.rejects(
    f.service.verify(f.representative, task.id, { expectedRevision: task.revision }),
    { statusCode: 404 },
  );
});

test("withdrawal and staff takeover cancel pending actions and follow-up", async (t) => {
  for (const action of ["withdraw", "takeover"] as const) {
    const f = await workflowFixture(t);
    let task = await f.proposed();
    task = await f.service.decide(f.staff, task.id, "staff_approval", {
      expectedRevision: task.revision,
      proposalVersion: 1,
      response: "approve",
      evidenceRef: "test:staff",
    });
    task = await f.service[action](action === "withdraw" ? f.patient : f.staff, task.id, {
      expectedRevision: task.revision,
      evidenceRef: `test:${action}`,
    });
    assert.equal(task.state, action === "withdraw" ? "withdrawn" : "staff_takeover");
    assert.equal((await dispatchDueJobs(f.pool, { now: f.now() })).delivered, 0);
    await assert.rejects(f.executor.execute(task.id));
    assert.equal((await f.scheduler.getBooking(f.input.appointmentId))?.version, "1");
  }
});
