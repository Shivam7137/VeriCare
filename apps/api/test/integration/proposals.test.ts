import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { seededTask } from "@prc/contracts";
import { migrate } from "../../src/migrations.js";
import { seed } from "../../src/fixtures.js";
import { saveProposalDraft } from "../../src/proposals.js";
import { isolatedDatabase } from "./database.js";

async function fixture(t: TestContext) {
  const database = await isolatedDatabase(t);
  const pool = database.open();
  await migrate(pool);
  await seed(pool);
  const task = { ...seededTask, id: `synthetic-task-${randomUUID()}`, state: "awaiting_proposal" };
  await pool.query("INSERT INTO tasks (id, payload) VALUES ($1, $2)", [task.id, task]);
  const now = Date.now();
  const input = {
    taskId: task.id,
    expectedRevision: 0,
    actorId: "synthetic-staff-001",
    appointmentId: "synthetic-appointment-001",
    slotId: "synthetic-slot-002",
    expectedBookingVersion: "booking-v1",
    startsAt: new Date(now + 86_400_000).toISOString(),
    endsAt: new Date(now + 88_200_000).toISOString(),
    expiresAt: new Date(now + 3_600_000).toISOString(),
  };
  return { database, pool, task, input };
}

test("draft versions, task revision, and audit evidence survive new database connections", async (t) => {
  const { database, pool, task, input } = await fixture(t);
  const first = await saveProposalDraft(pool, input);
  const second = await saveProposalDraft(pool, {
    ...input,
    expectedRevision: 1,
    slotId: "synthetic-slot-003",
  });
  assert.equal(first.proposal.version, 1);
  assert.equal(second.proposal.version, 2);
  assert.notEqual(first.proposal.id, second.proposal.id);
  assert.equal(second.task.revision, 2);
  assert.equal(second.task.state, "awaiting_proposal");
  assert.equal(second.task.updatedAt, second.proposal.createdAt);
  assert.equal(second.event.actorId, input.actorId);
  assert.equal(second.event.evidenceRef, `proposal:${second.proposal.id}:v2`);
  await database.close(pool);

  const restarted = database.open();
  assert.deepEqual(
    (await restarted.query("SELECT payload FROM tasks WHERE id = $1", [task.id])).rows[0].payload,
    second.task,
  );
  assert.deepEqual(
    (
      await restarted.query(
        "SELECT payload FROM proposal_drafts WHERE task_id = $1 ORDER BY version",
        [task.id],
      )
    ).rows.map((row) => row.payload),
    [first.proposal, second.proposal],
  );
  assert.deepEqual(
    (
      await restarted.query(
        "SELECT evidence_ref FROM task_events WHERE task_id = $1 ORDER BY evidence_ref",
        [task.id],
      )
    ).rows
      .map((row) => row.evidence_ref)
      .sort(),
    [first.event.evidenceRef, second.event.evidenceRef].sort(),
  );
  assert.deepEqual(
    (await restarted.query("SELECT payload FROM tasks WHERE id = 'T001'")).rows[0].payload,
    seededTask,
  );
});

test("concurrent saves at the same task revision produce one draft and one event", async (t) => {
  const { pool, task, input } = await fixture(t);
  const results = await Promise.allSettled([
    saveProposalDraft(pool, input),
    saveProposalDraft(pool, { ...input, slotId: "synthetic-slot-003" }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.equal(rejected?.reason.code, "revision_conflict");
  assert.equal(
    (await pool.query("SELECT * FROM proposal_drafts WHERE task_id = $1", [task.id])).rowCount,
    1,
  );
  assert.equal(
    (await pool.query("SELECT * FROM task_events WHERE task_id = $1", [task.id])).rowCount,
    1,
  );
  assert.equal(
    (await pool.query("SELECT payload FROM tasks WHERE id = $1", [task.id])).rows[0].payload
      .revision,
    1,
  );
});

test("a failed event write rolls back the proposal and task revision", async (t) => {
  const { pool, task, input } = await fixture(t);
  await pool.query(
    "ALTER TABLE task_events ADD CONSTRAINT reject_draft_event CHECK (action <> 'proposal_drafted')",
  );
  await assert.rejects(saveProposalDraft(pool, input), { code: "23514" });
  assert.equal(
    (await pool.query("SELECT * FROM proposal_drafts WHERE task_id = $1", [task.id])).rowCount,
    0,
  );
  assert.deepEqual(
    (await pool.query("SELECT payload FROM tasks WHERE id = $1", [task.id])).rows[0].payload,
    task,
  );
  await pool.query("ALTER TABLE task_events DROP CONSTRAINT reject_draft_event");
  assert.equal((await saveProposalDraft(pool, input)).proposal.version, 1);
});

test("unknown tasks and tasks outside proposal preparation reject draft creation", async (t) => {
  const { pool, task, input } = await fixture(t);
  await assert.rejects(saveProposalDraft(pool, { ...input, taskId: "missing-task" }), {
    code: "task_not_found",
  });
  for (const state of [
    "awaiting_verification",
    "awaiting_staff_approval",
    "awaiting_patient_confirmation",
    "ready_to_execute",
    "executing",
    "reconciling",
    "completed",
    "withdrawn",
    "staff_takeover",
  ]) {
    const unavailable = { ...task, state };
    await pool.query("UPDATE tasks SET payload = $2 WHERE id = $1", [task.id, unavailable]);
    await assert.rejects(saveProposalDraft(pool, input), { code: "task_not_open_for_proposals" });
    assert.deepEqual(
      (await pool.query("SELECT payload FROM tasks WHERE id = $1", [task.id])).rows[0].payload,
      unavailable,
    );
  }
  assert.equal((await pool.query("SELECT * FROM proposal_drafts")).rowCount, 0);
  assert.equal(
    (await pool.query("SELECT * FROM task_events WHERE task_id = $1", [task.id])).rowCount,
    0,
  );
});

test("invalid or expired changes cannot write proposals or advance the task", async (t) => {
  const { pool, task, input } = await fixture(t);
  for (const invalid of [
    { expectedRevision: -1 },
    { expectedRevision: 0.5 },
    { expiresAt: "2000-01-01T00:00:00.000Z" },
    { endsAt: input.startsAt },
    { actorId: "" },
    { expectedBookingVersion: "" },
    { state: "completed" },
  ]) {
    await assert.rejects(saveProposalDraft(pool, { ...input, ...invalid }), { name: "ZodError" });
  }
  assert.equal((await pool.query("SELECT * FROM proposal_drafts")).rowCount, 0);
  assert.deepEqual(
    (await pool.query("SELECT payload FROM tasks WHERE id = $1", [task.id])).rows[0].payload,
    task,
  );
});
