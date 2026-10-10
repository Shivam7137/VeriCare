import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { BackendError } from "../../src/domain.js";
import { getPrincipal } from "../../src/identity.js";
import { VoiceSms } from "../../src/voice-sms.js";
import { VoiceStore, type PendingVoiceAction } from "../../src/voice-store.js";
import { workflowFixture } from "./workflow-fixture.js";

const rejected = (code: string) => (error: unknown) =>
  error instanceof BackendError && error.code === code;
const caller = "+15005550006";

test("guest media connects without granting authority to protected request operations", async (t) => {
  const f = await workflowFixture(t);
  const store = new VoiceStore(f.pool, { now: f.now });
  const call = await store.beginInbound({ sid: "CA-guest", from: caller });
  const { token } = await store.issueStream(call.id);
  assert.deepEqual(await store.claimStream(call.id, token, "CA-guest"), { callId: call.id });
  const session = await store.sessionState(call.id);
  assert.equal(session.verified, false);
  assert.equal(session.call.status, "awaiting_verification");
  assert.equal(session.call.actorId, null);
  assert.equal(session.call.authorizationRequestedAt, null);
  const task = await f.service.create(f.patient, f.input);
  const pending: PendingVoiceAction = {
    id: randomUUID(),
    kind: "withdraw",
    input: { expectedRevision: task.revision },
    description: "Withdraw this request.",
    expiresAt: new Date(f.now().getTime() + 60_000).toISOString(),
  };
  await assert.rejects(store.bound(call.id), rejected("voice_unverified"));
  await assert.rejects(store.attachTask(call.id, task.id), rejected("voice_unverified"));
  await assert.rejects(store.setPending(call.id, pending), rejected("voice_unverified"));
  await assert.rejects(store.consumePending(call.id, pending.id), rejected("voice_unverified"));
  await assert.rejects(store.issueStream(call.id), rejected("stream_already_connected"));
  assert.equal((await store.streamClosed(call.id, "caller_disconnected")).status, "completed");
  assert.equal((await store.sessionState(call.id)).call.status, "completed");
  await assert.rejects(store.issueStream(call.id), rejected("call_ended"));
});

test("guest stream tickets still enforce provider identity, expiry, and single use", async (t) => {
  const f = await workflowFixture(t);
  const store = new VoiceStore(f.pool, { now: f.now });
  const call = await store.beginInbound({ sid: "CA-guest-ticket", from: caller });
  const first = await store.issueStream(call.id);
  await assert.rejects(
    store.claimStream(call.id, first.token, "CA-other"),
    rejected("invalid_stream_token"),
  );
  f.setNow(new Date(f.now().getTime() + 300_000));
  await assert.rejects(
    store.claimStream(call.id, first.token, "CA-guest-ticket"),
    rejected("invalid_stream_token"),
  );
  const fresh = await store.issueStream(call.id);
  await store.claimStream(call.id, fresh.token, "CA-guest-ticket");
  await assert.rejects(
    store.claimStream(call.id, fresh.token, "CA-guest-ticket"),
    rejected("invalid_stream_token"),
  );
  await store.end(call.id, "hangup");
  await assert.rejects(store.requestAuthorization(call.id), rejected("call_ended"));
});

test("authorization is requested explicitly and a later code verifies the same active conversation", async (t) => {
  const f = await workflowFixture(t);
  const store = new VoiceStore(f.pool, { now: f.now });
  const call = await store.beginInbound({ sid: "CA-delayed-auth", from: caller });
  const { token } = await store.issueStream(call.id);
  await store.claimStream(call.id, token, "CA-delayed-auth");
  assert.equal((await store.sessionState(call.id)).call.authorizationRequestedAt, null);
  f.setNow(new Date(f.now().getTime() + 60_000));
  const challenged = await store.requestAuthorization(call.id);
  assert.equal(challenged.authorizationRequestedAt, f.now().toISOString());
  assert.equal(challenged.actorId, null);
  assert.equal(challenged.status, "awaiting_verification");
  f.setNow(new Date(f.now().getTime() + 10_000));
  assert.equal(
    (await store.requestAuthorization(call.id)).authorizationRequestedAt,
    challenged.authorizationRequestedAt,
  );
  assert.equal(
    (await f.pool.query("SELECT verification_failures FROM voice_calls WHERE id=$1", [call.id]))
      .rows[0].verification_failures,
    0,
  );
  assert.equal(
    (
      await f.pool.query(
        "SELECT id FROM voice_events WHERE call_id=$1 AND kind='authorization_requested'",
        [call.id],
      )
    ).rowCount,
    1,
  );
  for (let attempt = 0; attempt < 4; attempt++)
    await assert.rejects(store.verifyCode(call.id, "bad"), rejected("invalid_voice_code"));
  await store.verifyCode(call.id, (await store.issueCode(f.patient)).code);
  const session = await store.sessionState(call.id);
  assert.equal(session.verified, true);
  assert.equal(session.call.status, "in_progress");
  assert.equal((await store.bound(call.id)).actor.id, f.patient.id);
  await f.pool.query("UPDATE principals SET active=false WHERE id=$1", [f.patient.id]);
  await assert.rejects(store.sessionState(call.id), rejected("unauthorized"));
});

test("outbound guest audio does not turn a known recipient into a verified caller", async (t) => {
  const f = await workflowFixture(t);
  const store = new VoiceStore(f.pool, { now: f.now });
  const task = await f.service.create(f.patient, f.input);
  const dueAt = new Date(f.now().getTime() + 1000).toISOString();
  const call = await store.scheduleCallback(f.patient, {
    taskId: task.id,
    to: caller,
    dueAt,
    mode: "twilio",
  });
  f.setNow(new Date(dueAt));
  await store.claimDue();
  await store.markDialed(call.id, "CA-guest-outbound");
  const { token } = await store.issueStream(call.id);
  await store.claimStream(call.id, token, "CA-guest-outbound");
  assert.equal((await store.sessionState(call.id)).verified, false);
  assert.equal((await store.getInternal(call.id)).status, "awaiting_verification");
  await assert.rejects(store.bound(call.id), rejected("voice_unverified"));
  await store.requestAuthorization(call.id);
  await assert.rejects(
    store.verifyCode(call.id, (await store.issueCode(f.staff)).code),
    rejected("invalid_voice_code"),
  );
  await store.verifyCode(call.id, (await store.issueCode(f.patient, task.id)).code);
  assert.equal((await store.bound(call.id)).actor.id, f.patient.id);
});

test("a delayed challenge keeps code expiry and the five-failure lockout effective", async (t) => {
  const f = await workflowFixture(t);
  const store = new VoiceStore(f.pool, { now: f.now });
  const call = await store.beginInbound({ sid: "CA-guest-locked", from: caller });
  const { token } = await store.issueStream(call.id);
  await store.claimStream(call.id, token, "CA-guest-locked");
  await store.requestAuthorization(call.id);
  const expired = await store.issueCode(f.patient);
  f.setNow(new Date(expired.expiresAt));
  await assert.rejects(store.verifyCode(call.id, expired.code), rejected("invalid_voice_code"));
  for (let attempt = 0; attempt < 4; attempt++)
    await assert.rejects(store.verifyCode(call.id, "bad"), rejected("invalid_voice_code"));
  const valid = await store.issueCode(f.patient);
  await assert.rejects(
    store.verifyCode(call.id, valid.code),
    rejected("voice_verification_locked"),
  );
  assert.equal((await store.sessionState(call.id)).verified, false);
  assert.equal((await store.sessionState(call.id)).call.status, "failed");
  await assert.rejects(store.issueStream(call.id), rejected("call_ended"));
});

test("signed inbound caller numbers are private, validated, and immutable on duplicate delivery", async (t) => {
  const f = await workflowFixture(t);
  const store = new VoiceStore(f.pool, { now: f.now });
  const call = await store.beginInbound({ sid: "CA-caller-record", from: caller });
  await store.beginInbound({ sid: "CA-caller-record", from: "+15005550009" });
  const row = (
    await f.pool.query(
      "SELECT caller_number,recipient_number,actor_id FROM voice_calls WHERE id=$1",
      [call.id],
    )
  ).rows[0];
  assert.deepEqual(row, { caller_number: caller, recipient_number: null, actor_id: null });
  assert.ok(!JSON.stringify(await store.getInternal(call.id)).includes(caller));
  assert.ok(!JSON.stringify(await store.sessionState(call.id)).includes(caller));
  const withheld = await store.beginInbound({ sid: "CA-withheld", from: "anonymous" });
  assert.equal(withheld.maskedNumber, null);
  assert.equal(
    (await f.pool.query("SELECT caller_number FROM voice_calls WHERE id=$1", [withheld.id])).rows[0]
      .caller_number,
    null,
  );
});

test("only the signed call department can monitor an anonymous conversation", async (t) => {
  const f = await workflowFixture(t);
  const store = new VoiceStore(f.pool, { now: f.now });
  const call = await store.beginInbound({
    sid: "CA-scoped-guest",
    from: caller,
    departmentId: f.staff.departmentId!,
  });
  const hidden = await store.beginInbound({ sid: "CA-unscoped-guest", from: caller });
  const operator = await getPrincipal(f.pool, "synthetic-operator-001");
  const other = await getPrincipal(f.pool, "synthetic-staff-other");
  assert.equal((await store.get(f.staff, call.id)).id, call.id);
  assert.equal((await store.get(operator, call.id)).id, call.id);
  assert.deepEqual(
    (await store.list(f.staff)).map((item) => item.id),
    [call.id],
  );
  assert.deepEqual(
    (await store.list(operator)).map((item) => item.id),
    [call.id],
  );
  assert.deepEqual(await store.list(other), []);
  assert.deepEqual(await store.list(f.patient), []);
  await assert.rejects(store.get(other, call.id), rejected("not_found"));
  await assert.rejects(store.get(f.patient, call.id), rejected("not_found"));
  await assert.rejects(store.get(f.staff, hidden.id), rejected("not_found"));
  await store.beginInbound({
    sid: "CA-scoped-guest",
    from: caller,
    departmentId: other.departmentId!,
  });
  await assert.rejects(store.get(other, call.id), rejected("not_found"));
  await f.pool.query("UPDATE principals SET department_id=$2 WHERE id=$1", [
    f.staff.id,
    other.departmentId,
  ]);
  await assert.rejects(store.get(f.staff, call.id), rejected("not_found"));
});

test("verified identity replaces the anonymous department scope without leaking across departments", async (t) => {
  const f = await workflowFixture(t);
  const store = new VoiceStore(f.pool, { now: f.now });
  const call = await store.beginInbound({
    sid: "CA-scoped-identity",
    from: caller,
    departmentId: f.staff.departmentId!,
  });
  const other = await getPrincipal(f.pool, "synthetic-staff-other");
  await store.verifyCode(call.id, (await store.issueCode(other)).code);
  assert.equal((await store.get(other, call.id)).id, call.id);
  assert.deepEqual(
    (await store.list(other)).map((item) => item.id),
    [call.id],
  );
  assert.deepEqual(await store.list(f.staff), []);
  await assert.rejects(store.get(f.staff, call.id), rejected("not_found"));
});

test("provider completion cancels a prepared guest SMS without sending it", async (t) => {
  const f = await workflowFixture(t);
  const store = new VoiceStore(f.pool, { now: f.now });
  const sms = new VoiceSms(f.pool, {
    now: f.now,
    appUrl: "https://health.example.com",
    provider: {
      async send() {
        throw new Error("must not send");
      },
    },
  });
  const sid = `CA${"c".repeat(32)}`;
  const call = await store.beginInbound({ sid, from: caller });
  const prepared = await sms.prepare(call.id, { template: "portal_link", toolCallId: "portal" });
  await store.statusCallback(call.id, sid, "completed");
  const saved = (
    await f.pool.query("SELECT status,last_error FROM voice_sms WHERE id=$1", [prepared.sms.id])
  ).rows[0];
  assert.deepEqual(saved, { status: "cancelled", last_error: "call_ended" });
  assert.equal((await store.getInternal(call.id)).pendingAction, null);
  assert.equal((await sms.confirm(call.id, prepared.sms.id)).sms.status, "cancelled");
});

test("closing a verification-locked call clears prepared SMS even after its terminal transition", async (t) => {
  const f = await workflowFixture(t);
  const store = new VoiceStore(f.pool, { now: f.now });
  const sms = new VoiceSms(f.pool, {
    now: f.now,
    appUrl: "https://health.example.com",
    provider: {
      async send() {
        throw new Error("must not send");
      },
    },
  });
  for (const [index, close] of [store.end.bind(store), store.streamClosed.bind(store)].entries()) {
    const call = await store.beginInbound({ sid: `CA${String(index).repeat(32)}`, from: caller });
    const prepared = await sms.prepare(call.id, { template: "portal_link", toolCallId: "portal" });
    await store.requestAuthorization(call.id);
    for (let attempt = 0; attempt < 5; attempt++)
      await assert.rejects(store.verifyCode(call.id, "bad"), rejected("invalid_voice_code"));
    const closed = await close(call.id, "verification_locked");
    assert.equal(closed.status, "failed");
    assert.equal(closed.pendingAction, null);
    assert.equal((await sms.confirm(call.id, prepared.sms.id)).sms.status, "cancelled");
  }
});

test("a verified handoff cancels its outstanding SMS preview", async (t) => {
  const f = await workflowFixture(t);
  const store = new VoiceStore(f.pool, { now: f.now });
  const sms = new VoiceSms(f.pool, { now: f.now, appUrl: "https://health.example.com" });
  const call = await store.simulate(f.patient, (await store.issueCode(f.patient)).code);
  const prepared = await sms.prepare(call.id, { template: "portal_link", toolCallId: "portal" });
  assert.equal((await store.handoff(call.id)).pendingAction, null);
  assert.equal((await sms.confirm(call.id, prepared.sms.id)).sms.status, "cancelled");
});
