import assert from "node:assert/strict";
import test from "node:test";
import { dispatchDueJobs } from "../../src/delivery.js";
import { VoiceAgent } from "../../src/voice-agent.js";
import { workflowFixture } from "./workflow-fixture.js";

async function boundTask(f: Awaited<ReturnType<typeof workflowFixture>>) {
  const agent = new VoiceAgent(f.pool, { now: f.now });
  let task = await f.service.create(f.patient, f.input);
  task = await f.service.verify(f.patient, task.id, { expectedRevision: task.revision });
  const { code } = await agent.store.issueCode(f.patient, task.id);
  const call = await agent.store.simulate(f.patient, code);
  return { agent, task, call };
}

test("agent preparation and spoken assent leave workflow unchanged until explicit DTMF approval", async (t) => {
  const f = await workflowFixture(t);
  const { agent, task, call } = await boundTask(f);
  const callbackWindow = { ...f.input.callbackWindow, startsAt: "2030-01-07T12:10:00.000Z" };
  const prepared = await agent.run(call.id, "callback-tool", "prepare_callback", {
    callbackWindow,
  });
  assert.deepEqual(
    await agent.run(call.id, "callback-tool", "prepare_callback", { callbackWindow }),
    prepared,
  );
  assert.equal((await f.service.progress(f.patient, task.id)).task.revision, task.revision);
  assert.deepEqual(
    (await f.service.progress(f.patient, task.id)).workflow?.callbackWindow,
    f.input.callbackWindow,
  );
  assert.equal((await agent.digit(call.id, "yes")).status, "ignored");
  assert.equal((await f.service.progress(f.patient, task.id)).task.revision, task.revision);
  assert.equal((await agent.digit(call.id, "1")).status, "saved");
  const progress = await f.service.progress(f.patient, task.id);
  assert.equal(progress.task.revision, task.revision + 1);
  assert.deepEqual(progress.workflow?.callbackWindow, callbackWindow);
  assert.equal((await agent.store.getInternal(call.id)).pendingAction, null);
  await assert.rejects(agent.digit(call.id, "1"), { code: "no_pending_action" });
});

test("cancellation and hangup discard pending withdrawal without completing or changing the request", async (t) => {
  const f = await workflowFixture(t);
  const { agent, task, call } = await boundTask(f);
  await agent.run(call.id, "withdraw-one", "prepare_withdrawal", {});
  assert.equal((await agent.digit(call.id, "2")).status, "cancelled");
  assert.equal((await agent.store.getInternal(call.id)).pendingAction, null);
  await agent.run(call.id, "withdraw-two", "prepare_withdrawal", {});
  await agent.store.end(call.id, "caller_hangup");
  assert.equal((await agent.store.getInternal(call.id)).status, "completed");
  assert.equal((await agent.store.getInternal(call.id)).pendingAction, null);
  assert.deepEqual((await f.service.progress(f.patient, task.id)).task, task);
  await assert.rejects(agent.run(call.id, "after-hangup", "list_appointments", {}), {
    code: "call_ended",
  });
  assert.equal((await f.scheduler.getBooking(f.input.appointmentId))?.version, "1");
});

test("keypad proposal confirmation requests execution but neither AI nor hangup completes the booking", async (t) => {
  const f = await workflowFixture(t);
  let task = await f.proposed();
  task = await f.service.decide(f.staff, task.id, "staff_approval", {
    expectedRevision: task.revision,
    proposalVersion: 1,
    response: "approve",
    evidenceRef: "test:staff",
  });
  await dispatchDueJobs(f.pool, { now: f.now() });
  task = (await f.service.progress(f.patient, task.id)).task;
  const agent = new VoiceAgent(f.pool, { now: f.now });
  const { code } = await agent.store.issueCode(f.patient, task.id);
  const call = await agent.store.simulate(f.patient, code);
  await agent.run(call.id, "prepare-approval", "prepare_confirmation", { response: "approve" });
  const pending = (await agent.store.getInternal(call.id)).pendingAction!;
  assert.equal(pending.input.proposalVersion, 1);
  assert.equal(pending.input.expectedRevision, task.revision);
  assert.equal(
    (await f.service.progress(f.patient, task.id)).task.state,
    "awaiting_patient_confirmation",
  );
  await agent.digit(call.id, "1");
  await agent.store.end(call.id, "caller_hangup");
  const progress = await f.service.progress(f.patient, task.id);
  assert.equal(progress.task.state, "ready_to_execute");
  assert.notEqual(progress.operation?.status, "confirmed");
  assert.equal(
    (await f.scheduler.getBooking(f.input.appointmentId))?.slotId,
    "synthetic-slot-original",
  );
});

test("unverified callers, unsupported tools, malformed arguments and revoked principals cannot mutate workflow", async (t) => {
  const f = await workflowFixture(t);
  const { agent, task, call } = await boundTask(f);
  const unverified = await agent.store.beginInbound({ sid: "CAunverified", from: "+15555550102" });
  await assert.rejects(agent.run(unverified.id, "unverified-tool", "get_request_status", {}), {
    code: "voice_unverified",
  });
  for (const name of ["complete_booking", "staff_approval", "execute_booking"]) {
    await assert.rejects(agent.run(call.id, name, name, {}), { code: "tool_not_allowed" });
  }
  await assert.rejects(
    agent.run(call.id, "malformed", "prepare_withdrawal", { state: "completed" }),
    { name: "ZodError" },
  );
  await f.pool.query("UPDATE principals SET active=false WHERE id=$1", [f.patient.id]);
  await assert.rejects(agent.run(call.id, "revoked", "prepare_withdrawal", {}), {
    code: "unauthorized",
  });
  const saved = (await f.pool.query("SELECT payload FROM tasks WHERE id=$1", [task.id])).rows[0]
    .payload;
  assert.equal(saved.state, task.state);
  assert.equal(saved.revision, task.revision);
});

test("new voice intake lists only owned appointments and creates a verified request only after confirmation", async (t) => {
  const f = await workflowFixture(t);
  const agent = new VoiceAgent(f.pool, { now: f.now });
  const { code } = await agent.store.issueCode(f.patient);
  const call = await agent.store.simulate(f.patient, code);
  const listed = (await agent.run(call.id, "appointments", "list_appointments", {})) as {
    appointments: { id: string; patientId: string }[];
  };
  assert.deepEqual(
    listed.appointments.map((item) => item.id),
    [f.input.appointmentId],
  );
  assert.ok(listed.appointments.every((item) => item.patientId === f.patient.patientId));
  const { patientId: _patientId, ...input } = f.input;
  await assert.rejects(
    agent.run(call.id, "foreign-booking", "prepare_request", {
      ...input,
      appointmentId: "synthetic-appointment-002",
    }),
    { code: "not_found" },
  );
  await agent.run(call.id, "new-request", "prepare_request", input);
  assert.equal(Number((await f.pool.query("SELECT count(*) FROM tasks")).rows[0].count), 0);
  const pending = (await agent.store.getInternal(call.id)).pendingAction!;
  assert.doesNotMatch(pending.description, new RegExp(f.input.appointmentId));
  assert.match(pending.description, /January .*2030/);
  assert.match(pending.description, /America\/Halifax time/);
  const result = await agent.confirm(call.id, pending.id);
  assert.ok("task" in result);
  assert.equal(result.task.patientId, f.patient.patientId);
  assert.equal(result.task.requesterId, f.patient.id);
  assert.equal(result.task.state, "awaiting_proposal");
  assert.equal((await agent.store.getInternal(call.id)).taskId, result.task.id);
  assert.equal((await f.scheduler.getBooking(f.input.appointmentId))?.version, "1");
});

test("confirmation rechecks workflow revision and professional handover stops further agent actions", async (t) => {
  const f = await workflowFixture(t);
  const { agent, task, call } = await boundTask(f);
  await agent.run(call.id, "stale-withdrawal", "prepare_withdrawal", {});
  const changed = await f.service.callback(f.patient, task.id, {
    expectedRevision: task.revision,
    callbackWindow: { ...f.input.callbackWindow, startsAt: "2030-01-07T12:05:00.000Z" },
  });
  await assert.rejects(agent.digit(call.id, "1"));
  assert.deepEqual((await f.service.progress(f.patient, task.id)).task, changed);
  await agent.run(call.id, "handover", "request_human", {});
  assert.equal((await agent.store.getInternal(call.id)).status, "handoff");
  await assert.rejects(agent.run(call.id, "after-handover", "get_request_status", {}), {
    code: "call_ended",
  });
  assert.deepEqual((await f.service.progress(f.patient, task.id)).task, changed);
});
