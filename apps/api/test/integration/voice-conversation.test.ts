import assert from "node:assert/strict";
import test from "node:test";
import { VoiceAgent } from "../../src/voice-agent.js";
import { workflowFixture } from "./workflow-fixture.js";

test("guest conversation requests authorization only on a protected tool and resumes after code", async (t) => {
  const f = await workflowFixture(t),
    agent = new VoiceAgent(f.pool, { now: f.now });
  const call = await agent.store.beginInbound({
    sid: `CA${"7".repeat(32)}`,
    from: "+15555550102",
    departmentId: "demo-department",
  });
  assert.equal(call.authorizationRequestedAt, null);
  await agent.store.issueStream(call.id);
  assert.equal((await agent.store.sessionState(call.id)).verified, false);
  const blocked = (await agent.run(call.id, "first", "list_appointments", {})) as any;
  assert.equal(blocked.status, "authorization_required");
  assert.ok(!blocked.appointments);
  assert.ok((await agent.store.getInternal(call.id)).authorizationRequestedAt);
  const { code } = await agent.store.issueCode(f.patient);
  await agent.store.verifyCode(call.id, code);
  const answer = (await agent.run(call.id, "second", "list_appointments", {})) as any;
  assert.ok(answer.appointments.length > 0);
  assert.equal(answer.appointments[0].patientId, f.patient.patientId);
});
test("a guest can request and approve a portal text without private-record authorization", async (t) => {
  const f = await workflowFixture(t);
  let sent = 0;
  const agent = new VoiceAgent(f.pool, {
    now: f.now,
    smsAppUrl: "https://demo.example.com",
    smsProvider: {
      send: async () => {
        sent++;
        return { sid: `SM${"8".repeat(32)}`, status: "queued" };
      },
    },
  });
  const call = await agent.store.beginInbound({
    sid: `CA${"8".repeat(32)}`,
    from: "+15555550102",
    departmentId: "demo-department",
  });
  const prepared = (await agent.run(call.id, "sms-1", "prepare_sms", {
    template: "portal_link",
    appointmentId: null,
  })) as any;
  assert.equal(prepared.pendingAction.kind, "sms");
  assert.equal(sent, 0);
  await assert.rejects(agent.digit(call.id, "1"), { code: "keypad_readback_required" });
  const result = await agent.digit(call.id, "1", prepared.pendingAction.id);
  assert.equal(result.status, "accepted");
  assert.equal(sent, 1);
  const delivery = (await agent.run(call.id, "sms-status", "get_sms_status", {})) as {
    messages: { status: string }[];
  };
  assert.equal(delivery.messages[0]?.status, "accepted");
  assert.equal(sent, 1);
  assert.equal((await agent.store.sessionState(call.id)).verified, false);
  const privateText = (await agent.run(call.id, "sms-2", "prepare_sms", {
    template: "request_status",
    appointmentId: null,
  })) as any;
  assert.equal(privateText.status, "authorization_required");
  assert.equal(sent, 1);
});
