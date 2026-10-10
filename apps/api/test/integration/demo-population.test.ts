import assert from "node:assert/strict";
import test from "node:test";
import { populateDemo } from "../../src/demo-population.js";
import { demoTransaction } from "../../src/demo-transaction.js";
import { demoPatients } from "../../src/demo-catalog.js";
import { dispatchDueJobs } from "../../src/delivery.js";
import { getPrincipal } from "../../src/identity.js";
import { migrate } from "../../src/migrations.js";
import { MockScheduler } from "../../src/scheduler.js";
import { VoiceStore } from "../../src/voice-store.js";
import { VoiceAgent } from "../../src/voice-agent.js";
import { WorkflowService } from "../../src/workflow.js";
import { isolatedDatabase } from "./database.js";
import { workflowFixture } from "./workflow-fixture.js";

const now = new Date("2031-06-13T14:00:00.000Z");

test("rich population uses real workflow evidence, future appointments and scoped simulated calls", async (t) => {
  const database = await isolatedDatabase(t);
  const pool = database.open();
  await migrate(pool);
  const result = await populateDemo(pool, { now });
  assert.equal(result.created, 26);
  assert.equal(result.preserved, 0);
  const tasks = (
    await pool.query("SELECT payload FROM tasks WHERE id=ANY($1::text[])", [result.taskIds])
  ).rows.map((row) => row.payload);
  const counts = Object.fromEntries(
    [...new Set(tasks.map((task) => task.state))].map((state) => [
      state,
      tasks.filter((task) => task.state === state).length,
    ]),
  );
  assert.deepEqual(counts, {
    awaiting_verification: 2,
    awaiting_proposal: 4,
    awaiting_staff_approval: 4,
    awaiting_patient_confirmation: 5,
    completed: 6,
    staff_takeover: 3,
    withdrawn: 2,
  });
  assert.equal(
    (await pool.query("SELECT * FROM scheduler_slots WHERE id LIKE 'demo-v1-%'")).rowCount,
    90,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT * FROM scheduler_slots WHERE id LIKE 'demo-v1-%' AND starts_at <= $1",
        [now],
      )
    ).rowCount,
    0,
  );
  const completed = tasks.filter((task) => task.state === "completed");
  for (const task of completed) {
    const saved = (await pool.query("SELECT * FROM booking_operations WHERE task_id=$1", [task.id]))
      .rows[0];
    assert.equal(saved.status, "confirmed");
    assert.ok(saved.result.confirmationRef);
    const receipt = (
      await pool.query("SELECT result FROM scheduler_receipts WHERE operation_key=$1", [
        saved.operation_key,
      ])
    ).rows[0];
    assert.deepEqual(receipt.result, saved.result);
    const decisions = (
      await pool.query("SELECT * FROM action_requests WHERE task_id=$1 AND proposal_version=$2", [
        task.id,
        saved.proposal_version,
      ])
    ).rows;
    assert.equal(decisions.filter((decision) => decision.status === "approved").length, 2);
  }
  const calls = (await pool.query("SELECT * FROM voice_calls")).rows;
  assert.equal(calls.length, 32);
  assert.ok(calls.every((call) => call.mode === "simulated"));
  assert.equal(
    calls.filter(
      (call) => call.direction === "outbound" && call.status === "queued" && call.due_at > now,
    ).length,
    6,
  );
  assert.equal(calls.filter((call) => call.status === "handoff").length, 3);
  assert.equal(calls.filter((call) => call.pending_action?.kind === "confirm").length, 1);
  assert.equal(
    (await pool.query("SELECT * FROM communication_jobs WHERE status='failed' AND attempts=3"))
      .rowCount,
    1,
  );
  assert.equal((await pool.query("SELECT * FROM proposal_drafts WHERE version=2")).rowCount, 5);
  const histories = (
    await pool.query(
      "SELECT task_id,COUNT(*)::int AS count FROM task_events WHERE task_id=ANY($1::text[]) GROUP BY task_id",
      [result.taskIds],
    )
  ).rows;
  assert.equal(histories.length, 26);
  assert.ok(histories.every((history) => history.count >= 2));
  assert.ok(histories.some((history) => history.count >= 10));
  assert.ok((await pool.query("SELECT * FROM voice_tool_results")).rowCount! > 26);
  const workflow = new WorkflowService(pool, {
    scheduler: new MockScheduler(pool, { now: () => now }),
    now: () => now,
  });
  const patient = await getPrincipal(pool, "synthetic-patient-001");
  const visible = await workflow.list(patient);
  assert.equal(visible.filter(({ task }) => result.taskIds.includes(task.id)).length, 8);
  assert.ok(visible.every(({ patient }) => patient.displayName === "Maya Chen"));
  const staff = await getPrincipal(pool, "synthetic-staff-001");
  assert.equal(
    (await workflow.list(staff)).filter(({ task }) => result.taskIds.includes(task.id)).length,
    26,
  );
  assert.equal((await new VoiceStore(pool, { now: () => now }).list(patient)).length, 9);
  const outsider = await getPrincipal(pool, "synthetic-staff-other");
  assert.equal((await workflow.list(outsider)).length, 0);
  const pendingCall = calls.find((call) => call.pending_action?.kind === "confirm")!;
  await dispatchDueJobs(pool, { now, taskId: pendingCall.task_id });
  await new VoiceAgent(pool, { now: () => now }).confirm(
    pendingCall.id,
    pendingCall.pending_action.id,
  );
  assert.equal(
    (await workflow.progress(patient, pendingCall.task_id)).task.state,
    "ready_to_execute",
  );
});

test("reruns preserve user edits, original data, active codes and identity state", async (t) => {
  const fixture = await workflowFixture(t);
  const { pool, patient, service, now } = fixture;
  const original = await fixture.proposed();
  const saved = await service.progress(patient, original.id);
  const store = new VoiceStore(pool, { now });
  const access = await store.issueCode(patient, original.id);
  const beforeCodes = (await pool.query("SELECT * FROM voice_access_codes")).rows;
  const first = await populateDemo(pool, { now: now() });
  assert.deepEqual(await service.progress(patient, original.id), {
    ...saved,
    patient: { id: patient.patientId, displayName: "Maya Chen" },
    events: saved.events.map((event) => ({
      ...event,
      actorDisplayName:
        event.actorId === patient.id
          ? "Maya Chen"
          : event.actorId === "synthetic-staff-001"
            ? "Dr. Anika Rao"
            : null,
    })),
  });
  assert.deepEqual(
    (await pool.query("SELECT * FROM voice_access_codes WHERE id=$1", [beforeCodes[0].id])).rows,
    beforeCodes,
  );
  const editable = (await service.list(patient)).find(
    ({ task }) => first.taskIds.includes(task.id) && task.state === "awaiting_verification",
  )!.task;
  await service.verify(patient, editable.id, { expectedRevision: editable.revision });
  await pool.query("UPDATE principals SET active=false WHERE id=$1", [demoPatients[9]!.id]);
  const before = (await pool.query("SELECT * FROM tasks ORDER BY id")).rows;
  const voiceBefore = (await pool.query("SELECT * FROM voice_calls ORDER BY id")).rows;
  const second = await populateDemo(pool, { now: now() });
  assert.equal(second.created, 0);
  assert.equal(second.preserved, 26);
  assert.deepEqual((await pool.query("SELECT * FROM tasks ORDER BY id")).rows, before);
  assert.deepEqual((await pool.query("SELECT * FROM voice_calls ORDER BY id")).rows, voiceBefore);
  assert.equal((await getPrincipal(pool, demoPatients[9]!.id)).active, false);
  // The pre-existing portal code still works after population and a repeat run.
  assert.equal((await store.simulate(patient, access.code)).taskId, original.id);
});

test("a failed population rolls back all scenario data and concurrent reruns add only one batch", async (t) => {
  const database = await isolatedDatabase(t);
  const pool = database.open();
  await migrate(pool);
  await assert.rejects(
    demoTransaction(pool, async (scoped) => {
      await populateDemo(scoped, { now });
      throw new Error("Rollback probe");
    }),
    /Rollback probe/,
  );
  assert.equal((await pool.query("SELECT * FROM tasks")).rowCount, 0);
  assert.equal((await pool.query("SELECT * FROM voice_calls")).rowCount, 0);
  assert.equal((await pool.query("SELECT * FROM patients")).rowCount, 0);
  const results = await Promise.all([populateDemo(pool, { now }), populateDemo(pool, { now })]);
  assert.equal(
    results.reduce((total, result) => total + result.created, 0),
    26,
  );
  assert.equal(
    (await pool.query("SELECT * FROM scheduler_bookings WHERE id LIKE 'demo-v1-%'")).rowCount,
    26,
  );
});

test("targeted demo delivery leaves another request's due jobs untouched", async (t) => {
  const { pool, service, patient, staff, now } = await workflowFixture(t);
  const result = await populateDemo(pool, { now: now() });
  const pending = (await service.list(staff)).filter(
    ({ task }) => result.taskIds.includes(task.id) && task.state === "awaiting_staff_approval",
  );
  for (const progress of pending.slice(0, 2))
    await service.decide(staff, progress.task.id, "staff_approval", {
      expectedRevision: progress.task.revision,
      proposalVersion: progress.activeProposal!.version,
      response: "approve",
      evidenceRef: "test:scoped-delivery",
    });
  const untouched = pending[1]!.task.id;
  const before = (
    await pool.query("SELECT * FROM communication_jobs WHERE task_id=$1 ORDER BY id", [untouched])
  ).rows;
  await dispatchDueJobs(pool, { now, taskId: pending[0]!.task.id });
  assert.deepEqual(
    (await pool.query("SELECT * FROM communication_jobs WHERE task_id=$1 ORDER BY id", [untouched]))
      .rows,
    before,
  );
  assert.equal(
    (await service.progress(patient, pending[0]!.task.id)).workflow?.callbackDelivered?.version,
    pending[0]!.activeProposal!.version,
  );
});
