import assert from "node:assert/strict";
import test from "node:test";
import * as contracts from "../src/index.js";

test("callback windows require explicit valid time zones and increasing UTC instants", () => {
  assert.ok(contracts.timeWindowSchema);
  const window = {
    startsAt: "2030-01-07T17:00:00Z",
    endsAt: "2030-01-07T18:00:00Z",
    timeZone: "America/Halifax",
  };
  assert.deepEqual(contracts.timeWindowSchema.parse(window), window);
  for (const timeZone of ["UTC", "Etc/GMT+4", "America/Argentina/Buenos_Aires"]) {
    assert.equal(contracts.timeWindowSchema.safeParse({ ...window, timeZone }).success, true);
  }
  for (const change of [
    { timeZone: "after work" },
    { timeZone: "+02:00" },
    { timeZone: "-0400" },
    { timeZone: "Mars/Olympus" },
    { endsAt: window.startsAt },
    { startsAt: "tomorrow" },
  ]) {
    assert.equal(contracts.timeWindowSchema.safeParse({ ...window, ...change }).success, false);
  }
});

test("decision and agent inputs reject client-provided completion and staff-approval tools", () => {
  assert.ok(contracts.decisionInputSchema);
  assert.ok(contracts.agentToolInputSchema);
  assert.equal(
    contracts.decisionInputSchema.safeParse({
      expectedRevision: 1,
      proposalVersion: 1,
      response: "approve",
      evidenceRef: "synthetic:consent",
      state: "completed",
    }).success,
    false,
  );
  assert.equal(
    contracts.agentToolInputSchema.safeParse({ tool: "complete", taskId: "T001" }).success,
    false,
  );
  assert.equal(
    contracts.agentToolInputSchema.safeParse({ tool: "approve_staff", taskId: "T001" }).success,
    false,
  );
});
