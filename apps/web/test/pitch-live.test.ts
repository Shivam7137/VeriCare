import assert from "node:assert/strict";
import test from "node:test";
import { currentCall, dialable } from "../components/pitch-live";

const now = Date.parse("2026-10-10T18:00:00Z");
const call = (id: string, status: string, minutesAgo: number, mode = "twilio") => ({
  id,
  mode,
  status,
  maskedNumber: null,
  createdAt: new Date(now - minutesAgo * 60_000).toISOString(),
});

test("live panel follows a recent in-progress phone call", () => {
  const calls = [call("done", "completed", 1), call("live", "in_progress", 2)];
  assert.equal(currentCall(calls, now)?.id, "live");
});

test("live panel ignores stale, finished and simulated calls", () => {
  const calls = [
    call("stuck", "awaiting_verification", 90),
    call("done", "completed", 1),
    call("sim", "in_progress", 1, "simulated"),
  ];
  assert.equal(currentCall(calls, now), undefined);
});

test("demo line is grouped for reading aloud", () => {
  assert.equal(dialable("+12025550142"), "+1 202-555-0142");
  assert.equal(dialable("+447700900123"), "+447700900123");
});
