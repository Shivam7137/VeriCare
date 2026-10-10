import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { seededTask, type Task } from "@prc/contracts";
import {
  cancelPendingCommunications,
  dispatchDueJobs,
  enqueueCommunication,
} from "../../src/delivery.js";
import type { WorkflowRecord } from "../../src/domain.js";
import { migrate } from "../../src/migrations.js";
import { isolatedDatabase } from "./database.js";

const now = new Date("2030-01-07T12:00:00.000Z");
const later = (milliseconds: number) => new Date(now.getTime() + milliseconds).toISOString();

async function fixture(t: TestContext, representative = false) {
  const database = await isolatedDatabase(t);
  const pool = database.open();
  await migrate(pool);
  await pool.query(
    "INSERT INTO patients (id, department_id) VALUES ('patient', 'demo-department'), ('representative-patient', 'demo-department')",
  );
  await pool.query(
    `INSERT INTO principals (id, role, patient_id, verified)
     VALUES ('requester', 'patient', 'patient', true),
            ('representative', 'patient', 'representative-patient', true)`,
  );
  if (representative) {
    await pool.query(
      `INSERT INTO authority_grants (id, patient_id, requester_id, granted_by, expires_at, evidence_ref)
       VALUES ('grant', 'patient', 'representative', 'requester', $1, 'synthetic-grant')`,
      [later(3_600_000)],
    );
  }
  const task: Task = {
    ...seededTask,
    id: "delivery-task",
    patientId: "patient",
    requesterId: representative ? "representative" : "requester",
    state: "awaiting_patient_confirmation",
  };
  const workflow: WorkflowRecord = {
    appointmentId: "appointment",
    availability: { startsAt: later(86_400_000), endsAt: later(90_000_000), timeZone: "UTC" },
    callbackWindow: { startsAt: later(-60_000), endsAt: later(600_000), timeZone: "UTC" },
    requireStaffApproval: true,
    activeProposalVersion: 1,
  };
  const proposal = {
    id: "proposal",
    taskId: task.id,
    version: 1,
    status: "draft",
    appointmentId: "appointment",
    slotId: "slot",
    expectedBookingVersion: "1",
    startsAt: later(86_400_000),
    endsAt: later(90_000_000),
    expiresAt: later(600_000),
    createdAt: later(-60_000),
    createdBy: "synthetic-staff",
  };
  await pool.query("INSERT INTO tasks (id, payload) VALUES ($1, $2)", [task.id, task]);
  await pool.query("INSERT INTO workflow_tasks (task_id, payload) VALUES ($1, $2)", [
    task.id,
    workflow,
  ]);
  await pool.query(
    "INSERT INTO proposal_drafts (id, task_id, version, payload) VALUES ($1, $2, 1, $3)",
    [proposal.id, task.id, proposal],
  );
  await pool.query(
    `INSERT INTO action_requests (id, task_id, proposal_version, kind, assignee_id, status, expires_at)
     VALUES ('confirmation', $1, 1, 'patient_confirmation', $2, 'pending', $3)`,
    [task.id, task.requesterId, later(600_000)],
  );
  const input = {
    taskId: task.id,
    proposalVersion: 1,
    kind: "callback" as const,
    recipientId: task.requesterId,
    dueAt: now.toISOString(),
    expiresAt: later(600_000),
  };
  return { database, pool, task, workflow, proposal, input };
}

test("callback enqueue is idempotent and delivery survives reopening the database", async (t) => {
  const { database, pool, task, input } = await fixture(t);
  const job = await enqueueCommunication(pool, input);
  assert.deepEqual(await enqueueCommunication(pool, { ...input, dueAt: later(1_000) }), job);
  await database.close(pool);
  const restarted = database.open();
  assert.deepEqual(await dispatchDueJobs(restarted, { now }), {
    delivered: 1,
    cancelled: 0,
    failed: 0,
    retried: 0,
  });
  const saved = (await restarted.query("SELECT * FROM communication_jobs")).rows[0];
  assert.equal(saved.status, "delivered");
  assert.equal(saved.attempts, 1);
  const receipt = (await restarted.query("SELECT * FROM mock_deliveries")).rows[0];
  assert.equal(receipt.job_id, job.id);
  assert.equal(receipt.recipient_id, task.requesterId);
  assert.equal(receipt.delivered_at.toISOString(), now.toISOString());
  const workflow = (await restarted.query("SELECT payload FROM workflow_tasks")).rows[0].payload;
  assert.deepEqual(workflow.callbackDelivered, { version: 1, at: now.toISOString() });
  const updated = (await restarted.query("SELECT payload FROM tasks")).rows[0].payload;
  assert.equal(updated.revision, 1);
  assert.equal(updated.state, "awaiting_patient_confirmation");
  const event = (await restarted.query("SELECT * FROM task_events")).rows[0];
  assert.equal(event.action, "callback_delivered");
  assert.equal(event.evidence_ref, receipt.receipt_ref);
  assert.deepEqual(await dispatchDueJobs(restarted, { now }), {
    delivered: 0,
    cancelled: 0,
    failed: 0,
    retried: 0,
  });
  assert.equal((await restarted.query("SELECT * FROM mock_deliveries")).rowCount, 1);
});

test("two workers record only one receipt and revision for one callback", async (t) => {
  const { database, pool, input } = await fixture(t);
  await enqueueCommunication(pool, input);
  const workers = await Promise.all([
    dispatchDueJobs(pool, { now }),
    dispatchDueJobs(database.open(), { now }),
  ]);
  assert.equal(
    workers.reduce((count, result) => count + result.delivered, 0),
    1,
  );
  assert.equal((await pool.query("SELECT * FROM mock_deliveries")).rowCount, 1);
  assert.equal((await pool.query("SELECT * FROM task_events")).rowCount, 1);
  assert.equal((await pool.query("SELECT payload FROM tasks")).rows[0].payload.revision, 1);
});

test("concurrent enqueues create one pending job without changing its recipient", async (t) => {
  const { pool, input } = await fixture(t);
  const jobs = await Promise.all([
    enqueueCommunication(pool, input),
    enqueueCommunication(pool, input),
  ]);
  assert.equal(jobs[0]?.id, jobs[1]?.id);
  assert.equal((await pool.query("SELECT * FROM communication_jobs")).rowCount, 1);
  const repeated = await enqueueCommunication(pool, { ...input, recipientId: "different" });
  assert.equal(repeated.recipientId, input.recipientId);
});

test("a reminder receipt does not provide the callback evidence needed for confirmation", async (t) => {
  const { pool, input } = await fixture(t);
  await enqueueCommunication(pool, { ...input, kind: "reminder" });
  assert.equal((await dispatchDueJobs(pool, { now })).delivered, 1);
  assert.equal((await pool.query("SELECT * FROM mock_deliveries")).rowCount, 1);
  assert.equal(
    (await pool.query("SELECT action FROM task_events")).rows[0].action,
    "reminder_delivered",
  );
  assert.equal(
    (await pool.query("SELECT payload FROM workflow_tasks")).rows[0].payload.callbackDelivered,
    undefined,
  );
});

test("a worker skips a locked task and observes withdrawal after the command commits", async (t) => {
  const { pool, task, input } = await fixture(t);
  await enqueueCommunication(pool, input);
  const command = await pool.connect();
  try {
    await command.query("BEGIN");
    await command.query("SELECT id FROM tasks WHERE id = $1 FOR UPDATE", [task.id]);
    await command.query("UPDATE tasks SET payload = $1", [{ ...task, state: "withdrawn" }]);
    assert.equal((await dispatchDueJobs(pool, { now })).delivered, 0);
    await command.query("COMMIT");
  } catch (error) {
    await command.query("ROLLBACK");
    throw error;
  } finally {
    command.release();
  }
  assert.equal((await dispatchDueJobs(pool, { now })).cancelled, 1);
  assert.equal((await pool.query("SELECT * FROM mock_deliveries")).rowCount, 0);
});

test("callback delivery rechecks the window and authority after a delayed attempt", async (t) => {
  for (const expiry of ["callback", "authority"]) {
    await t.test(expiry, async (child) => {
      const { pool, input } = await fixture(child, true);
      if (expiry === "authority") {
        await pool.query("UPDATE authority_grants SET expires_at = $1", [later(500)]);
      }
      const clock = new Date(now);
      await enqueueCommunication(pool, input);
      const result = await dispatchDueJobs(pool, {
        now: clock,
        beforeDelivery: async () => {
          clock.setTime(now.getTime() + (expiry === "callback" ? 600_000 : 500));
        },
      });
      assert.equal(result.cancelled, 1);
      assert.equal((await pool.query("SELECT * FROM mock_deliveries")).rowCount, 0);
      assert.equal(
        (await pool.query("SELECT payload FROM workflow_tasks")).rows[0].payload.callbackDelivered,
        undefined,
      );
    });
  }
});

test("cancelling pending communications persists and never resets a delivered job", async (t) => {
  const { pool, task, input } = await fixture(t);
  const callback = await enqueueCommunication(pool, input);
  await dispatchDueJobs(pool, { now });
  const reminder = await enqueueCommunication(pool, { ...input, kind: "reminder" });
  await cancelPendingCommunications(pool, task.id);
  const jobs = (await pool.query("SELECT id, status FROM communication_jobs")).rows;
  assert.equal(jobs.find((job) => job.id === callback.id)?.status, "delivered");
  assert.equal(jobs.find((job) => job.id === reminder.id)?.status, "cancelled");
  assert.equal((await dispatchDueJobs(pool, { now })).delivered, 0);
});

test("workers cancel obsolete, unauthorized, expired, and no-longer-pending jobs", async (t) => {
  const scenarios = [
    "withdrawn",
    "completed",
    "staff_takeover",
    "ready_to_execute",
    "withdrawal_requested",
    "takeover_requested",
    "version_changed",
    "job_expired",
    "proposal_expired",
    "window_expired",
    "action_cancelled",
    "action_expired",
    "action_reassigned",
    "recipient_changed",
    "authority_revoked",
    "authority_expired",
    "principal_inactive",
    "principal_unverified",
  ];
  for (const scenario of scenarios) {
    await t.test(scenario, async (child) => {
      const { pool, task, workflow, proposal, input } = await fixture(child, true);
      if (["withdrawn", "completed", "staff_takeover", "ready_to_execute"].includes(scenario)) {
        await pool.query("UPDATE tasks SET payload = $1", [{ ...task, state: scenario }]);
      }
      if (scenario === "withdrawal_requested") workflow.withdrawalRequested = true;
      if (scenario === "takeover_requested") workflow.takeoverRequested = true;
      if (scenario === "version_changed") workflow.activeProposalVersion = 2;
      if (scenario === "window_expired") workflow.callbackWindow.endsAt = now.toISOString();
      await pool.query("UPDATE workflow_tasks SET payload = $1", [workflow]);
      if (scenario === "proposal_expired") {
        await pool.query("UPDATE proposal_drafts SET payload = $1", [
          { ...proposal, expiresAt: now.toISOString() },
        ]);
      }
      if (scenario === "action_cancelled")
        await pool.query("UPDATE action_requests SET status = 'cancelled'");
      if (scenario === "action_expired")
        await pool.query("UPDATE action_requests SET expires_at = $1", [now]);
      if (scenario === "action_reassigned")
        await pool.query("UPDATE action_requests SET assignee_id = 'requester'");
      if (scenario === "recipient_changed") input.recipientId = "requester";
      if (scenario === "authority_revoked")
        await pool.query("UPDATE authority_grants SET revoked_at = $1", [now]);
      if (scenario === "authority_expired")
        await pool.query("UPDATE authority_grants SET expires_at = $1", [now]);
      if (scenario === "principal_inactive")
        await pool.query("UPDATE principals SET active = false WHERE id = 'representative'");
      if (scenario === "principal_unverified")
        await pool.query("UPDATE principals SET verified = false WHERE id = 'representative'");
      await enqueueCommunication(pool, input);
      if (scenario === "job_expired")
        await pool.query("UPDATE communication_jobs SET expires_at = $1", [now]);
      assert.deepEqual(await dispatchDueJobs(pool, { now }), {
        delivered: 0,
        cancelled: 1,
        failed: 0,
        retried: 0,
      });
      const job = (await pool.query("SELECT * FROM communication_jobs")).rows[0];
      assert.equal(job.status, "cancelled");
      assert.ok(job.last_error);
      assert.equal((await pool.query("SELECT * FROM mock_deliveries")).rowCount, 0);
      assert.equal(
        (await pool.query("SELECT payload FROM workflow_tasks")).rows[0].payload.callbackDelivered,
        undefined,
      );
    });
  }
});

test("callbacks and reminders wait for the agreed callback window", async (t) => {
  const { pool, workflow, input } = await fixture(t);
  workflow.callbackWindow.startsAt = later(60_000);
  await pool.query("UPDATE workflow_tasks SET payload = $1", [workflow]);
  await enqueueCommunication(pool, input);
  await enqueueCommunication(pool, { ...input, kind: "reminder" });
  assert.deepEqual(await dispatchDueJobs(pool, { now }), {
    delivered: 0,
    cancelled: 0,
    failed: 0,
    retried: 0,
  });
  assert.equal((await pool.query("SELECT * FROM mock_deliveries")).rowCount, 0);
  assert.equal((await dispatchDueJobs(pool, { now: new Date(later(60_000)) })).delivered, 2);
  assert.equal((await pool.query("SELECT * FROM mock_deliveries")).rowCount, 2);
  assert.equal((await pool.query("SELECT payload FROM tasks")).rows[0].payload.revision, 2);
});

test("delivery failures back off durably and expose only safe errors before eventual success", async (t) => {
  const { database, pool, input } = await fixture(t);
  await enqueueCommunication(pool, input);
  const beforeDelivery = async () => {
    throw new Error("secret-provider-token=do-not-persist");
  };
  assert.deepEqual(await dispatchDueJobs(pool, { now, beforeDelivery }), {
    delivered: 0,
    cancelled: 0,
    failed: 0,
    retried: 1,
  });
  const failedAttempt = (await pool.query("SELECT * FROM communication_jobs")).rows[0];
  assert.equal(failedAttempt.status, "pending");
  assert.equal(failedAttempt.attempts, 1);
  assert.equal(failedAttempt.due_at.toISOString(), later(1_000));
  assert.equal(failedAttempt.last_error, "delivery_failed");
  assert.equal((await pool.query("SELECT * FROM mock_deliveries")).rowCount, 0);
  assert.equal(
    (await pool.query("SELECT payload FROM workflow_tasks")).rows[0].payload.callbackDelivered,
    undefined,
  );
  await database.close(pool);
  const restarted = database.open();
  assert.equal((await dispatchDueJobs(restarted, { now })).delivered, 0);
  assert.equal((await dispatchDueJobs(restarted, { now: new Date(later(1_000)) })).delivered, 1);
  const delivered = (await restarted.query("SELECT * FROM communication_jobs")).rows[0];
  assert.equal(delivered.attempts, 2);
  assert.equal(delivered.last_error, null);
});

test("three failed delivery attempts exhaust retries and do not record callback evidence", async (t) => {
  const { pool, input } = await fixture(t);
  await enqueueCommunication(pool, input);
  const beforeDelivery = async () => {
    throw new Error("synthetic transport fault");
  };
  for (const offset of [0, 1_000]) {
    assert.equal(
      (await dispatchDueJobs(pool, { now: new Date(later(offset)), beforeDelivery })).retried,
      1,
    );
  }
  assert.equal(
    (await pool.query("SELECT due_at FROM communication_jobs")).rows[0].due_at.toISOString(),
    later(3_000),
  );
  assert.equal(
    (await dispatchDueJobs(pool, { now: new Date(later(3_000)), beforeDelivery })).failed,
    1,
  );
  const job = (await pool.query("SELECT * FROM communication_jobs")).rows[0];
  assert.equal(job.status, "failed");
  assert.equal(job.attempts, 3);
  assert.equal((await dispatchDueJobs(pool, { now: new Date(later(10_000)) })).delivered, 0);
  assert.equal((await pool.query("SELECT * FROM mock_deliveries")).rowCount, 0);
  assert.equal(
    (await pool.query("SELECT payload FROM workflow_tasks")).rows[0].payload.callbackDelivered,
    undefined,
  );
});

test("retry backoff never extends beyond job, proposal, action, or callback expiry", async (t) => {
  for (const deadline of ["job", "proposal", "action", "callback"]) {
    await t.test(deadline, async (child) => {
      const { pool, workflow, proposal, input } = await fixture(child);
      if (deadline === "job") input.expiresAt = later(500);
      if (deadline === "proposal")
        await pool.query("UPDATE proposal_drafts SET payload = $1", [
          { ...proposal, expiresAt: later(500) },
        ]);
      if (deadline === "action")
        await pool.query("UPDATE action_requests SET expires_at = $1", [later(500)]);
      if (deadline === "callback")
        await pool.query("UPDATE workflow_tasks SET payload = $1", [
          { ...workflow, callbackWindow: { ...workflow.callbackWindow, endsAt: later(500) } },
        ]);
      await enqueueCommunication(pool, input);
      const result = await dispatchDueJobs(pool, {
        now,
        beforeDelivery: async () => {
          throw new Error("fault");
        },
      });
      assert.equal(result.failed, 1);
      const job = (await pool.query("SELECT * FROM communication_jobs")).rows[0];
      assert.equal(job.status, "failed");
      assert.equal(job.due_at.toISOString(), now.toISOString());
      assert.equal((await pool.query("SELECT * FROM mock_deliveries")).rowCount, 0);
    });
  }
});

test("an event persistence failure rolls back the receipt, job, callback evidence, and revision", async (t) => {
  const { pool, input } = await fixture(t);
  await enqueueCommunication(pool, input);
  await pool.query(
    "ALTER TABLE task_events ADD CONSTRAINT reject_delivery_event CHECK (action <> 'callback_delivered')",
  );
  await assert.rejects(dispatchDueJobs(pool, { now }), { code: "23514" });
  assert.equal((await pool.query("SELECT * FROM mock_deliveries")).rowCount, 0);
  assert.equal(
    (await pool.query("SELECT status FROM communication_jobs")).rows[0].status,
    "pending",
  );
  assert.equal((await pool.query("SELECT payload FROM tasks")).rows[0].payload.revision, 0);
  assert.equal(
    (await pool.query("SELECT payload FROM workflow_tasks")).rows[0].payload.callbackDelivered,
    undefined,
  );
});
