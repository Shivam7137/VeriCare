import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fastify from "fastify";
import twilio from "twilio";
import { workflowFixture } from "./workflow-fixture.js";
import { createSession, getPrincipal } from "../../src/identity.js";
import { registerVoiceRoutes } from "../../src/voice-routes.js";
import { readVoiceConfig } from "../../src/voice-config.js";
import { VoiceAgent, voiceAgentTools } from "../../src/voice-agent.js";
import { harness, keypad, outputAudio, settle, toolCall } from "../realtime-bridge-fixtures.js";

const config = readVoiceConfig({
  VOICE_MODE: "twilio",
  VOICE_LIVE_ENABLED: "true",
  TWILIO_ACCOUNT_SID: `AC${"1".repeat(32)}`,
  TWILIO_AUTH_TOKEN: "synthetic-token",
  TWILIO_PHONE_NUMBER: "+15555550101",
  OPENAI_API_KEY: "synthetic-key",
  VOICE_PUBLIC_BASE_URL: "https://voice.example.com",
  VOICE_ALLOWED_NUMBERS: "*",
});
const parentSid = `CA${"5".repeat(32)}`,
  childSid = `CA${"6".repeat(32)}`;
async function fixture(t: TestContext) {
  const f = await workflowFixture(t);
  let attempts = 0;
  const provider = {
    async transfer() {
      attempts++;
    },
  };
  const agent = new VoiceAgent(f.pool, {
    now: f.now,
    ownNumber: config.phoneNumber,
    transferProvider: provider,
  });
  const app = fastify({ logger: false });
  registerVoiceRoutes(app, f.pool, { config, now: f.now, transferProvider: provider });
  await app.ready();
  t.after(() => app.close());
  const headers = async (id: string) => ({
    authorization: `Bearer ${(await createSession(f.pool, id, new Date(f.now().getTime() + 3_600_000), f.now())).token}`,
  });
  const signed = (url: string, body: Record<string, string>) =>
    app.inject({
      method: "POST",
      url,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": twilio.getExpectedTwilioSignature(
          config.authToken!,
          config.publicBaseUrl! + url,
          body,
        ),
      },
      payload: new URLSearchParams(body).toString(),
    });
  return { ...f, app, agent, headers, signed, attempts: () => attempts };
}
test("authenticated directory and staff simulator operate in Twilio mode while live confirmation requires keypad", async (t) => {
  const f = await fixture(t),
    headers = await f.headers(f.staff.id);
  assert.equal((await f.app.inject({ url: "/voice/directory" })).statusCode, 401);
  const directory = await f.app.inject({
    url: `/voice/directory?patientId=${f.patient.patientId}&doctor=true`,
    headers,
  });
  assert.equal(directory.json().selection, "resolved");
  assert.equal(directory.json().members[0].configured, false);
  const code = await f.app.inject({
    method: "POST",
    url: "/voice/access-codes",
    headers,
    payload: {},
  });
  const sim = await f.app.inject({
    method: "POST",
    url: "/voice/simulate",
    headers,
    payload: { code: code.json().code },
  });
  assert.equal(sim.statusCode, 201);
  assert.equal(sim.json().mode, "simulated");
  const callId = sim.json().id;
  const prepare = await f.app.inject({
    method: "POST",
    url: `/voice/calls/${callId}/transfers`,
    headers,
    payload: { memberId: "synthetic-staff-001", patientId: f.patient.patientId },
  });
  assert.equal(prepare.statusCode, 201);
  const confirm = await f.app.inject({
    method: "POST",
    url: `/voice/calls/${callId}/confirm`,
    headers,
    payload: { actionId: prepare.json().pendingAction.id },
  });
  assert.equal(confirm.json().transfer.status, "dialing");
  const result = await f.app.inject({
    method: "POST",
    url: `/voice/transfers/${confirm.json().transfer.id}/simulate-result`,
    headers,
    payload: { status: "no-answer" },
  });
  assert.equal(result.json().status, "no-answer");
  assert.equal(f.attempts(), 0);
  const operator = await f.headers("synthetic-operator-001");
  assert.equal(
    (
      await f.app.inject({
        method: "PATCH",
        url: "/voice/directory/synthetic-staff-001",
        headers: operator,
        payload: { phoneNumber: null, expectedRevision: 1 },
      })
    ).statusCode,
    403,
  );
  const foreign = await f.headers("synthetic-staff-other");
  assert.equal(
    (
      await f.app.inject({
        method: "PATCH",
        url: "/voice/directory/synthetic-staff-001",
        headers: foreign,
        payload: { phoneNumber: null, expectedRevision: 1 },
      })
    ).statusCode,
    404,
  );
  const updated = await f.app.inject({
    method: "PATCH",
    url: "/voice/directory/synthetic-staff-001",
    headers,
    payload: { phoneNumber: "+15555550103", expectedRevision: 1 },
  });
  assert.equal(updated.json().revision, 2);
  assert.equal(
    (
      await f.app.inject({
        method: "PATCH",
        url: "/voice/directory/synthetic-staff-001",
        headers,
        payload: { phoneNumber: null, expectedRevision: 1 },
      })
    ).statusCode,
    409,
  );
  const live = await f.agent.store.beginInbound({ sid: parentSid, from: "+15555550102" });
  await f.agent.store.verifyCode(live.id, (await f.agent.store.issueCode(f.staff)).code);
  const action = await f.agent.transfers.prepare(live.id, { memberId: "synthetic-staff-001" });
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url: `/voice/calls/${live.id}/confirm`,
        headers,
        payload: { actionId: action.pendingAction.id },
      })
    ).statusCode,
    403,
  );
  assert.equal(f.attempts(), 0);
  const staffSid = `CA${"8".repeat(32)}`;
  const form = {
    AccountSid: config.accountSid!,
    CallSid: staffSid,
    From: "+15555550102",
    To: config.phoneNumber!,
  };
  assert.equal((await f.signed("/voice/incoming", form)).statusCode, 200);
  const staffCode = (await f.agent.store.issueCode(f.staff)).code;
  const verified = await f.signed("/voice/verify", { ...form, Digits: staffCode });
  assert.equal(verified.statusCode, 200);
  assert.match(verified.body, /<Connect><Stream/);
});
for (const [dialStatus, expected] of [
  ["completed", "connected"],
  ["no-answer", "no-answer"],
  ["busy", "busy"],
  ["failed", "failed"],
] as const) {
  test(`signed Dial ${dialStatus} result records ${expected}, survives stream close and never changes appointment`, async (t) => {
    const f = await fixture(t);
    const task = await f.proposed();
    await f.agent.directory.update(f.staff, "synthetic-staff-001", {
      phoneNumber: "+15555550103",
      expectedRevision: 1,
    });
    const call = await f.agent.store.beginInbound({ sid: parentSid, from: "+15555550102" });
    await f.agent.store.verifyCode(
      call.id,
      (await f.agent.store.issueCode(f.patient, task.id)).code,
    );
    const prepared = (await f.agent.run(call.id, "transfer-tool", "prepare_transfer", {
      memberId: "synthetic-staff-001",
    })) as { pendingAction: { id: string } };
    await f.agent.digit(call.id, "1", prepared.pendingAction.id);
    assert.equal(f.attempts(), 1);
    await f.agent.store.streamClosed(call.id, "twilio_stop");
    assert.equal((await f.agent.store.getInternal(call.id)).status, "transferring");
    // Parent in-progress/ringing callbacks must not resume AI while Dial runs.
    await f.agent.store.statusCallback(call.id, parentSid, "in-progress");
    assert.equal((await f.agent.store.getInternal(call.id)).status, "transferring");
    const path = `/voice/transfers/${prepared.pendingAction.id}/result`;
    const body = {
      AccountSid: config.accountSid!,
      CallSid: parentSid,
      DialCallSid: childSid,
      DialCallStatus: dialStatus,
    };
    const unsigned = await f.app.inject({
      method: "POST",
      url: path,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams(body).toString(),
    });
    assert.equal(unsigned.statusCode, 403);
    assert.equal(
      (await f.signed(path, { ...body, CallSid: `CA${"7".repeat(32)}` })).statusCode,
      403,
    );
    const result = await f.signed(path, body);
    assert.equal(result.statusCode, 200);
    assert.match(result.body, /<Say>/);
    if (expected !== "connected")
      assert.match(result.body, /did not answer|was busy|could not connect/);
    assert.equal((await f.signed(path, body)).statusCode, 200);
    assert.equal((await f.agent.transfers.list(f.patient, call.id))[0]!.status, expected);
    assert.equal((await f.agent.store.getInternal(call.id)).events, undefined);
    const publicCall = await f.agent.store.get(f.patient, call.id);
    assert.equal(publicCall.events!.filter((event) => event.kind === "transfer_result").length, 1);
    assert.deepEqual((await f.service.progress(f.patient, task.id)).task, task);
    assert.equal((await f.scheduler.getBooking(f.input.appointmentId))!.version, "1");
    const liveResult = await f.app.inject({
      method: "POST",
      url: `/voice/transfers/${prepared.pendingAction.id}/simulate-result`,
      headers: await f.headers(f.patient.id),
      payload: { status: "connected" },
    });
    assert.equal(liveResult.statusCode, 403);
    assert.equal(f.attempts(), 1);
  });
}
test("assigned doctor lookup surfaces ambiguity and refuses missing staff patient context", async (t) => {
  const f = await fixture(t);
  await f.pool.query(
    "INSERT INTO patient_care_team(patient_id,member_id) VALUES ($1,'demo-staff-daniel-morris')",
    [f.patient.patientId],
  );
  const directory = await f.agent.directory.list(f.staff, {
    patientId: f.patient.patientId!,
    doctor: true,
  });
  assert.equal(directory.selection, "ambiguous");
  assert.equal(directory.members.length, 2);
  await assert.rejects(f.agent.directory.list(f.staff, { doctor: true }), {
    code: "patient_required",
  });
  const other = await getPrincipal(f.pool, "synthetic-staff-other");
  await assert.rejects(f.agent.directory.list(other, { patientId: f.patient.patientId! }), {
    code: "not_found",
  });
});

test("live keypad approval is bound to played action A when portal replaces it with unread B", async (t) => {
  const f = await fixture(t);
  await f.agent.directory.update(f.staff, "synthetic-staff-001", {
    phoneNumber: "+15555550103",
    expectedRevision: 1,
  });
  await f.agent.directory.update(f.staff, "demo-staff-daniel-morris", {
    phoneNumber: "+15555550104",
    expectedRevision: 1,
  });
  const call = await f.agent.store.beginInbound({ sid: parentSid, from: "+15555550102" });
  await f.agent.store.verifyCode(call.id, (await f.agent.store.issueCode(f.staff)).code);
  let prepared!: () => void, confirmed!: () => void;
  const preparedPromise = new Promise<void>((resolve) => {
    prepared = resolve;
  });
  const confirmationPromise = new Promise<void>((resolve) => {
    confirmed = resolve;
  });
  const h = harness({
    tools: voiceAgentTools,
    verifyStart: async () => ({ callId: call.id }),
    onTool: async (name, args, callId, toolId) => {
      const result = await f.agent.run(callId, toolId, name, args);
      prepared();
      return result;
    },
    onDigit: async (digit, callId, actionId?: string) => {
      try {
        return await f.agent.digit(callId, digit, actionId);
      } finally {
        confirmed();
      }
    },
  });
  t.after(() => h.controller.close());
  await h.connect();
  h.upstream.receive({ type: "response.created", response: { id: "response-tool" } });
  h.upstream.receive(
    toolCall(JSON.stringify({ memberId: "synthetic-staff-001" }), "prepare-A", "prepare_transfer"),
  );
  await preparedPromise;
  await settle();
  const actionA = (await f.agent.store.getInternal(call.id)).pendingAction!;
  h.upstream.receive({
    type: "response.done",
    response: { id: "response-tool", status: "completed" },
  });
  h.upstream.receive({ type: "response.created", response: { id: "readback-A" } });
  outputAudio(h, "readback-item-A", "readback-A");
  h.upstream.receive({
    type: "response.done",
    response: { id: "readback-A", status: "completed" },
  });
  const mark = h.twilio.events("mark")[0]!.mark.name;
  h.twilio.receive({ event: "mark", streamSid: "MZsynthetic", mark: { name: mark } });
  const headers = await f.headers(f.staff.id);
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url: `/voice/calls/${call.id}/cancel`,
        headers,
        payload: {},
      })
    ).statusCode,
    200,
  );
  const replacement = await f.app.inject({
    method: "POST",
    url: `/voice/calls/${call.id}/transfers`,
    headers,
    payload: { memberId: "demo-staff-daniel-morris" },
  });
  assert.equal(replacement.statusCode, 201);
  const actionB = replacement.json().pendingAction;
  assert.notEqual(actionA.id, actionB.id);
  h.twilio.receive(keypad("4"));
  await confirmationPromise;
  await settle();
  assert.equal(f.attempts(), 0, "unread replacement must never dispatch");
  assert.equal((await f.agent.store.getInternal(call.id)).pendingAction!.id, actionB.id);
  assert.equal(
    (await f.agent.transfers.list(f.staff, call.id)).find((transfer) => transfer.id === actionB.id)!
      .status,
    "prepared",
  );
});
