import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fastify from "fastify";
import twilio from "twilio";
import { createSession } from "../../src/identity.js";
import { readVoiceConfig, type VoiceConfig } from "../../src/voice-config.js";
import { registerVoiceRoutes } from "../../src/voice-routes.js";
import { VoiceStore } from "../../src/voice-store.js";
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
const sid = `CA${"2".repeat(32)}`;

async function fixture(t: TestContext, config: VoiceConfig = liveConfig) {
  const f = await workflowFixture(t);
  const app = fastify({ logger: false });
  registerVoiceRoutes(app, f.pool, { config, now: f.now });
  await app.ready();
  t.after(() => app.close());
  const token = async (actorId: string) => {
    const session = await createSession(
      f.pool,
      actorId,
      new Date(f.now().getTime() + 3_600_000),
      f.now(),
    );
    return { authorization: `Bearer ${session.token}` };
  };
  const headers = await token(f.patient.id);
  const store = new VoiceStore(f.pool, { now: f.now });
  const form = (patch: Record<string, string> = {}) => ({
    AccountSid: config.accountSid!,
    CallSid: sid,
    From: "+15555550102",
    To: config.phoneNumber!,
    ...patch,
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
  return { ...f, app, token, headers, store, signed, form };
}

test("voice API authenticates portal sessions, isolates patients and rejects unsupported or malformed tool actions", async (t) => {
  const f = await fixture(t, { ...liveConfig, mode: "simulated", liveEnabled: false });
  assert.equal((await f.app.inject({ url: "/voice/config" })).statusCode, 401);
  const readiness = await f.app.inject({ url: "/voice/config", headers: f.headers });
  assert.equal(readiness.statusCode, 200);
  assert.equal(readiness.json().mode, "simulated");
  for (const secret of [
    liveConfig.authToken!,
    liveConfig.openaiApiKey!,
    liveConfig.phoneNumber!,
    liveConfig.accountSid!,
  ]) {
    assert.equal(readiness.body.includes(secret), false);
  }
  const task = await f.service.create(f.patient, f.input);
  const issue = await f.app.inject({
    method: "POST",
    url: "/voice/access-codes",
    headers: f.headers,
    payload: { taskId: task.id },
  });
  assert.equal(issue.statusCode, 200);
  const simulated = await f.app.inject({
    method: "POST",
    url: "/voice/simulate",
    headers: f.headers,
    payload: { code: issue.json().code },
  });
  assert.equal(simulated.statusCode, 201);
  const callId: string = simulated.json().id;
  const foreignHeaders = await f.token(f.representative.id);
  assert.equal(
    (await f.app.inject({ url: `/voice/calls/${callId}`, headers: foreignHeaders })).statusCode,
    404,
  );
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url: `/voice/calls/${callId}/end`,
        headers: foreignHeaders,
        payload: {},
      })
    ).statusCode,
    404,
  );
  for (const payload of [
    { toolCallId: "not-allowed", name: "complete_booking", arguments: {} },
    { toolCallId: "malformed", name: "prepare_withdrawal", arguments: { state: "completed" } },
  ]) {
    const response = await f.app.inject({
      method: "POST",
      url: `/voice/calls/${callId}/tool`,
      headers: f.headers,
      payload,
    });
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json(), { error: "invalid_input" });
  }
  assert.deepEqual((await f.service.progress(f.patient, task.id)).task, task);
});

test("provider routes reject missing signatures, tampered forms and untrusted host signatures before persistence", async (t) => {
  const f = await fixture(t);
  const body = f.form();
  for (const headers of [
    {},
    {
      "x-twilio-signature": twilio.getExpectedTwilioSignature(
        liveConfig.authToken!,
        liveConfig.publicBaseUrl! + "/voice/incoming",
        { ...body, From: "+15555550999" },
      ),
    },
    {
      "x-twilio-signature": twilio.getExpectedTwilioSignature(
        liveConfig.authToken!,
        "https://attacker.example.com/voice/incoming",
        body,
      ),
      "x-forwarded-host": "attacker.example.com",
      host: "attacker.example.com",
    },
  ]) {
    const response = await f.app.inject({
      method: "POST",
      url: "/voice/incoming",
      headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams(body).toString(),
    });
    assert.equal(response.statusCode, 403);
    assert.deepEqual(response.json(), { error: "invalid_twilio_signature" });
  }
  assert.equal(Number((await f.pool.query("SELECT count(*) FROM voice_calls")).rows[0].count), 0);
});

test("signed inbound verification connects a bound stream and terminal callbacks cannot regress or complete a task", async (t) => {
  const f = await fixture(t);
  const task = await f.service.create(f.patient, f.input);
  const { code } = await f.store.issueCode(f.patient, task.id);
  const incoming = await f.signed("/voice/incoming", f.form());
  assert.equal(incoming.statusCode, 200);
  assert.match(incoming.headers["content-type"]!, /text\/xml/);
  assert.match(incoming.body, /<Gather/);
  assert.doesNotMatch(incoming.body, /<Stream/);
  await f.signed("/voice/incoming", f.form());
  assert.equal(Number((await f.pool.query("SELECT count(*) FROM voice_calls")).rows[0].count), 1);
  const verified = await f.signed("/voice/verify", f.form({ Digits: code }));
  assert.equal(verified.statusCode, 200);
  assert.match(verified.body, /<Connect><Stream/);
  const call = await f.store.bySid(sid);
  assert.ok(call);
  assert.equal(call.actorId, f.patient.id);
  assert.equal(call.taskId, task.id);
  const streamToken = /name="streamToken" value="([^"]+)"/.exec(verified.body)?.[1];
  assert.ok(streamToken);
  assert.equal(JSON.stringify(await f.store.get(f.patient, call.id)).includes(streamToken), false);
  const detail = JSON.stringify((await f.pool.query("SELECT detail FROM voice_events")).rows);
  assert.equal(detail.includes(code), false);
  assert.equal(detail.includes(streamToken), false);
  const statusUrl = `/voice/status?callId=${call.id}`;
  assert.equal((await f.signed(statusUrl, f.form({ CallStatus: "completed" }))).statusCode, 204);
  assert.equal((await f.signed(statusUrl, f.form({ CallStatus: "completed" }))).statusCode, 204);
  assert.equal((await f.signed(statusUrl, f.form({ CallStatus: "ringing" }))).statusCode, 204);
  assert.equal((await f.store.getInternal(call.id)).status, "completed");
  const afterHangup = await f.signed("/voice/verify", f.form({ Digits: code }));
  assert.match(afterHangup.body, /<Hangup/);
  assert.doesNotMatch(afterHangup.body, /<Gather|<Stream/);
  assert.equal(
    (await f.signed(statusUrl, f.form({ CallSid: `CA${"3".repeat(32)}`, CallStatus: "completed" })))
      .statusCode,
    403,
  );
  assert.deepEqual((await f.service.progress(f.patient, task.id)).task, task);
  assert.equal(
    Number(
      (
        await f.pool.query(
          "SELECT count(*) FROM voice_events WHERE call_id=$1 AND kind='provider_status'",
          [call.id],
        )
      ).rows[0].count,
    ),
    1,
  );
});

test("inbound allowlist and five failed access-code attempts prevent unauthorized streams", async (t) => {
  const f = await fixture(t);
  const denied = await f.signed("/voice/incoming", f.form({ From: "+15555550999" }));
  assert.equal(denied.statusCode, 200);
  assert.match(denied.body, /<Hangup/);
  assert.doesNotMatch(denied.body, /<Gather|<Stream/);
  assert.equal(await f.store.bySid(sid), null);
  await f.signed("/voice/incoming", f.form());
  for (let attempt = 1; attempt <= 5; attempt++) {
    const response = await f.signed("/voice/verify", f.form({ Digits: "invalid" }));
    assert.equal(response.statusCode, 200);
    assert.doesNotMatch(response.body, /<Stream/);
    if (attempt < 5) assert.match(response.body, /<Gather/);
    else assert.doesNotMatch(response.body, /<Gather/);
  }
  const call = await f.store.bySid(sid);
  assert.equal(call?.status, "failed");
  const { code } = await f.store.issueCode(f.patient);
  const locked = await f.signed("/voice/verify", f.form({ Digits: code }));
  assert.doesNotMatch(locked.body, /<Gather|<Stream/);
  assert.equal((await f.store.bySid(sid))?.actorId, null);
});

test("wildcard callers still require signed webhooks and a valid portal access code", async (t) => {
  const f = await fixture(t, { ...liveConfig, allowedNumbers: ["*"] });
  const body = f.form({ From: "+15555550999" });
  const unsigned = await f.app.inject({ method: "POST", url: "/voice/incoming", payload: body });
  assert.equal(unsigned.statusCode, 403);
  const incoming = await f.signed("/voice/incoming", body);
  assert.match(incoming.body, /<Gather/);
  assert.doesNotMatch(incoming.body, /<Stream/);
  const wrongCode = await f.signed("/voice/verify", { ...body, Digits: "invalid" });
  assert.doesNotMatch(wrongCode.body, /<Stream/);
  const { code } = await f.store.issueCode(f.patient);
  const verified = await f.signed("/voice/verify", { ...body, Digits: code });
  assert.match(verified.body, /<Connect><Stream/);
});

test("outbound TwiML reconciles an uncertain dispatch and tolerates answered status before verification", async (t) => {
  const f = await fixture(t);
  let task = await f.service.create(f.patient, f.input);
  task = await f.service.verify(f.patient, task.id, { expectedRevision: task.revision });
  const call = await f.store.scheduleCallback(f.patient, {
    taskId: task.id,
    to: "+15555550102",
    dueAt: "2030-01-07T12:01:00.000Z",
    mode: "twilio",
  });
  f.setNow(new Date("2030-01-07T12:01:00.000Z"));
  assert.equal((await f.store.claimDue()).length, 1);
  await f.store.markDispatchFailed(call.id, "call_dispatch_uncertain", true);
  assert.equal((await f.store.getInternal(call.id)).status, "reconciling");
  const recovered = await f.signed(`/voice/outbound/${call.id}`, f.form());
  assert.equal(recovered.statusCode, 200);
  assert.match(recovered.body, /<Gather/);
  assert.equal((await f.store.getInternal(call.id)).providerSid, sid);
  assert.equal(
    (await f.signed(`/voice/status?callId=${call.id}`, f.form({ CallStatus: "in-progress" })))
      .statusCode,
    204,
  );
  assert.equal((await f.store.getInternal(call.id)).status, "awaiting_verification");
  const response = await f.signed(`/voice/outbound/${call.id}`, f.form());
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /<Gather/);
  assert.doesNotMatch(response.body, /<Stream/);
  await assert.rejects(f.store.bound(call.id), { code: "voice_unverified" });
});
