import assert from "node:assert/strict";
import test from "node:test";
import { dispatchDueJobs } from "../../src/delivery.js";
import { BookingExecutor } from "../../src/executor.js";
import { grantAuthority, revokeAuthority, type Principal } from "../../src/identity.js";
import type { Scheduler } from "../../src/scheduler.js";
import { workflowFixture } from "./workflow-fixture.js";

type Fixture = Awaited<ReturnType<typeof workflowFixture>>;

async function ready(f: Fixture, requester: Principal) {
  let task = await f.service.create(requester, f.input);
  task = await f.service.verify(requester, task.id, { expectedRevision: task.revision });
  task = await f.service.propose(f.staff, task.id, {
    expectedRevision: task.revision,
    slotId: "synthetic-slot-002",
    expiresAt: new Date(f.now().getTime() + 7_200_000).toISOString(),
  });
  task = await f.service.decide(f.staff, task.id, "staff_approval", {
    expectedRevision: task.revision,
    proposalVersion: 1,
    response: "approve",
    evidenceRef: "test:dispatch-race-staff",
  });
  await dispatchDueJobs(f.pool, { now: f.now() });
  task = (await f.service.progress(requester, task.id)).task;
  return f.service.decide(requester, task.id, "patient_confirmation", {
    expectedRevision: task.revision,
    proposalVersion: 1,
    response: "approve",
    evidenceRef: "test:dispatch-race-requester",
  });
}

function pausedExecutor(f: Fixture) {
  let entered!: () => void;
  let release!: () => void;
  const atSlot = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const scheduler: Scheduler = {
    getBooking: (...args) => f.scheduler.getBooking(...args),
    getSlot: async (...args) => {
      entered();
      await gate;
      return f.scheduler.getSlot(...args);
    },
    listSlots: (...args) => f.scheduler.listSlots(...args),
    change: (...args) => f.scheduler.change(...args),
    lookup: (...args) => f.scheduler.lookup(...args),
  };
  return {
    executor: new BookingExecutor(f.pool, { scheduler, now: f.now }),
    atSlot,
    release,
  };
}

test("revocation committed during the slot recheck blocks an undispatched booking", async (t) => {
  const f = await workflowFixture(t);
  await grantAuthority(
    f.pool,
    f.patient,
    {
      patientId: f.input.patientId,
      requesterId: f.representative.id,
      expiresAt: new Date(f.now().getTime() + 86_400_000).toISOString(),
      evidenceRef: "test:dispatch-race-consent",
    },
    f.now(),
  );
  const task = await ready(f, f.representative);
  const paused = pausedExecutor(f);
  const execution = paused.executor.execute(task.id);
  await paused.atSlot;
  try {
    await revokeAuthority(f.pool, f.patient, f.input.patientId, f.representative.id, f.now());
    const operation = (
      await f.pool.query("SELECT status FROM booking_operations WHERE task_id=$1", [task.id])
    ).rows[0];
    assert.equal(operation.status, "prepared");
  } finally {
    paused.release();
  }
  const result = await execution;
  assert.equal(result.status, "cancelled");
  assert.equal(result.last_error, "authority_required");
  assert.equal((await f.scheduler.getBooking(f.input.appointmentId))?.version, "1");
  assert.equal((await f.pool.query("SELECT * FROM scheduler_receipts")).rowCount, 0);
});

test("proposal expiry crossed during the slot recheck blocks dispatch", async (t) => {
  const f = await workflowFixture(t);
  const task = await ready(f, f.patient);
  const paused = pausedExecutor(f);
  const execution = paused.executor.execute(task.id);
  await paused.atSlot;
  f.setNow(new Date(f.now().getTime() + 7_200_001));
  paused.release();
  const result = await execution;
  assert.equal(result.status, "cancelled");
  assert.equal(result.last_error, "proposal_expired");
  assert.equal((await f.scheduler.getBooking(f.input.appointmentId))?.version, "1");
  assert.equal((await f.pool.query("SELECT * FROM scheduler_receipts")).rowCount, 0);
});
