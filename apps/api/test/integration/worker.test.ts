import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import { runWorkerOnce } from "../../src/worker.js";
import { workflowFixture } from "./workflow-fixture.js";

test("worker persists due callback delivery and exposes an overdue request without executing it", async (t) => {
  const f = await workflowFixture(t);
  let task = await f.proposed();
  task = await f.service.decide(f.staff, task.id, "staff_approval", {
    expectedRevision: task.revision,
    proposalVersion: 1,
    response: "approve",
    evidenceRef: "test:staff",
  });
  const result = await runWorkerOnce(f.pool, { scheduler: f.scheduler, now: f.now });
  assert.equal(result.delivery.delivered, 1);
  assert.equal(
    (await f.service.progress(f.patient, task.id)).task.state,
    "awaiting_patient_confirmation",
  );
  f.setNow(new Date(f.now().getTime() + 3_600_000));
  const expired = await runWorkerOnce(f.pool, { scheduler: f.scheduler, now: f.now });
  assert.equal(expired.expired, 1);
  const progress = await f.service.progress(f.patient, task.id);
  assert.equal(progress.task.state, "awaiting_proposal");
  assert.ok(progress.jobs.every((job) => job.status !== "pending"));
  assert.equal((await f.scheduler.getBooking(f.input.appointmentId))?.version, "1");
});

test("worker cancels a callback whose window expires while recipient authorization is locked", async (t) => {
  const f = await workflowFixture(t);
  let task = await f.proposed();
  task = await f.service.decide(f.staff, task.id, "staff_approval", {
    expectedRevision: task.revision,
    proposalVersion: 1,
    response: "approve",
    evidenceRef: "test:staff",
  });
  const blocker = await f.pool.connect();
  await blocker.query("BEGIN");
  const pid = (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  await blocker.query("SELECT id FROM principals WHERE id = $1 FOR UPDATE", [f.patient.id]);
  const worker = runWorkerOnce(f.pool, { scheduler: f.scheduler, now: f.now });
  let blocked = false;
  try {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      blocked = (
        await f.pool.query(
          `SELECT EXISTS (
             SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))
           ) AS blocked`,
          [pid],
        )
      ).rows[0].blocked;
      if (blocked) break;
      await setTimeout(10);
    }
    f.setNow(new Date(Date.parse(f.input.callbackWindow.endsAt) + 1));
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
  }
  const result = await worker;
  assert.ok(blocked, "the worker must reach the locked recipient before advancing time");
  assert.equal(result.delivery.delivered, 0);
  assert.equal(result.delivery.cancelled, 1);
  assert.equal((await f.pool.query("SELECT * FROM mock_deliveries")).rowCount, 0);
  const callback = (
    await f.pool.query("SELECT status FROM communication_jobs WHERE kind = 'callback'")
  ).rows[0];
  assert.equal(callback.status, "cancelled");
  const workflow = (
    await f.pool.query("SELECT payload FROM workflow_tasks WHERE task_id = $1", [task.id])
  ).rows[0].payload;
  assert.equal(workflow.callbackDelivered, undefined);
});
