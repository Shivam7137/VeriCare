import assert from "node:assert/strict";
import test from "node:test";
import { workflowFixture } from "./workflow-fixture.js";
import { VoiceStore } from "../../src/voice-store.js";
import { VoiceAgent } from "../../src/voice-agent.js";
import { CareTeamDirectory } from "../../src/care-team-directory.js";
import { VoiceTransfers } from "../../src/voice-transfers.js";
import { TwilioDispatchError } from "../../src/twilio-provider.js";
import { seedIdentity } from "../../src/identity-fixtures.js";

test("staff codes and directory stay department scoped without patient appointment authority", async (t) => {
  const f = await workflowFixture(t);
  const store = new VoiceStore(f.pool, { now: f.now });
  const directory = new CareTeamDirectory(f.pool);
  const { code } = await store.issueCode(f.staff);
  assert.match(code, /^\d{8}$/);
  const call = await store.simulate(f.staff, code);
  assert.equal((await store.bound(call.id)).actor.role, "staff");
  assert.equal(
    (await store.list(f.staff)).some((item) => item.id === call.id),
    true,
  );
  await assert.rejects(store.get(f.patient, call.id), { code: "not_found" });
  await assert.rejects(store.issueCode(f.staff, (await f.proposed()).id), { code: "forbidden" });
  const agent = new VoiceAgent(f.pool, { now: f.now });
  for (const name of [
    "list_appointments",
    "prepare_request",
    "prepare_confirmation",
    "prepare_withdrawal",
  ])
    await assert.rejects(agent.run(call.id, name, name, {}), { code: "forbidden" });
  const own = await directory.list(f.staff, { patientId: f.patient.patientId!, doctor: true });
  assert.equal(own.members.length, 1);
  assert.equal(own.members[0]!.name, "Dr. Anika Rao");
  assert.equal(own.members[0]!.phoneNumber, null);
  await assert.rejects(directory.list(f.staff, { patientId: "synthetic-patient-other" }), {
    code: "not_found",
  });
  await assert.rejects(
    directory.update(f.patient, own.members[0]!.id, { phoneNumber: null, expectedRevision: 1 }),
    { code: "forbidden" },
  );
});

test("simulated transfer accepts unconfigured fictional destination, consumes once and never completes booking", async (t) => {
  const f = await workflowFixture(t);
  let attempts = 0;
  const transfers = new VoiceTransfers(f.pool, {
    now: f.now,
    provider: {
      async transfer() {
        attempts++;
      },
    },
  });
  const store = new VoiceStore(f.pool, { now: f.now });
  const task = await f.proposed();
  const call = await store.simulate(f.patient, (await store.issueCode(f.patient, task.id)).code);
  const prepared = await transfers.prepare(call.id, { memberId: "synthetic-staff-001" });
  assert.match(prepared.pendingAction.description, /SIMULATED/);
  assert.equal((await store.getInternal(call.id)).status, "in_progress");
  const confirmed = await transfers.confirm(call.id, prepared.pendingAction.id);
  assert.equal(confirmed.transfer.status, "dialing");
  await assert.rejects(transfers.confirm(call.id, prepared.pendingAction.id), {
    code: "call_stopped",
  });
  await store.streamClosed(call.id, "twilio_stop");
  assert.equal((await store.getInternal(call.id)).status, "transferring");
  await transfers.simulateResult(f.patient, confirmed.transfer.id, "connected");
  assert.equal((await transfers.list(f.patient, call.id))[0]!.status, "connected");
  assert.equal((await f.service.progress(f.patient, task.id)).task.state, task.state);
  assert.equal((await f.scheduler.getBooking(f.input.appointmentId))!.version, "1");
  assert.equal(attempts, 0);
});

test("live forwarding rejects unverified, null, invalid, loop and changed destinations before any dispatch", async (t) => {
  const f = await workflowFixture(t);
  let attempts = 0;
  const transfers = new VoiceTransfers(f.pool, {
    now: f.now,
    ownNumber: "+15555550101",
    provider: {
      async transfer() {
        attempts++;
      },
    },
  });
  const directory = new CareTeamDirectory(f.pool, { ownNumber: "+15555550101" });
  const store = new VoiceStore(f.pool, { now: f.now });
  const call = await store.beginInbound({ sid: `CA${"3".repeat(32)}`, from: "+15555550102" });
  await assert.rejects(transfers.prepare(call.id, { memberId: "synthetic-staff-001" }), {
    code: "voice_unverified",
  });
  await store.verifyCode(call.id, (await store.issueCode(f.staff)).code);
  await assert.rejects(transfers.prepare(call.id, { memberId: "synthetic-staff-001" }), {
    code: "destination_unconfigured",
  });
  for (const phoneNumber of ["bad-number", "+15555550101"])
    await assert.rejects(
      directory.update(f.staff, "synthetic-staff-001", { phoneNumber, expectedRevision: 1 }),
    );
  await directory.update(f.staff, "synthetic-staff-001", {
    phoneNumber: "+15555550103",
    expectedRevision: 1,
  });
  const prepared = await transfers.prepare(call.id, {
    memberId: "synthetic-staff-001",
    patientId: f.patient.patientId!,
  });
  await directory.update(f.staff, "synthetic-staff-001", {
    phoneNumber: "+15555550104",
    expectedRevision: 2,
  });
  await assert.rejects(transfers.confirm(call.id, prepared.pendingAction.id), {
    code: "destination_changed",
  });
  assert.equal((await store.getInternal(call.id)).pendingAction, null);
  assert.equal(attempts, 0);
});

test("uncertain provider update and stream close preserve handoff and cannot redial", async (t) => {
  const f = await workflowFixture(t);
  let attempts = 0;
  const transfers = new VoiceTransfers(f.pool, {
    now: f.now,
    provider: {
      async transfer() {
        attempts++;
        throw new TwilioDispatchError("uncertain");
      },
    },
  });
  const directory = new CareTeamDirectory(f.pool);
  await directory.update(f.staff, "synthetic-staff-001", {
    phoneNumber: "+15555550103",
    expectedRevision: 1,
  });
  const store = new VoiceStore(f.pool, { now: f.now });
  const call = await store.beginInbound({ sid: `CA${"4".repeat(32)}`, from: "+15555550102" });
  await store.verifyCode(call.id, (await store.issueCode(f.staff)).code);
  const prepared = await transfers.prepare(call.id, { memberId: "synthetic-staff-001" });
  const results = await Promise.allSettled([
    transfers.confirm(call.id, prepared.pendingAction.id),
    transfers.confirm(call.id, prepared.pendingAction.id),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  await store.streamClosed(call.id, "twilio_stop");
  assert.equal((await store.getInternal(call.id)).status, "transferring");
  assert.equal((await transfers.list(f.staff, call.id))[0]!.status, "reconciling");
  await assert.rejects(transfers.prepare(call.id, { memberId: "synthetic-staff-001" }), {
    code: "call_stopped",
  });
  assert.equal(attempts, 1);
});

test("worker recovers a lost dispatch acknowledgement as uncertain without provider I/O", async (t) => {
  const f = await workflowFixture(t);
  const store = new VoiceStore(f.pool, { now: f.now });
  const transfers = new VoiceTransfers(f.pool, { now: f.now });
  const call = await store.simulate(f.staff, (await store.issueCode(f.staff)).code);
  const prepared = await transfers.prepare(call.id, { memberId: "synthetic-staff-001" });
  await transfers.confirm(call.id, prepared.pendingAction.id);
  await f.pool.query("UPDATE voice_transfers SET status='dispatching' WHERE id=$1", [
    prepared.pendingAction.id,
  ]);
  f.setNow(new Date(f.now().getTime() + 61_000));
  await transfers.reconcileStale();
  assert.equal((await transfers.list(f.staff, call.id))[0]!.status, "reconciling");
  assert.equal((await store.getInternal(call.id)).status, "transferring");
  await transfers.simulateResult(f.staff, prepared.pendingAction.id, "connected");
  assert.equal((await transfers.list(f.staff, call.id))[0]!.status, "connected");
});

test("repeat seeding preserves edited destinations and existing patient doctor associations", async (t) => {
  const f = await workflowFixture(t);
  const directory = new CareTeamDirectory(f.pool);
  await directory.update(f.staff, "synthetic-staff-001", {
    phoneNumber: "+15555550103",
    expectedRevision: 1,
  });
  await f.pool.query("DELETE FROM patient_care_team WHERE patient_id=$1", [f.patient.patientId]);
  await f.pool.query(
    "INSERT INTO patient_care_team(patient_id,member_id) VALUES ($1,'demo-staff-daniel-morris')",
    [f.patient.patientId],
  );
  await seedIdentity(f.pool);
  const own = await directory.list(f.staff, { patientId: f.patient.patientId!, doctor: true });
  assert.equal(own.selection, "resolved");
  assert.equal(own.members[0]!.id, "demo-staff-daniel-morris");
  const all = await directory.list(f.staff);
  assert.equal(
    all.members.find((member) => member.id === "synthetic-staff-001")!.phoneNumber,
    "+15555550103",
  );
  assert.equal(all.members.find((member) => member.id === "synthetic-staff-001")!.revision, 2);
});
