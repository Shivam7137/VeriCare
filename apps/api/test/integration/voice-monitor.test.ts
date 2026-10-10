import assert from "node:assert/strict";
import test from "node:test";
import fastify from "fastify";
import { workflowFixture } from "./workflow-fixture.js";
import { createSession } from "../../src/identity.js";
import { registerVoiceRoutes } from "../../src/voice-routes.js";
import { VoiceStore } from "../../src/voice-store.js";
import { VoiceMonitorStore } from "../../src/voice-monitor-store.js";

test("saved simulator tool inputs and results survive route restart and remain department-scoped", async (t) => {
  const f = await workflowFixture(t);
  const store = new VoiceStore(f.pool, { now: f.now });
  const code = await store.issueCode(f.patient);
  const call = await store.simulate(f.patient, code.code);
  const headers = async (id: string) => ({
    authorization: `Bearer ${(await createSession(f.pool, id, new Date(f.now().getTime() + 3600000), f.now())).token}`,
  });
  const app = fastify();
  registerVoiceRoutes(app, f.pool, { now: f.now });
  await app.ready();
  const ran = await app.inject({
    method: "POST",
    url: `/voice/calls/${call.id}/tool`,
    headers: await headers(f.patient.id),
    payload: { name: "list_appointments", arguments: {}, toolCallId: "monitor-tool-1" },
  });
  assert.equal(ran.statusCode, 200);
  await app.close();
  const reopened = fastify();
  registerVoiceRoutes(reopened, f.pool, { now: f.now });
  await reopened.ready();
  t.after(() => reopened.close());
  const url = `/voice/calls/${call.id}/monitor`;
  const response = await reopened.inject({ url, headers: await headers(f.staff.id) });
  assert.equal(response.statusCode, 200);
  const tool = response.json().entries.find((entry: any) => entry.kind === "tool");
  assert.equal(tool.label, "list_appointments");
  assert.equal(tool.status, "complete");
  assert.deepEqual(tool.details.arguments, {});
  assert.ok(tool.details.result);
  assert.equal((await reopened.inject({ url })).statusCode, 401);
  assert.equal(
    (await reopened.inject({ url, headers: await headers(f.patient.id) })).statusCode,
    403,
  );
  assert.equal(
    (await reopened.inject({ url, headers: await headers("synthetic-staff-other") })).statusCode,
    404,
  );
});

test("partial transcripts coalesce into durable turns in their first-observed order", async (t) => {
  const f = await workflowFixture(t);
  const calls = new VoiceStore(f.pool, { now: f.now });
  const code = await calls.issueCode(f.patient);
  const call = await calls.simulate(f.patient, code.code);
  const writer = new VoiceMonitorStore(f.pool);
  const turn = {
    id: "caller-a",
    kind: "transcript" as const,
    speaker: "caller" as const,
    label: "Caller",
    at: f.now().toISOString(),
    status: "streaming" as const,
    text: "First",
  };
  writer.capture(call.id, turn);
  writer.capture(call.id, { ...turn, id: "caller-b", text: "Second", status: "complete" });
  await writer.flush();
  writer.capture(call.id, { ...turn, text: "First turn finished late", status: "complete" });
  await writer.flush();
  const restored = await new VoiceMonitorStore(f.pool).read(call.id);
  assert.deepEqual(
    restored.entries.map((entry) => entry.text),
    ["First turn finished late", "Second"],
  );
  assert.equal(restored.entries.length, 2);
});

test("capture failures are visible and a later successful write preserves the gap warning", async (t) => {
  const f = await workflowFixture(t);
  const calls = new VoiceStore(f.pool, { now: f.now });
  const call = await calls.simulate(f.patient, (await calls.issueCode(f.patient)).code);
  const writer = new VoiceMonitorStore(f.pool);
  const entry = {
    id: "event-a",
    kind: "session" as const,
    label: "Connected",
    status: "info" as const,
    at: f.now().toISOString(),
  };
  const query = t.mock.method(f.pool, "query", async () => {
    throw new Error("database offline");
  });
  writer.capture(call.id, entry);
  await writer.flush();
  query.mock.restore();
  assert.match((await writer.read(call.id)).captureWarning!, /could not be saved/);
  writer.capture(call.id, { ...entry, id: "event-b", label: "Recovered" });
  await writer.flush();
  const restored = await new VoiceMonitorStore(f.pool).read(call.id);
  assert.ok(restored.entries.some((item) => item.id === "capture-warning"));
});
