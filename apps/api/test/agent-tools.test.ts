import assert from "node:assert/strict";
import test from "node:test";
import { interpretRequest } from "../src/agent-tools.js";

const availability = "2030-01-14T15:30:00Z/2030-01-14T17:00:00Z [America/Halifax]";
const callback = "2030-01-07T12:00:00Z/2030-01-07T13:00:00Z [America/Halifax]";

test("interpretation extracts explicit UTC intervals and time zones without changing instants", () => {
  const text = `Reschedule my appointment; availability: ${availability}; callback: ${callback}`;
  const result = interpretRequest(text);
  assert.deepEqual(result, {
    intent: "reschedule",
    availability: {
      startsAt: "2030-01-14T15:30:00Z",
      endsAt: "2030-01-14T17:00:00Z",
      timeZone: "America/Halifax",
    },
    callbackWindow: {
      startsAt: "2030-01-07T12:00:00Z",
      endsAt: "2030-01-07T13:00:00Z",
      timeZone: "America/Halifax",
    },
    clarifications: [],
    ready: true,
  });
  assert.deepEqual(interpretRequest(text), result);
});

test("relative dates and after-work requests require clarification without invented times", () => {
  for (const text of [
    "Move my appointment to Thursday afternoon and call after work.",
    "Reschedule my appointment; availability: Thursday afternoon; callback: after work",
  ]) {
    const result = interpretRequest(text);
    assert.equal(result.intent, "reschedule");
    assert.equal(result.availability, null);
    assert.equal(result.callbackWindow, null);
    assert.equal(result.ready, false);
    assert.equal(result.clarifications.length, 2);
  }
});

test("missing, invalid, reversed, local-offset and duplicate windows are never guessed", () => {
  for (const value of [
    "2030-01-14T15:30:00Z/2030-01-14T17:00:00Z",
    "2030-01-14T15:30:00Z/2030-01-14T17:00:00Z [Mars/Olympus]",
    "2030-01-14T15:30:00Z/2030-01-14T17:00:00Z [+04:00]",
    "2030-01-14T17:00:00Z/2030-01-14T15:30:00Z [UTC]",
    "2030-02-31T15:30:00Z/2030-02-31T17:00:00Z [UTC]",
    "2030-01-14T15:30:00-04:00/2030-01-14T17:00:00-04:00 [America/Halifax]",
    `${availability}; availability: ${availability}`,
  ]) {
    const result = interpretRequest(
      `Reschedule my appointment; availability: ${value}; callback: ${callback}`,
    );
    assert.equal(result.availability, null);
    assert.ok(result.callbackWindow);
    assert.equal(result.ready, false);
  }
});

test("unknown intent and overlapping callback windows produce explicit clarification", () => {
  const unknown = interpretRequest(`Hello; availability: ${availability}; callback: ${callback}`);
  assert.equal(unknown.intent, "unknown");
  assert.equal(unknown.ready, false);
  const overlap = interpretRequest(
    `Change my appointment; availability: ${availability}; callback: ${availability}`,
  );
  assert.equal(overlap.ready, false);
  assert.match(overlap.clarifications[0]!, /ends no later/);
});
