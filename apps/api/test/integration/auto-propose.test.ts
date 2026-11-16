import assert from "node:assert/strict";
import test from "node:test";
import { dispatchDueJobs } from "../../src/delivery.js";
import { SCHEDULING_AGENT_ID, WorkflowService } from "../../src/workflow.js";
import { workflowFixture } from "./workflow-fixture.js";

test("scheduling agent offers the earliest open slot but cannot approve or book it", async (t) => {
  const f = await workflowFixture(t);
  const service = new WorkflowService(f.pool, {
    scheduler: f.scheduler,
    now: f.now,
    autoPropose: true,
  });
  let task = await service.create(f.patient, f.input);
  task = await service.verify(f.patient, task.id, { expectedRevision: task.revision });
  assert.equal(task.state, "awaiting_staff_approval");

  let progress = await service.progress(f.patient, task.id);
  assert.equal(progress.activeProposal?.createdBy, SCHEDULING_AGENT_ID);
  assert.equal(progress.activeProposal?.slotId, "synthetic-slot-002");
  assert.deepEqual(
    progress.events.map((event) => event.action),
    ["request_created", "access_verified", "proposal_activated"],
  );
  assert.equal(progress.events[2]!.actorId, SCHEDULING_AGENT_ID);
  assert.equal(progress.events[2]!.actorDisplayName, "Scheduling agent");
  // Nothing is booked, and the agent's offer alone does not unlock patient confirmation.
  assert.equal(
    (await f.scheduler.getBooking(f.input.appointmentId))?.slotId,
    "synthetic-slot-original",
  );
  await assert.rejects(
    service.decide(f.patient, task.id, "patient_confirmation", {
      expectedRevision: task.revision,
      proposalVersion: 1,
      response: "approve",
      evidenceRef: "test:patient",
    }),
  );

  task = await service.decide(f.staff, task.id, "staff_approval", {
    expectedRevision: task.revision,
    proposalVersion: 1,
    response: "approve",
    evidenceRef: "test:staff",
  });
  assert.equal((await dispatchDueJobs(f.pool, { now: f.now() })).delivered, 1);
  task = (await service.progress(f.patient, task.id)).task;
  task = await service.decide(f.patient, task.id, "patient_confirmation", {
    expectedRevision: task.revision,
    proposalVersion: 1,
    response: "approve",
    evidenceRef: "test:patient",
  });
  await f.executor.execute(task.id);
  progress = await service.progress(f.patient, task.id);
  assert.equal(progress.task.state, "completed");
  assert.equal((await f.scheduler.getBooking(f.input.appointmentId))?.slotId, "synthetic-slot-002");
});

test("scheduling agent leaves the request for staff when no open slot fits", async (t) => {
  const f = await workflowFixture(t);
  const service = new WorkflowService(f.pool, {
    scheduler: f.scheduler,
    now: f.now,
    autoPropose: true,
  });
  const startsAt = Date.parse(f.input.availability.endsAt) + 86_400_000;
  let task = await service.create(f.patient, {
    ...f.input,
    availability: {
      startsAt: new Date(startsAt).toISOString(),
      endsAt: new Date(startsAt + 3_600_000).toISOString(),
      timeZone: "America/Halifax",
    },
  });
  task = await service.verify(f.patient, task.id, { expectedRevision: task.revision });
  assert.equal(task.state, "awaiting_proposal");
  assert.equal((await service.progress(f.patient, task.id)).activeProposal, null);
});

test("verification leaves proposing to staff unless the agent is switched on", async (t) => {
  const f = await workflowFixture(t);
  let task = await f.service.create(f.patient, f.input);
  task = await f.service.verify(f.patient, task.id, { expectedRevision: task.revision });
  assert.equal(task.state, "awaiting_proposal");
});
