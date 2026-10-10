import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { buildApp } from "../src/app.js";

const unavailable = {
  query: async () => {
    throw new Error("database offline");
  },
} as unknown as Pick<Pool, "query">;

test("liveness remains available but readiness fails when the database is offline", async () => {
  const app = buildApp(unavailable);
  try {
    assert.equal((await app.inject("/health")).statusCode, 200);
    assert.equal((await app.inject("/ready")).statusCode, 503);
  } finally {
    await app.close();
  }
});

test("synthetic task endpoint is closed by default and arbitrary patient lookup is absent", async () => {
  const app = buildApp(unavailable);
  try {
    assert.equal((await app.inject("/demo/tasks/T001")).statusCode, 404);
    assert.equal((await app.inject("/tasks/someone-else")).statusCode, 404);
    assert.equal(
      (await app.inject({ method: "POST", url: "/tasks/T001/execute" })).statusCode,
      404,
    );
  } finally {
    await app.close();
  }
});
