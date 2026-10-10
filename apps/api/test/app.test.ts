import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { buildApp } from "../src/app.js";

const unavailable = {
  query: async () => {
    throw new Error("database offline");
  },
} as unknown as Pool;

test("liveness remains available but readiness fails when the database is offline", async () => {
  const app = buildApp(unavailable);
  try {
    assert.equal((await app.inject("/health")).statusCode, 200);
    assert.equal((await app.inject("/ready")).statusCode, 503);
  } finally {
    await app.close();
  }
});

test("synthetic task endpoint is closed by default and task routes require authentication", async () => {
  const app = buildApp(unavailable);
  try {
    assert.equal((await app.inject("/demo/tasks/T001")).statusCode, 404);
    assert.equal((await app.inject("/demo/tasks/T001/proposals")).statusCode, 404);
    assert.equal((await app.inject("/demo/tasks/T001/events")).statusCode, 404);
    assert.equal((await app.inject("/tasks/someone-else")).statusCode, 401);
    assert.equal(
      (await app.inject({ method: "POST", url: "/tasks/T001/execute" })).statusCode,
      401,
    );
  } finally {
    await app.close();
  }
});

test("demo history routes report unavailable storage without returning database details", async () => {
  const app = buildApp(unavailable, true);
  try {
    for (const path of ["proposals", "events"]) {
      const response = await app.inject(`/demo/tasks/T001/${path}`);
      assert.equal(response.statusCode, 503);
      assert.deepEqual(response.json(), { error: "Synthetic task storage is unavailable." });
    }
    assert.equal((await app.inject("/demo/tasks/someone-else/events")).statusCode, 404);
    assert.equal(
      (await app.inject({ method: "POST", url: "/demo/tasks/T001/proposals", payload: {} }))
        .statusCode,
      404,
    );
  } finally {
    await app.close();
  }
});
