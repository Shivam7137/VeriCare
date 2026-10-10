import assert from "node:assert/strict";
import test from "node:test";
import { seededTask } from "@prc/contracts";
import { createPool } from "../../src/db.js";
import { migrate } from "../../src/migrations.js";
import { seed } from "../../src/fixtures.js";
import { buildApp } from "../../src/app.js";

test("migrations and seeds repeat safely; T001 and history survive a new connection pool", async () => {
  const first = createPool();
  try {
    await migrate(first);
    await migrate(first);
    await seed(first);
    await seed(first);
  } finally {
    await first.end();
  }

  const restarted = createPool();
  const app = buildApp(restarted, true);
  try {
    assert.equal((await app.inject("/ready")).statusCode, 200);
    const response = await app.inject("/demo/tasks/T001");
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), seededTask);
    const events = await restarted.query("SELECT * FROM task_events WHERE task_id = $1", ["T001"]);
    assert.equal(events.rowCount, 1);
    assert.equal(events.rows[0].evidence_ref, "fixture:T001");
  } finally {
    await app.close();
    await restarted.end();
  }
});
