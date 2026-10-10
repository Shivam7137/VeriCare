import assert from "node:assert/strict";
import test from "node:test";
import { migrate } from "../../src/migrations.js";
import { isolatedDatabase } from "./database.js";

test("backend migration installs identity, scheduler, workflow, operation, and outbox storage", async (t) => {
  const database = await isolatedDatabase(t);
  const pool = database.open();
  await migrate(pool);
  const result = await pool.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = current_schema()",
  );
  const tables = new Set(result.rows.map((row) => row.tablename));
  for (const name of [
    "principals",
    "sessions",
    "patients",
    "authority_grants",
    "authority_requests",
    "scheduler_slots",
    "scheduler_bookings",
    "scheduler_receipts",
    "workflow_tasks",
    "action_requests",
    "booking_operations",
    "communication_jobs",
    "mock_deliveries",
  ]) {
    assert.ok(tables.has(name), `missing backend table ${name}`);
  }
});
