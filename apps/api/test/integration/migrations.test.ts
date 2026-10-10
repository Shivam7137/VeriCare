import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { migrate } from "../../src/migrations.js";
import { seed } from "../../src/fixtures.js";
import { isolatedDatabase } from "./database.js";

test("migration upgrades a foundation database without changing saved tasks or events", async (t) => {
  const database = await isolatedDatabase(t);
  const pool = database.open();
  await pool.query(
    await readFile(new URL("../../migrations/001_foundation.sql", import.meta.url), "utf8"),
  );
  await pool.query("CREATE TABLE schema_migrations (name text PRIMARY KEY)");
  await pool.query("INSERT INTO schema_migrations VALUES ('001_foundation.sql')");
  await seed(pool);
  const tasks = (await pool.query("SELECT * FROM tasks")).rows;
  const events = (await pool.query("SELECT * FROM task_events")).rows;

  await migrate(pool);
  await migrate(pool);

  const applied = (await pool.query("SELECT name FROM schema_migrations ORDER BY name")).rows;
  assert.deepEqual(
    applied.map((row) => row.name),
    ["001_foundation.sql", "002_proposal_drafts.sql"],
  );
  assert.deepEqual((await pool.query("SELECT * FROM tasks")).rows, tasks);
  assert.deepEqual((await pool.query("SELECT * FROM task_events")).rows, events);
  assert.equal((await pool.query("SELECT * FROM proposal_drafts")).rowCount, 0);
});
