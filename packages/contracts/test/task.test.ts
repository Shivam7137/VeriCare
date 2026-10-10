import assert from "node:assert/strict";
import test from "node:test";
import { seededTask, taskSchema } from "../src/index.js";

test("fixture remains pending until access and callback requirements are satisfied", () => {
  assert.equal(taskSchema.parse(seededTask).state, "awaiting_verification");
});

test("contract rejects non-synthetic records and invalid task revisions", () => {
  assert.equal(taskSchema.safeParse({ ...seededTask, synthetic: false }).success, false);
  assert.equal(taskSchema.safeParse({ ...seededTask, revision: -1 }).success, false);
  assert.equal(taskSchema.safeParse({ ...seededTask, state: "call_finished" }).success, false);
});
