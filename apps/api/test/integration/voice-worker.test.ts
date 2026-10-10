import assert from "node:assert/strict";
import test from "node:test";
import { readVoiceConfig } from "../../src/voice-config.js";
import { VoiceStore } from "../../src/voice-store.js";
import { runVoiceWorker } from "../../src/voice-worker.js";
import { TwilioDispatchError } from "../../src/twilio-provider.js";
import { workflowFixture } from "./workflow-fixture.js";

const liveConfig = readVoiceConfig({
  VOICE_MODE: "twilio",
  VOICE_LIVE_ENABLED: "true",
  TWILIO_ACCOUNT_SID: `AC${"1".repeat(32)}`,
  TWILIO_AUTH_TOKEN: "synthetic-auth-token",
  TWILIO_PHONE_NUMBER: "+15555550101",
  OPENAI_API_KEY: "synthetic-openai-key",
  VOICE_PUBLIC_BASE_URL: "https://voice.example.com",
  VOICE_ALLOWED_NUMBERS: "+15555550102",
});

async function schedule(
  f: Awaited<ReturnType<typeof workflowFixture>>,
  mode: "simulated" | "twilio",
) {
  const store = new VoiceStore(f.pool, { now: f.now });
  let task = await f.service.create(f.patient, f.input);
  task = await f.service.verify(f.patient, task.id, { expectedRevision: task.revision });
  const call = await store.scheduleCallback(f.patient, {
    taskId: task.id,
    to: "+15555550102",
    dueAt: "2030-01-07T12:01:00.000Z",
    mode,
  });
  return { store, task, call };
}

test("simulated callbacks ring once without provider I/O and still require portal-code verification", async (t) => {
  const f = await workflowFixture(t);
  const { store, task, call } = await schedule(f, "simulated");
  let attempts = 0;
  const provider = {
    async createCall() {
      attempts++;
      throw new Error("Provider must not be called");
    },
  };
  assert.deepEqual(
    await runVoiceWorker(f.pool, { config: readVoiceConfig({}), now: f.now, provider }),
    [],
  );
  f.setNow(new Date("2030-01-07T12:01:00.000Z"));
  assert.deepEqual(
    await runVoiceWorker(f.pool, { config: readVoiceConfig({}), now: f.now, provider }),
    [{ id: call.id, status: "ringing" }],
  );
  assert.deepEqual(
    await runVoiceWorker(f.pool, { config: readVoiceConfig({}), now: f.now, provider }),
    [],
  );
  assert.equal(attempts, 0);
  await assert.rejects(store.bound(call.id), { code: "voice_unverified" });
  const { code } = await store.issueCode(f.patient, task.id);
  assert.equal((await store.verifyCode(call.id, code)).status, "in_progress");
  assert.equal((await f.service.progress(f.patient, task.id)).task.state, task.state);
});

test("uncertain call creation persists reconciliation and is never blindly dispatched again", async (t) => {
  const f = await workflowFixture(t);
  const { store, call } = await schedule(f, "twilio");
  let attempts = 0;
  const provider = {
    async createCall() {
      attempts++;
      throw new TwilioDispatchError("uncertain");
    },
  };
  f.setNow(new Date("2030-01-07T12:01:00.000Z"));
  assert.deepEqual(await runVoiceWorker(f.pool, { config: liveConfig, now: f.now, provider }), [
    { id: call.id, status: "reconciling" },
  ]);
  assert.equal((await store.getInternal(call.id)).lastError, "call_dispatch_uncertain");
  f.setNow(new Date("2030-01-07T12:03:00.000Z"));
  assert.deepEqual(await runVoiceWorker(f.pool, { config: liveConfig, now: f.now, provider }), []);
  assert.equal(attempts, 1);
  assert.equal((await store.getInternal(call.id)).status, "reconciling");
});

test("callbacks outside the agreed window are cancelled before any provider dispatch", async (t) => {
  const f = await workflowFixture(t);
  const { store, call } = await schedule(f, "twilio");
  let attempts = 0;
  const provider = {
    async createCall() {
      attempts++;
      throw new Error("Provider must not be called");
    },
  };
  f.setNow(new Date(f.input.callbackWindow.endsAt));
  assert.deepEqual(await runVoiceWorker(f.pool, { config: liveConfig, now: f.now, provider }), []);
  assert.equal(attempts, 0);
  assert.equal((await store.getInternal(call.id)).status, "cancelled");
  assert.equal((await store.getInternal(call.id)).lastError, "outside_callback_window");
});

test("worker rechecks each callback window after the preceding provider response", async (t) => {
  const f = await workflowFixture(t);
  const first = await schedule(f, "twilio");
  const second = await schedule(f, "twilio");
  let attempts = 0;
  const provider = {
    async createCall() {
      attempts++;
      f.setNow(new Date(f.input.callbackWindow.endsAt));
      return { sid: `CA${"3".repeat(32)}`, status: "queued" as const };
    },
  };
  f.setNow(new Date("2030-01-07T12:01:00.000Z"));
  const result = await runVoiceWorker(f.pool, { config: liveConfig, now: f.now, provider });
  assert.equal(result.length, 1);
  assert.equal(attempts, 1);
  const calls = await Promise.all([
    first.store.getInternal(first.call.id),
    second.store.getInternal(second.call.id),
  ]);
  assert.deepEqual(calls.map((call) => call.status).sort(), ["cancelled", "ringing"]);
  assert.equal(
    calls.find((call) => call.status === "cancelled")?.lastError,
    "outside_callback_window",
  );
});

test("an obsolete callback does not block the next eligible callback in the same worker pass", async (t) => {
  const f = await workflowFixture(t);
  const first = await schedule(f, "simulated");
  const second = await schedule(f, "simulated");
  await f.pool.query("UPDATE voice_calls SET due_at=$2 WHERE id=$1", [
    first.call.id,
    "2030-01-07T12:00:30.000Z",
  ]);
  await f.service.withdraw(f.patient, first.task.id, {
    expectedRevision: first.task.revision,
    evidenceRef: "synthetic-withdrawal",
  });
  f.setNow(new Date("2030-01-07T12:01:00.000Z"));
  assert.deepEqual(await runVoiceWorker(f.pool, { config: readVoiceConfig({}), now: f.now }), [
    { id: second.call.id, status: "ringing" },
  ]);
  assert.equal((await first.store.getInternal(first.call.id)).status, "cancelled");
});
