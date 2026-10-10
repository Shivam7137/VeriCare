import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { workflowFixture } from "./workflow-fixture.js";

async function warmPool(pool: Pool) {
  assert.equal(pool.options.max, 5, "This regression must exercise a five-connection pool");
  const clients = await Promise.all(Array.from({ length: 5 }, () => pool.connect()));
  for (const client of clients) client.release();
}

function fulfilled<T>(results: PromiseSettledResult<T>[]) {
  return results.map((result) => {
    if (result.status !== "fulfilled") {
      assert.fail(`Every operation must complete within the pool limit: ${String(result.reason)}`);
    }
    return result.value;
  });
}

test("five concurrent task creations reuse their transaction connections for booking reads", async (t) => {
  const f = await workflowFixture(t);
  await warmPool(f.pool);
  const tasks = fulfilled(
    await Promise.allSettled(Array.from({ length: 5 }, () => f.service.create(f.patient, f.input))),
  );
  assert.equal(new Set(tasks.map((task) => task.id)).size, 5);
  assert.ok(tasks.every((task) => task.state === "awaiting_verification"));
  const saved = await f.pool.query("SELECT id FROM tasks WHERE id = ANY($1::text[])", [
    tasks.map((task) => task.id),
  ]);
  assert.equal(saved.rowCount, 5);
});

test("five concurrent proposals reuse their transaction connections for slot and booking reads", async (t) => {
  const f = await workflowFixture(t);
  const tasks = [];
  for (let index = 0; index < 5; index += 1) {
    const created = await f.service.create(f.patient, f.input);
    tasks.push(
      await f.service.verify(f.patient, created.id, { expectedRevision: created.revision }),
    );
  }
  await warmPool(f.pool);
  const proposals = fulfilled(
    await Promise.allSettled(
      tasks.map((task) =>
        f.service.propose(f.staff, task.id, {
          expectedRevision: task.revision,
          slotId: "synthetic-slot-002",
          expiresAt: new Date(f.now().getTime() + 7_200_000).toISOString(),
        }),
      ),
    ),
  );
  assert.equal(proposals.length, 5);
  assert.ok(proposals.every((task) => task.state === "awaiting_staff_approval"));
  const saved = await f.pool.query(
    "SELECT task_id FROM proposal_drafts WHERE task_id = ANY($1::text[])",
    [tasks.map((task) => task.id)],
  );
  assert.equal(saved.rowCount, 5);
  assert.equal((await f.scheduler.getBooking(f.input.appointmentId))?.version, "1");
});
