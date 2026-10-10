import assert from "node:assert/strict";
import test from "node:test";
import { isolatedDatabase } from "./database.js";

test("database URL options cannot override test isolation", async (t) => {
  const original = process.env.DATABASE_URL;
  assert.ok(original, "DATABASE_URL is required");
  const configured = new URL(original);
  configured.searchParams.set("options", "-c statement_timeout=7000 -c search_path=public");
  try {
    process.env.DATABASE_URL = configured.toString();
    const database = await isolatedDatabase(t);
    const pool = database.open();
    const result = await pool.query("SELECT current_schema() AS schema");
    assert.match(result.rows[0].schema, /^test_[a-f0-9]{32}$/);
    assert.equal((await pool.query("SHOW statement_timeout")).rows[0].statement_timeout, "7s");
  } finally {
    process.env.DATABASE_URL = original;
  }
});
