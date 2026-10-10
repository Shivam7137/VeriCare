import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { BackendError } from "../../src/domain.js";
import { dispatchDueJobs } from "../../src/delivery.js";
import { getPrincipal, grantAuthority, revokeAuthority } from "../../src/identity.js";
import { VoiceStore, type PendingVoiceAction } from "../../src/voice-store.js";
import { workflowFixture } from "./workflow-fixture.js";

const rejected = (code: string) => (error: unknown) =>
  error instanceof BackendError && error.code === code;
const recipient = "+15005550006";
const pending = (now: Date): PendingVoiceAction => ({
  id: randomUUID(),
  kind: "withdraw",
  input: { expectedRevision: 0 },
  description: "Withdraw the fictional request.",
  expiresAt: new Date(now.getTime() + 60_000).toISOString(),
});

test("voice codes are hashed, rotated, restricted to current patients and used once", async (t) => {
  const f = await workflowFixture(t);
  const store = new VoiceStore(f.pool, { now: f.now });
  await assert.rejects(store.issueCode(f.staff), rejected("unauthorized"));
  const first = await store.issueCode(f.patient);
  assert.match(first.code, /^\d{8}$/);
  assert.equal(Date.parse(first.expiresAt) - f.now().getTime(), 600_000);
  const stored = (await f.pool.query("SELECT * FROM voice_access_codes")).rows[0];
  assert.equal(stored.code_hash, createHash("sha256").update(first.code).digest("hex"));
  assert.ok(!JSON.stringify(stored).includes(first.code));
  const second = await store.issueCode(f.patient);
  await assert.rejects(store.simulate(f.patient, first.code), rejected("invalid_voice_code"));
  await assert.rejects(
    store.simulate(f.representative, second.code),
    rejected("invalid_voice_code"),
  );
  const call = await store.simulate(f.patient, second.code);
  assert.equal(call.status, "in_progress");
  assert.equal(call.actorId, f.patient.id);
  await assert.rejects(store.simulate(f.patient, second.code), rejected("invalid_voice_code"));
  assert.equal((await store.verifyCode(call.id, second.code)).id, call.id);
  f.setNow(new Date(f.now().getTime() + 700_000));
  assert.equal((await store.verifyCode(call.id, second.code)).id, call.id);
  await f.pool.query("UPDATE principals SET active=false WHERE id=$1", [f.patient.id]);
  await assert.rejects(store.issueCode(f.patient), rejected("unauthorized"));
  await assert.rejects(store.bound(call.id), rejected("unauthorized"));
});

test("caller ID conveys no authority and verification failures persist and lock at five attempts", async (t) => {
  const f = await workflowFixture(t);
  const store = new VoiceStore(f.pool, { now: f.now });
  const call = await store.beginInbound({ sid: "CA-unverified", from: recipient });
  assert.equal(call.actorId, null);
  assert.equal(call.maskedNumber, "***0006");
  assert.equal(
    (await store.beginInbound({ sid: "CA-unverified", from: "+15555550123" })).id,
    call.id,
  );
  await assert.rejects(store.bound(call.id), rejected("voice_unverified"));
  await assert.rejects(store.issueStream(call.id), rejected("voice_unverified"));
  const { code } = await store.issueCode(f.patient);
  for (let attempt = 0; attempt < 5; attempt++)
    await assert.rejects(store.verifyCode(call.id, "bad"), rejected("invalid_voice_code"));
  const stored = (await f.pool.query("SELECT * FROM voice_calls WHERE id=$1", [call.id])).rows[0];
  assert.equal(stored.verification_failures, 5);
  assert.equal(stored.status, "failed");
  assert.equal(stored.recipient_number, null);
  await assert.rejects(store.verifyCode(call.id, code), rejected("voice_verification_locked"));
});

test("expired codes are rejected, concurrent verification consumes a code for exactly one call", async (t) => {
  const f = await workflowFixture(t);
  const store = new VoiceStore(f.pool, { now: f.now });
  const expired = await store.issueCode(f.patient);
  f.setNow(new Date(expired.expiresAt));
  await assert.rejects(store.simulate(f.patient, expired.code), rejected("invalid_voice_code"));
  const { code } = await store.issueCode(f.patient);
  const one = await store.beginInbound({ sid: "CA-one", from: recipient });
  const two = await store.beginInbound({ sid: "CA-two", from: recipient });
  const results = await Promise.allSettled([
    store.verifyCode(one.id, code),
    store.verifyCode(two.id, code),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
});

test("task-bound calls require the assigned requester and fresh representative authority", async (t) => {
  const f = await workflowFixture(t);
  const store = new VoiceStore(f.pool, { now: f.now });
  await grantAuthority(
    f.pool,
    f.patient,
    {
      patientId: f.patient.patientId!,
      requesterId: f.representative.id,
      expiresAt: new Date(f.now().getTime() + 3_600_000).toISOString(),
      evidenceRef: "synthetic-consent",
    },
    f.now(),
  );
  const task = await f.service.create(f.representative, f.input);
  await assert.rejects(store.issueCode(f.patient, task.id), rejected("forbidden"));
  const call = await store.simulate(
    f.representative,
    (await store.issueCode(f.representative, task.id)).code,
  );
  assert.equal((await store.bound(call.id)).actor.id, f.representative.id);
  await revokeAuthority(f.pool, f.patient, f.patient.patientId!, f.representative.id, f.now());
  await assert.rejects(store.bound(call.id), rejected("not_found"));
  await assert.rejects(store.get(f.representative, call.id), rejected("not_found"));
  await assert.rejects(store.setPending(call.id, pending(f.now())), rejected("not_found"));
});

test("call progress is patient-owned or department-scoped and never exposes private fields", async (t) => {
  const f = await workflowFixture(t);
  const store = new VoiceStore(f.pool, { now: f.now });
  const call = await store.simulate(f.patient, (await store.issueCode(f.patient)).code);
  const operator = await getPrincipal(f.pool, "synthetic-operator-001");
  const other = await getPrincipal(f.pool, "synthetic-staff-other");
  for (const actor of [f.patient, f.staff, operator])
    assert.equal((await store.get(actor, call.id)).id, call.id);
  for (const actor of [f.representative, other]) {
    await assert.rejects(store.get(actor, call.id), rejected("not_found"));
    assert.deepEqual(await store.list(actor), []);
  }
  await store.recordEvent(
    call.id,
    "provider_note",
    { status: "ringing", token: "secret", transcript: "private", to: recipient },
    "dedupe",
  );
  await store.recordEvent(call.id, "provider_note", { status: "completed" }, "dedupe");
  const exposed = await store.get(f.patient, call.id);
  const note = exposed.events!.filter((e) => e.kind === "provider_note");
  assert.equal(note.length, 1);
  assert.deepEqual(note[0]!.detail, { status: "ringing" });
  for (const field of ["recipient_number", "verified_at", "stream_token_hash", "code_hash"])
    assert.ok(!(field in exposed));
  await f.pool.query("UPDATE principals SET department_id='other-department' WHERE id=$1", [
    f.staff.id,
  ]);
  await assert.rejects(store.get(f.staff, call.id), rejected("not_found"));
});

test("stream claims bind a verified caller, exact provider SID, expiration and single use", async (t) => {
  const f = await workflowFixture(t);
  const store = new VoiceStore(f.pool, { now: f.now });
  const call = await store.beginInbound({ sid: "CA-stream", from: recipient });
  await store.verifyCode(call.id, (await store.issueCode(f.patient)).code);
  const { token } = await store.issueStream(call.id);
  const row = (await f.pool.query("SELECT * FROM voice_calls WHERE id=$1", [call.id])).rows[0];
  assert.equal(row.stream_token_hash, createHash("sha256").update(token).digest("hex"));
  await assert.rejects(
    store.claimStream(call.id, token, "CA-wrong"),
    rejected("invalid_stream_token"),
  );
  assert.deepEqual(await store.claimStream(call.id, token, "CA-stream"), { callId: call.id });
  await assert.rejects(
    store.claimStream(call.id, token, "CA-stream"),
    rejected("invalid_stream_token"),
  );
  await assert.rejects(store.issueStream(call.id), rejected("stream_already_connected"));
  const expiringCall = await store.beginInbound({ sid: "CA-expiring-stream", from: recipient });
  await store.verifyCode(expiringCall.id, (await store.issueCode(f.patient)).code);
  const second = await store.issueStream(expiringCall.id);
  f.setNow(new Date(f.now().getTime() + 300_000));
  await assert.rejects(
    store.claimStream(expiringCall.id, second.token, "CA-expiring-stream"),
    rejected("invalid_stream_token"),
  );
  const third = await store.issueStream(expiringCall.id);
  await store.end(expiringCall.id, "disconnect");
  await assert.rejects(
    store.claimStream(expiringCall.id, third.token, "CA-expiring-stream"),
    rejected("invalid_stream_token"),
  );
});

test("pending actions cannot be silently replaced or confirmed twice and expiry clears the action", async (t) => {
  const f = await workflowFixture(t);
  const store = new VoiceStore(f.pool, { now: f.now });
  const task = await f.service.create(f.patient, f.input);
  const call = await store.simulate(f.patient, (await store.issueCode(f.patient, task.id)).code);
  const action = pending(f.now());
  await store.setPending(call.id, action);
  await assert.rejects(
    store.setPending(call.id, pending(f.now())),
    rejected("pending_action_exists"),
  );
  await assert.rejects(
    store.consumePending(call.id, "wrong-id"),
    rejected("pending_action_missing"),
  );
  const results = await Promise.allSettled([
    store.consumePending(call.id, action.id),
    store.consumePending(call.id, action.id),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await store.get(f.patient, call.id)).pendingAction, null);
  const expiring = pending(f.now());
  await store.setPending(call.id, expiring);
  f.setNow(new Date(expiring.expiresAt));
  await assert.rejects(
    store.consumePending(call.id, expiring.id),
    rejected("pending_action_expired"),
  );
  assert.equal((await store.get(f.patient, call.id)).pendingAction, null);
  await store.setPending(call.id, pending(f.now()));
  await store.cancelPending(call.id);
  assert.equal((await store.get(f.patient, call.id)).pendingAction, null);
  // Claiming a confirmation does not itself execute a booking or change the task.
  assert.deepEqual((await f.service.progress(f.patient, task.id)).task, task);
});

test("completed request evidence remains readable over a new voice stream while mutations stay blocked", async (t) => {
  const f = await workflowFixture(t);
  const store = new VoiceStore(f.pool, { now: f.now });
  let task = await f.proposed();
  task = await f.service.decide(f.staff, task.id, "staff_approval", {
    expectedRevision: task.revision,
    proposalVersion: 1,
    response: "approve",
    evidenceRef: "test:staff",
  });
  await dispatchDueJobs(f.pool, { now: f.now() });
  task = (await f.service.progress(f.patient, task.id)).task;
  task = await f.service.decide(f.patient, task.id, "patient_confirmation", {
    expectedRevision: task.revision,
    proposalVersion: 1,
    response: "approve",
    evidenceRef: "test:patient",
  });
  const prior = await store.simulate(f.patient, (await store.issueCode(f.patient, task.id)).code);
  const action = pending(f.now());
  await store.setPending(prior.id, action);
  await f.executor.execute(task.id);
  await assert.rejects(store.consumePending(prior.id, action.id), rejected("request_stopped"));
  const call = await store.beginInbound({ sid: "CA-completed-request", from: recipient });
  await store.verifyCode(call.id, (await store.issueCode(f.patient, task.id)).code);
  const { token } = await store.issueStream(call.id);
  assert.deepEqual(await store.claimStream(call.id, token, "CA-completed-request"), {
    callId: call.id,
  });
  const bound = await store.bound(call.id);
  const progress = await f.service.progress(bound.actor, bound.call.taskId!);
  assert.equal(progress.task.state, "completed");
  assert.equal(progress.operation!.status, "confirmed");
  await assert.rejects(store.setPending(call.id, pending(f.now())), rejected("request_stopped"));
  const simulated = await store.simulate(
    f.patient,
    (await store.issueCode(f.patient, task.id)).code,
  );
  assert.equal((await store.bound(simulated.id)).call.taskId, task.id);
  assert.equal((await f.scheduler.getBooking(f.input.appointmentId))!.version, "2");
});

test("stopped tasks reject pending actions while handoff and hangup never complete a booking", async (t) => {
  const f = await workflowFixture(t);
  const store = new VoiceStore(f.pool, { now: f.now });
  const task = await f.service.create(f.patient, f.input);
  const call = await store.simulate(f.patient, (await store.issueCode(f.patient, task.id)).code);
  const action = pending(f.now());
  await store.setPending(call.id, action);
  await f.service.withdraw(f.patient, task.id, {
    expectedRevision: task.revision,
    evidenceRef: "synthetic-withdrawal",
  });
  await assert.rejects(store.consumePending(call.id, action.id), rejected("request_stopped"));
  assert.equal((await store.handoff(call.id)).status, "handoff");
  assert.equal((await store.end(call.id, "hangup")).status, "handoff");
  assert.equal((await f.service.progress(f.patient, task.id)).task.state, "withdrawn");
  assert.equal((await f.scheduler.getBooking(f.input.appointmentId))!.version, "1");
});

test("callbacks enforce explicit windows and E164 numbers, and require verification after dispatch", async (t) => {
  const f = await workflowFixture(t);
  const store = new VoiceStore(f.pool, { now: f.now });
  const task = await f.service.create(f.patient, f.input);
  const input = {
    taskId: task.id,
    to: recipient,
    dueAt: new Date(f.now().getTime() + 1000).toISOString(),
    mode: "simulated" as const,
  };
  await assert.rejects(
    store.scheduleCallback(f.patient, { ...input, to: "5551234" }),
    rejected("invalid_callback"),
  );
  await assert.rejects(
    store.scheduleCallback(f.patient, { ...input, dueAt: f.now().toISOString() }),
    rejected("invalid_callback"),
  );
  await assert.rejects(
    store.scheduleCallback(f.patient, { ...input, dueAt: f.input.callbackWindow.endsAt }),
    rejected("outside_callback_window"),
  );
  await assert.rejects(store.scheduleCallback(f.representative, input), rejected("not_found"));
  const call = await store.scheduleCallback(f.patient, input);
  assert.ok(!JSON.stringify(await store.get(f.patient, call.id)).includes(recipient));
  await assert.rejects(
    store.scheduleCallback(f.patient, input),
    rejected("callback_already_scheduled"),
  );
  assert.deepEqual(await store.claimDue(), []);
  f.setNow(new Date(input.dueAt));
  const claimed = await store.claimDue();
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0]!.to, recipient);
  assert.equal(claimed[0]!.status, "dialing");
  await store.markDialed(call.id, "SIM-callback");
  await assert.rejects(store.bound(call.id), rejected("voice_unverified"));
  await assert.rejects(
    store.verifyCode(call.id, (await store.issueCode(f.representative)).code),
    rejected("invalid_voice_code"),
  );
  const otherTask = await f.service.create(f.patient, f.input);
  await assert.rejects(
    store.verifyCode(call.id, (await store.issueCode(f.patient, otherTask.id)).code),
    rejected("invalid_voice_code"),
  );
  await store.verifyCode(call.id, (await store.issueCode(f.patient, task.id)).code);
  assert.equal((await store.bound(call.id)).actor.id, f.patient.id);
  await store.end(call.id, "hangup");
  assert.equal((await f.service.progress(f.patient, task.id)).task.state, "awaiting_verification");
});

test("callback workers claim once, cancel stale eligibility and reconcile unknown dispatches without redial", async (t) => {
  const f = await workflowFixture(t);
  const store = new VoiceStore(f.pool, { now: f.now });
  const task = await f.service.create(f.patient, f.input);
  const input = {
    taskId: task.id,
    to: recipient,
    dueAt: new Date(f.now().getTime() + 1000).toISOString(),
    mode: "twilio" as const,
  };
  const call = await store.scheduleCallback(f.patient, input);
  f.setNow(new Date(input.dueAt));
  const claims = await Promise.all([store.claimDue(), store.claimDue()]);
  assert.equal(claims.flat().length, 1);
  f.setNow(new Date(f.now().getTime() + 60_000));
  assert.deepEqual(await store.claimDue(), []);
  assert.equal((await store.getInternal(call.id)).status, "reconciling");
  assert.deepEqual(await store.claimDue(), []);
  await store.statusCallback(call.id, "CA-late-success", "completed");
  assert.equal((await store.getInternal(call.id)).status, "completed");
  const stopped = await store.scheduleCallback(f.patient, {
    ...input,
    dueAt: new Date(f.now().getTime() + 1000).toISOString(),
  });
  await f.service.withdraw(f.patient, task.id, {
    expectedRevision: task.revision,
    evidenceRef: "synthetic-withdrawal",
  });
  f.setNow(new Date(f.now().getTime() + 1000));
  assert.deepEqual(await store.claimDue(), []);
  assert.equal((await store.getInternal(stopped.id)).status, "cancelled");
});

test("signed provider status processing binds early SIDs, is monotonic and idempotent", async (t) => {
  const f = await workflowFixture(t);
  const store = new VoiceStore(f.pool, { now: f.now });
  const task = await f.service.create(f.patient, f.input);
  const dueAt = new Date(f.now().getTime() + 1000).toISOString();
  const call = await store.scheduleCallback(f.patient, {
    taskId: task.id,
    to: recipient,
    dueAt,
    mode: "twilio",
  });
  await assert.rejects(
    store.statusCallback(call.id, "CA-early", "ringing"),
    rejected("provider_sid_mismatch"),
  );
  f.setNow(new Date(dueAt));
  await store.claimDue();
  await store.statusCallback(call.id, "CA-early", "in-progress");
  assert.equal((await store.getInternal(call.id)).status, "awaiting_verification");
  await store.markDialed(call.id, "CA-early");
  await store.statusCallback(call.id, "CA-early", "ringing");
  assert.equal((await store.getInternal(call.id)).status, "awaiting_verification");
  await assert.rejects(
    store.statusCallback(call.id, "CA-other", "completed"),
    rejected("provider_sid_mismatch"),
  );
  await store.statusCallback(call.id, "CA-early", "completed");
  await store.statusCallback(call.id, "CA-early", "completed");
  await store.statusCallback(call.id, "CA-early", "failed");
  await store.statusCallback(call.id, "CA-early", "ringing");
  const final = await store.get(f.patient, call.id);
  assert.equal(final.status, "completed");
  assert.equal(
    final.events!.filter((e) => e.kind === "provider_status" && e.detail.status === "completed")
      .length,
    1,
  );
});

test("callback dispatch rechecks expired windows and representative consent before claiming", async (t) => {
  const f = await workflowFixture(t);
  const store = new VoiceStore(f.pool, { now: f.now });
  await grantAuthority(
    f.pool,
    f.patient,
    {
      patientId: f.patient.patientId!,
      requesterId: f.representative.id,
      expiresAt: new Date(f.now().getTime() + 3_600_000).toISOString(),
      evidenceRef: "synthetic-consent",
    },
    f.now(),
  );
  const delegated = await f.service.create(f.representative, f.input);
  const owned = await f.service.create(f.patient, f.input);
  const dueAt = new Date(f.now().getTime() + 1000).toISOString();
  const revoked = await store.scheduleCallback(f.representative, {
    taskId: delegated.id,
    to: recipient,
    dueAt,
    mode: "twilio",
  });
  await revokeAuthority(f.pool, f.patient, f.patient.patientId!, f.representative.id, f.now());
  f.setNow(new Date(dueAt));
  assert.deepEqual(await store.claimDue(), []);
  assert.equal((await store.getInternal(revoked.id)).status, "cancelled");
  const expired = await store.scheduleCallback(f.patient, {
    taskId: owned.id,
    to: recipient,
    dueAt: new Date(f.now().getTime() + 1000).toISOString(),
    mode: "twilio",
  });
  f.setNow(new Date(f.input.callbackWindow.endsAt));
  assert.deepEqual(await store.claimDue(), []);
  assert.equal((await store.getInternal(expired.id)).status, "cancelled");
});

test("call and tool replay records survive a new pool without overwriting the first result", async (t) => {
  const f = await workflowFixture(t);
  const store = new VoiceStore(f.pool, { now: f.now });
  const call = await store.simulate(f.patient, (await store.issueCode(f.patient)).code);
  await store.saveToolResult(call.id, "tool-1", { status: "intake" });
  await store.saveToolResult(call.id, "tool-1", { status: "changed" });
  const reopened = new VoiceStore(f.database.open(), { now: f.now });
  assert.equal((await reopened.get(f.patient, call.id)).id, call.id);
  assert.deepEqual(await reopened.getToolResult(call.id, "tool-1"), { status: "intake" });
  assert.equal(await reopened.getToolResult(call.id, "missing"), undefined);
});
