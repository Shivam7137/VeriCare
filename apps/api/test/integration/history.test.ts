import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { seededTask, taskEventSchema } from "@prc/contracts";
import { buildApp } from "../../src/app.js";
import { migrate } from "../../src/migrations.js";
import { seed } from "../../src/fixtures.js";
import { saveProposalDraft } from "../../src/proposals.js";
import { isolatedDatabase } from "./database.js";

test("demo history distinguishes missing tasks from an empty proposal list", async (t) => {
  const database = await isolatedDatabase(t);
  const pool = database.open();
  await migrate(pool);
  const app = buildApp(pool, true);
  t.after(() => app.close());
  for (const path of ["events", "proposals"]) {
    assert.equal((await app.inject(`/demo/tasks/T001/${path}`)).statusCode, 404);
  }
  await seed(pool);
  const proposals = await app.inject("/demo/tasks/T001/proposals");
  assert.equal(proposals.statusCode, 200);
  assert.deepEqual(proposals.json(), { taskId: "T001", proposals: [] });
  const events = await app.inject("/demo/tasks/T001/events");
  assert.equal(events.statusCode, 200);
  assert.deepEqual(events.json(), {
    taskId: "T001",
    events: [
      {
        id: "E001",
        taskId: "T001",
        actorId: "fixture-seeder",
        action: "synthetic_task_seeded",
        occurredAt: seededTask.createdAt,
        evidenceRef: "fixture:T001",
      },
    ],
  });
});

test("demo endpoints return persisted versions and ordered events after connections restart", async (t) => {
  const database = await isolatedDatabase(t);
  const pool = database.open();
  await migrate(pool);
  const task = { ...seededTask, state: "awaiting_proposal" };
  await pool.query("INSERT INTO tasks (id, payload) VALUES ($1, $2)", [task.id, task]);
  const now = Date.now();
  const input = {
    taskId: "T001",
    expectedRevision: 0,
    actorId: "synthetic-staff-001",
    appointmentId: "synthetic-appointment-001",
    slotId: "synthetic-slot-002",
    expectedBookingVersion: "booking-v1",
    startsAt: new Date(now + 86_400_000).toISOString(),
    endsAt: new Date(now + 88_200_000).toISOString(),
    expiresAt: new Date(now + 3_600_000).toISOString(),
  };
  const first = await saveProposalDraft(pool, input);
  const second = await saveProposalDraft(pool, {
    ...input,
    expectedRevision: 1,
    slotId: "synthetic-slot-003",
  });
  // Equal timestamps have a stable ID tie-breaker, independent of insertion order.
  await pool.query("UPDATE task_events SET occurred_at = $1 WHERE task_id = 'T001'", [
    seededTask.createdAt,
  ]);
  const another = { ...task, id: "unrelated-task" };
  await pool.query("INSERT INTO tasks (id, payload) VALUES ($1, $2)", [another.id, another]);
  await saveProposalDraft(pool, { ...input, taskId: another.id });
  await database.close(pool);

  const app = buildApp(database.open(), true);
  t.after(() => app.close());
  const proposals = await app.inject("/demo/tasks/T001/proposals");
  assert.equal(proposals.statusCode, 200);
  assert.deepEqual(proposals.json(), {
    taskId: "T001",
    proposals: [first.proposal, second.proposal],
  });
  const response = await app.inject("/demo/tasks/T001/events");
  assert.equal(response.statusCode, 200);
  const events = response.json().events.map((event: unknown) => taskEventSchema.parse(event));
  assert.deepEqual(
    events,
    // Events saved in the same instant come back in the order they were saved.
    [first.event, second.event].map((event) => ({ ...event, occurredAt: seededTask.createdAt })),
  );
});

test("readiness rejects a database that has not received the proposal migration", async (t) => {
  const database = await isolatedDatabase(t);
  const pool = database.open();
  await pool.query(
    await readFile(new URL("../../migrations/001_foundation.sql", import.meta.url), "utf8"),
  );
  const app = buildApp(pool);
  t.after(() => app.close());
  assert.equal((await app.inject("/health")).statusCode, 200);
  assert.equal((await app.inject("/ready")).statusCode, 503);
});

test("readiness requires the profile columns used by authorized progress reads", async (t) => {
  const database = await isolatedDatabase(t);
  const pool = database.open();
  await migrate(pool);
  const app = buildApp(pool);
  t.after(() => app.close());
  assert.equal((await app.inject("/ready")).statusCode, 200);
  await pool.query("ALTER TABLE patients DROP COLUMN display_name");
  assert.equal((await app.inject("/ready")).statusCode, 503);
});
