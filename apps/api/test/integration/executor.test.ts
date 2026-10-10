import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { dispatchDueJobs } from "../../src/delivery.js";
import { MockScheduler } from "../../src/scheduler.js";
import { BookingExecutor } from "../../src/executor.js";
import { WorkflowService } from "../../src/workflow.js";
import { grantAuthority, revokeAuthority } from "../../src/identity.js";
import { workflowFixture } from "./workflow-fixture.js";

async function ready(f: Awaited<ReturnType<typeof workflowFixture>>) {
  let task = await f.proposed();
  task = await f.service.decide(f.staff, task.id, "staff_approval", {
    expectedRevision: task.revision,
    proposalVersion: 1,
    response: "approve",
    evidenceRef: "test:staff",
  });
  await dispatchDueJobs(f.pool, { now: f.now() });
  task = (await f.service.progress(f.patient, task.id)).task;
  return f.service.decide(f.patient, task.id, "patient_confirmation", {
    expectedRevision: task.revision,
    proposalVersion: 1,
    response: "approve",
    evidenceRef: "test:patient",
  });
}

test("concurrent executors make one booking change and one completion event", async (t) => {
  const f = await workflowFixture(t),
    task = await ready(f);
  await Promise.all([f.executor.execute(task.id), f.executor.execute(task.id)]);
  const progress = await f.service.progress(f.patient, task.id);
  assert.equal(progress.task.state, "completed");
  assert.equal(progress.events.filter((event) => event.action === "booking_confirmed").length, 1);
  assert.equal((await f.scheduler.getBooking(f.input.appointmentId))?.version, "2");
  assert.equal((await f.pool.query("SELECT * FROM scheduler_receipts")).rowCount, 1);
});

test("a real process exit after scheduler commit is reconciled without another booking change", async (t) => {
  const f = await workflowFixture(t),
    task = await ready(f);
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "apps/api/test/integration/crash-worker.ts"],
    {
      cwd: new URL("../../../../", import.meta.url),
      env: {
        ...process.env,
        DATABASE_URL: f.pool.options.connectionString,
        TEST_TASK_ID: task.id,
        TEST_NOW: f.now().toISOString(),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let errors = "";
  child.stderr.on("data", (data) => {
    errors += String(data);
  });
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  assert.equal(code, 73, errors);
  assert.equal(
    (await f.pool.query("SELECT status FROM booking_operations WHERE task_id=$1", [task.id]))
      .rows[0].status,
    "dispatched",
  );
  const reopened = f.database.open();
  const scheduler = new MockScheduler(reopened, { now: f.now });
  const recovery = new BookingExecutor(reopened, { scheduler, now: f.now });
  assert.equal((await recovery.recover())[0]?.status, "confirmed");
  assert.equal(
    (await new WorkflowService(reopened, { scheduler, now: f.now }).progress(f.patient, task.id))
      .task.state,
    "completed",
  );
  assert.equal((await scheduler.getBooking(f.input.appointmentId))?.version, "2");
});

test("unavailable slots and stale booking versions keep requests active for a new proposal", async (t) => {
  for (const conflict of ["slot", "version"] as const) {
    const f = await workflowFixture(t),
      task = await ready(f);
    if (conflict === "slot")
      await f.pool.query(
        "UPDATE scheduler_slots SET available=false WHERE id='synthetic-slot-002'",
      );
    else
      await f.pool.query("UPDATE scheduler_bookings SET version=version+1 WHERE id=$1", [
        f.input.appointmentId,
      ]);
    const result = await f.executor.execute(task.id);
    assert.equal(result.status, "rejected");
    const progress = await f.service.progress(f.patient, task.id);
    assert.equal(progress.task.state, "awaiting_proposal");
    assert.equal(
      (await f.scheduler.getBooking(f.input.appointmentId))?.slotId,
      "synthetic-slot-original",
    );
  }
});

test("expired proposals, changed slot times, and revoked identity block dispatch", async (t) => {
  for (const conflict of ["expiry", "slot_time", "identity"] as const) {
    const f = await workflowFixture(t),
      task = await ready(f);
    if (conflict === "expiry") f.setNow(new Date(f.now().getTime() + 7_200_000));
    else if (conflict === "slot_time")
      await f.pool.query(
        "UPDATE scheduler_slots SET starts_at=starts_at + interval '1 minute' WHERE id='synthetic-slot-002'",
      );
    else await f.pool.query("UPDATE principals SET active=false WHERE id=$1", [f.patient.id]);
    assert.equal((await f.executor.execute(task.id)).status, "cancelled");
    assert.equal((await f.pool.query("SELECT * FROM scheduler_receipts")).rowCount, 0);
    assert.equal((await f.scheduler.getBooking(f.input.appointmentId))?.version, "1");
  }
});

test("takeover while a committed booking response is pending preserves and reconciles that result", async (t) => {
  const f = await workflowFixture(t),
    task = await ready(f);
  let entered!: () => void, release!: () => void;
  const atCommit = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const continueResponse = new Promise<void>((resolve) => {
    release = resolve;
  });
  const scheduler = new MockScheduler(f.pool, {
    now: f.now,
    afterCommit: async () => {
      entered();
      await continueResponse;
      throw new Error("lost response");
    },
  });
  const execution = new BookingExecutor(f.pool, { scheduler, now: f.now }).execute(task.id);
  await atCommit;
  const current = (await f.service.progress(f.staff, task.id)).task;
  await f.service.takeover(f.staff, task.id, {
    expectedRevision: current.revision,
    evidenceRef: "test:takeover",
  });
  release();
  assert.equal((await execution).status, "reconciling");
  await f.executor.recover();
  const progress = await f.service.progress(f.staff, task.id);
  assert.equal(progress.task.state, "completed");
  assert.equal(progress.task.owner, f.staff.id);
  assert.equal(progress.workflow?.takeoverRequested, true);
  assert.ok(progress.events.some((event) => event.action === "staff_takeover_requested"));
  assert.equal((await f.scheduler.getBooking(f.input.appointmentId))?.version, "2");
});

test("an unavailable scheduler lookup never triggers a blind retry", async (t) => {
  const f = await workflowFixture(t),
    task = await ready(f);
  let changes = 0;
  const scheduler = new MockScheduler(f.pool, { now: f.now });
  scheduler.change = async () => {
    changes++;
    throw new Error("provider unavailable");
  };
  scheduler.lookup = async () => {
    throw new Error("lookup unavailable");
  };
  const executor = new BookingExecutor(f.pool, { scheduler, now: f.now });
  assert.equal((await executor.execute(task.id)).status, "reconciling");
  assert.equal((await executor.execute(task.id)).status, "reconciling");
  assert.equal(changes, 1);
  assert.equal((await f.service.progress(f.patient, task.id)).task.state, "reconciling");
});

test("stale HTTP execute revisions cannot dispatch a newly changed task", async (t) => {
  const f = await workflowFixture(t),
    task = await ready(f);
  await assert.rejects(
    f.executor.execute(task.id, { actor: f.staff, expectedRevision: task.revision - 1 }),
    { code: "revision_conflict" },
  );
  assert.equal((await f.pool.query("SELECT * FROM booking_operations")).rowCount, 0);
  await f.executor.execute(task.id, { actor: f.staff, expectedRevision: task.revision });
  assert.equal(
    (await f.executor.execute(task.id, { actor: f.staff, expectedRevision: task.revision })).status,
    "confirmed",
  );
});
