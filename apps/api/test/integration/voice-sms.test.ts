import assert from "node:assert/strict";
import test from "node:test";
import { workflowFixture } from "./workflow-fixture.js";
import { VoiceStore } from "../../src/voice-store.js";
import { VoiceSms } from "../../src/voice-sms.js";
import { SmsDispatchError } from "../../src/twilio-sms.js";

const appUrl = "https://health.example.com";
const messageSid = `SM${"a".repeat(32)}`;
const caller = "+15555550102";

test("guest portal SMS previews only the bound caller destination and deduplicates a tool call", async (t) => {
  const f = await workflowFixture(t);
  const store = new VoiceStore(f.pool, { now: f.now });
  const sms = new VoiceSms(f.pool, {
    now: f.now,
    appUrl,
    provider: {
      async send() {
        throw new Error("must not send");
      },
    },
  });
  const call = await store.beginInbound({ sid: `CA${"1".repeat(32)}`, from: caller });
  await f.pool.query("UPDATE voice_calls SET caller_number=$2 WHERE id=$1", [call.id, caller]);
  const input = { template: "portal_link", toolCallId: "tool1" };
  const first = await sms.prepare(call.id, input);
  const second = await sms.prepare(call.id, input);
  assert.equal(first.sms.id, second.sms.id);
  assert.equal(first.sms.maskedRecipient, "***0102");
  assert.equal(first.sms.status, "prepared");
  assert.equal(first.pendingAction!.kind, "sms");
  assert.match(first.sms.body, /https:\/\/health.example.com\/patient/);
  assert.match(first.sms.body, /Reply STOP/);
  assert.ok(!JSON.stringify(first).includes(caller));
  assert.match(first.pendingAction!.description, /patient portal.*phone ending 0102/);
  assert.doesNotMatch(first.pendingAction!.description, /https:|Reply STOP|Press|\*\*\*/);
  await assert.rejects(sms.prepare(call.id, { ...input, template: "request_status" }), {
    code: "sms_tool_conflict",
  });
  await assert.rejects(
    sms.prepare(call.id, { ...input, toolCallId: "tool2", recipient: "+15555550103" }),
    { code: "invalid_input" },
  );
  await assert.rejects(sms.prepare(call.id, { template: "request_status", toolCallId: "tool3" }), {
    code: "voice_unverified",
  });
});

test("simulated SMS has no provider effects and cannot claim delivery or complete a booking", async (t) => {
  const f = await workflowFixture(t);
  const store = new VoiceStore(f.pool, { now: f.now });
  const task = await f.proposed();
  const call = await store.simulate(f.patient, (await store.issueCode(f.patient, task.id)).code);
  let attempts = 0;
  const sms = new VoiceSms(f.pool, {
    now: f.now,
    appUrl,
    provider: {
      async send() {
        attempts++;
        return { sid: messageSid, status: "accepted" };
      },
    },
  });
  const prepared = await sms.prepare(call.id, {
    template: "request_status",
    toolCallId: "status1",
  });
  assert.match(prepared.sms.body, /awaiting staff approval/i);
  const result = await sms.confirm(call.id, prepared.sms.id);
  assert.equal(result.sms.status, "simulated");
  assert.equal((await sms.confirm(call.id, prepared.sms.id)).sms.status, "simulated");
  assert.equal(attempts, 0);
  assert.equal((await f.service.progress(f.patient, task.id)).task.state, task.state);
  assert.equal((await f.scheduler.getBooking(f.input.appointmentId))!.version, "1");
  await assert.rejects(sms.result(prepared.sms.id, { messageSid, status: "delivered" }), {
    code: "provider_sid_mismatch",
  });
});

test("concurrent confirmation sends once, binds exact SID, and ignores reordered delivery callbacks", async (t) => {
  const f = await workflowFixture(t);
  const store = new VoiceStore(f.pool, { now: f.now });
  let attempts = 0;
  const sms = new VoiceSms(f.pool, {
    now: f.now,
    appUrl,
    provider: {
      async send(input) {
        attempts++;
        assert.equal(input.to, caller);
        assert.match(input.body, /Reply STOP/);
        return { sid: messageSid, status: "queued" };
      },
    },
  });
  const call = await store.beginInbound({ sid: `CA${"2".repeat(32)}`, from: caller });
  await f.pool.query("UPDATE voice_calls SET caller_number=$2 WHERE id=$1", [call.id, caller]);
  const prepared = await sms.prepare(call.id, { template: "portal_link", toolCallId: "portal" });
  await Promise.all([sms.confirm(call.id, prepared.sms.id), sms.confirm(call.id, prepared.sms.id)]);
  assert.equal(attempts, 1);
  assert.equal((await sms.confirm(call.id, prepared.sms.id)).sms.status, "accepted");
  const replay = await sms.prepare(call.id, { template: "portal_link", toolCallId: "portal" });
  assert.equal(replay.status, "accepted");
  assert.equal(replay.pendingAction, null);
  await assert.rejects(
    sms.result(prepared.sms.id, { messageSid: `SM${"b".repeat(32)}`, status: "delivered" }),
    { code: "provider_sid_mismatch" },
  );
  assert.equal((await sms.result(prepared.sms.id, { messageSid, status: "sent" })).status, "sent");
  assert.equal(
    (await sms.result(prepared.sms.id, { messageSid, status: "delivered" })).status,
    "delivered",
  );
  assert.equal(
    (await sms.result(prepared.sms.id, { messageSid, status: "queued" })).status,
    "delivered",
  );
  assert.equal(
    (await sms.result(prepared.sms.id, { messageSid, status: "sent" })).status,
    "delivered",
  );
  const record = (
    await f.pool.query("SELECT pending_action,status FROM voice_calls WHERE id=$1", [call.id])
  ).rows[0];
  assert.equal(record.pending_action, null);
  assert.notEqual(record.status, "completed");
});

test("unknown provider outcome and process recovery never blind retry or adopt an unbound SID", async (t) => {
  const f = await workflowFixture(t);
  const store = new VoiceStore(f.pool, { now: f.now });
  let attempts = 0;
  const sms = new VoiceSms(f.pool, {
    now: f.now,
    appUrl,
    provider: {
      async send() {
        attempts++;
        throw new SmsDispatchError("uncertain");
      },
    },
  });
  const call = await store.beginInbound({ sid: `CA${"3".repeat(32)}`, from: caller });
  await f.pool.query("UPDATE voice_calls SET caller_number=$2 WHERE id=$1", [call.id, caller]);
  const prepared = await sms.prepare(call.id, { template: "portal_link", toolCallId: "portal" });
  assert.equal((await sms.confirm(call.id, prepared.sms.id)).sms.status, "unknown");
  assert.equal((await sms.confirm(call.id, prepared.sms.id)).sms.status, "unknown");
  assert.equal(
    (await sms.result(prepared.sms.id, { messageSid, status: "delivered" })).status,
    "unknown",
  );
  await f.pool.query("UPDATE voice_sms SET status='dispatching' WHERE id=$1", [prepared.sms.id]);
  f.setNow(new Date(f.now().getTime() + 61_000));
  await new VoiceSms(f.pool, { now: f.now, appUrl }).reconcileStale();
  assert.equal((await sms.confirm(call.id, prepared.sms.id)).sms.status, "unknown");
  assert.equal(attempts, 1);
});

test("opt-out failure stays failed and cancellation consumes only the prepared SMS", async (t) => {
  const f = await workflowFixture(t);
  const store = new VoiceStore(f.pool, { now: f.now });
  let attempts = 0;
  const sms = new VoiceSms(f.pool, {
    now: f.now,
    appUrl,
    provider: {
      async send() {
        attempts++;
        throw new SmsDispatchError("rejected", "21610");
      },
    },
  });
  const call = await store.beginInbound({ sid: `CA${"4".repeat(32)}`, from: caller });
  await f.pool.query("UPDATE voice_calls SET caller_number=$2 WHERE id=$1", [call.id, caller]);
  const first = await sms.prepare(call.id, { template: "portal_link", toolCallId: "cancel" });
  assert.equal((await sms.cancel(call.id, first.sms.id)).status, "cancelled");
  assert.equal((await sms.confirm(call.id, first.sms.id)).sms.status, "cancelled");
  const second = await sms.prepare(call.id, { template: "portal_link", toolCallId: "send" });
  const sent = await sms.confirm(call.id, second.sms.id);
  assert.equal(sent.sms.status, "failed");
  assert.equal(sent.sms.lastError, "sms_recipient_opted_out");
  assert.equal((await sms.confirm(call.id, second.sms.id)).sms.status, "failed");
  assert.equal(attempts, 1);
});

test("appointment SMS rejects other patients and expired or changed previews", async (t) => {
  const f = await workflowFixture(t);
  const store = new VoiceStore(f.pool, { now: f.now });
  const call = await store.simulate(f.patient, (await store.issueCode(f.patient)).code);
  const sms = new VoiceSms(f.pool, { now: f.now, appUrl });
  await assert.rejects(
    sms.prepare(call.id, {
      template: "appointment_summary",
      appointmentId: "nonexistent",
      toolCallId: "other",
    }),
    { code: "not_found" },
  );
  const prepared = await sms.prepare(call.id, {
    template: "appointment_summary",
    appointmentId: f.input.appointmentId,
    toolCallId: "appointment",
  });
  assert.match(prepared.sms.body, /America\/Halifax/);
  assert.match(prepared.sms.body, /current appointment/i);
  assert.match(prepared.pendingAction!.description, /January.*America\/Halifax/);
  assert.doesNotMatch(prepared.pendingAction!.description, /https:|Reply STOP|Press/);
  await f.pool.query("UPDATE scheduler_bookings SET version=version+1 WHERE id=$1", [
    f.input.appointmentId,
  ]);
  await assert.rejects(sms.confirm(call.id, prepared.sms.id), { code: "sms_content_changed" });
  assert.equal((await sms.confirm(call.id, prepared.sms.id)).sms.status, "cancelled");
  const next = await sms.prepare(call.id, { template: "portal_link", toolCallId: "expire" });
  f.setNow(new Date(f.now().getTime() + 300_001));
  await assert.rejects(sms.confirm(call.id, next.sms.id), { code: "pending_action_expired" });
});

test("prepared personal SMS rechecks principal authorization before send", async (t) => {
  const f = await workflowFixture(t);
  const store = new VoiceStore(f.pool, { now: f.now });
  const call = await store.simulate(f.patient, (await store.issueCode(f.patient)).code);
  const sms = new VoiceSms(f.pool, { now: f.now, appUrl });
  const prepared = await sms.prepare(call.id, {
    template: "appointment_summary",
    appointmentId: f.input.appointmentId,
    toolCallId: "appointment",
  });
  await f.pool.query("UPDATE principals SET active=false WHERE id=$1", [f.patient.id]);
  await assert.rejects(sms.confirm(call.id, prepared.sms.id), { code: "unauthorized" });
  assert.equal(
    (await f.pool.query("SELECT status FROM voice_sms WHERE id=$1", [prepared.sms.id])).rows[0]
      .status,
    "cancelled",
  );
});

test("pending SMS follows keypad cancellation, explicit end and dropped call lifecycle", async (t) => {
  const f = await workflowFixture(t);
  const store = new VoiceStore(f.pool, { now: f.now });
  const sms = new VoiceSms(f.pool, {
    now: f.now,
    appUrl,
    provider: {
      async send() {
        throw new Error("must not send");
      },
    },
  });
  for (const [index, stop] of [
    (id: string) => store.cancelPending(id),
    (id: string) => store.end(id, "portal_ended"),
    (id: string) => store.streamClosed(id, "twilio_stop"),
  ].entries()) {
    const call = await store.beginInbound({
      sid: `CA${String(index + 5).repeat(32)}`,
      from: caller,
    });
    const prepared = await sms.prepare(call.id, { template: "portal_link", toolCallId: "portal" });
    await stop(call.id);
    const row = (
      await f.pool.query("SELECT status,last_error FROM voice_sms WHERE id=$1", [prepared.sms.id])
    ).rows[0];
    assert.equal(row.status, "cancelled");
    assert.equal(row.last_error, index === 0 ? "caller_cancelled" : "call_ended");
    assert.equal((await store.getInternal(call.id)).pendingAction, null);
    assert.equal((await sms.confirm(call.id, prepared.sms.id)).sms.status, "cancelled");
  }
});

test("outbound SMS uses the current call destination and rejects changed destinations and wrong-call approvals", async (t) => {
  const f = await workflowFixture(t);
  const store = new VoiceStore(f.pool, { now: f.now });
  const sms = new VoiceSms(f.pool, {
    now: f.now,
    appUrl,
    provider: {
      async send() {
        throw new Error("must not send");
      },
    },
  });
  const call = await store.beginInbound({ sid: `CA${"8".repeat(32)}`, from: caller });
  await f.pool.query(
    "UPDATE voice_calls SET direction='outbound',recipient_number='+15555550103' WHERE id=$1",
    [call.id],
  );
  const prepared = await sms.prepare(call.id, { template: "portal_link", toolCallId: "portal" });
  assert.equal(prepared.sms.maskedRecipient, "***0103");
  const other = await store.beginInbound({ sid: `CA${"9".repeat(32)}`, from: caller });
  await assert.rejects(sms.confirm(other.id, prepared.sms.id), { code: "not_found" });
  await f.pool.query("UPDATE voice_calls SET recipient_number='+15555550104' WHERE id=$1", [
    call.id,
  ]);
  await assert.rejects(sms.confirm(call.id, prepared.sms.id), { code: "sms_destination_changed" });
  const audit = (await f.pool.query("SELECT detail FROM voice_events WHERE call_id=$1", [call.id]))
    .rows;
  assert.ok(!JSON.stringify(audit).includes("+1555555"));
  assert.ok(!JSON.stringify(audit).includes("https://"));
});

test("personal templates exclude private notes and cannot read another patient's existing booking", async (t) => {
  const f = await workflowFixture(t);
  const task = await f.proposed();
  await f.pool.query(
    "UPDATE tasks SET payload=jsonb_set(payload,'{summary}',to_jsonb('private clinical note'::text)) WHERE id=$1",
    [task.id],
  );
  const store = new VoiceStore(f.pool, { now: f.now });
  const sms = new VoiceSms(f.pool, { now: f.now, appUrl });
  const call = await store.simulate(f.patient, (await store.issueCode(f.patient, task.id)).code);
  const prepared = await sms.prepare(call.id, { template: "request_status", toolCallId: "status" });
  assert.ok(!prepared.sms.body.includes("private clinical"));
  await sms.cancel(call.id, prepared.sms.id);
  await f.pool.query(
    "UPDATE scheduler_bookings SET patient_id='synthetic-patient-other' WHERE id=$1",
    [f.input.appointmentId],
  );
  await assert.rejects(
    sms.prepare(call.id, {
      template: "appointment_summary",
      appointmentId: f.input.appointmentId,
      toolCallId: "other",
    }),
    { code: "not_found" },
  );
});

for (const outcome of ["delivered", "failed"] as const)
  test(`early ${outcome} evidence waits for and reconciles only the exact REST acknowledgement`, async (t) => {
    const f = await workflowFixture(t);
    const store = new VoiceStore(f.pool, { now: f.now });
    let acknowledge!: (value: { sid: string; status: string }) => void;
    let dispatched!: () => void;
    const started = new Promise<void>((resolve) => {
      dispatched = resolve;
    });
    const ack = new Promise<{ sid: string; status: string }>((resolve) => {
      acknowledge = resolve;
    });
    const sms = new VoiceSms(f.pool, {
      now: f.now,
      appUrl,
      provider: {
        async send() {
          dispatched();
          return ack;
        },
      },
    });
    const call = await store.beginInbound({ sid: `CA${"a".repeat(32)}`, from: caller });
    const prepared = await sms.prepare(call.id, { template: "portal_link", toolCallId: "portal" });
    const sending = sms.confirm(call.id, prepared.sms.id);
    await started;
    const callbackService = new VoiceSms(f.pool, { now: f.now, appUrl });
    const unrelatedSid = `SM${"b".repeat(32)}`;
    assert.equal(
      (
        await callbackService.result(prepared.sms.id, {
          messageSid: unrelatedSid,
          status: outcome === "failed" ? "delivered" : "failed",
        })
      ).status,
      "dispatching",
    );
    assert.equal(
      (
        await callbackService.result(prepared.sms.id, {
          messageSid,
          status: outcome,
          ...(outcome === "failed" ? { errorCode: "21610" } : {}),
        })
      ).status,
      "dispatching",
    );
    await callbackService.result(prepared.sms.id, { messageSid, status: "sent" });
    assert.equal(
      (
        await f.pool.query("SELECT * FROM voice_sms_status_evidence WHERE sms_id=$1", [
          prepared.sms.id,
        ])
      ).rowCount,
      3,
    );
    const beforeAck = (
      await f.pool.query("SELECT status,provider_sid FROM voice_sms WHERE id=$1", [prepared.sms.id])
    ).rows[0];
    assert.deepEqual(beforeAck, { status: "dispatching", provider_sid: null });
    acknowledge({ sid: messageSid, status: "queued" });
    const result = await sending;
    assert.equal(result.sms.status, outcome);
    assert.equal(result.sms.lastError, outcome === "failed" ? "sms_recipient_opted_out" : null);
    assert.equal(
      (
        await f.pool.query("SELECT * FROM voice_sms_status_evidence WHERE sms_id=$1", [
          prepared.sms.id,
        ])
      ).rowCount,
      0,
    );
    assert.equal(
      (await sms.result(prepared.sms.id, { messageSid, status: "queued" })).status,
      outcome,
    );
    assert.equal(
      (
        await sms.result(prepared.sms.id, {
          messageSid,
          status: outcome === "failed" ? "delivered" : "failed",
        })
      ).status,
      outcome,
    );
    await assert.rejects(
      sms.result(prepared.sms.id, { messageSid: unrelatedSid, status: "delivered" }),
      { code: "provider_sid_mismatch" },
    );
  });

test("unknown sends keep bounded early evidence without adopting any SID or retrying", async (t) => {
  const f = await workflowFixture(t);
  const store = new VoiceStore(f.pool, { now: f.now });
  let attempts = 0;
  const sms = new VoiceSms(f.pool, {
    now: f.now,
    appUrl,
    provider: {
      async send() {
        attempts++;
        throw new SmsDispatchError("uncertain");
      },
    },
  });
  const call = await store.beginInbound({ sid: `CA${"a".repeat(32)}`, from: caller });
  const prepared = await sms.prepare(call.id, { template: "portal_link", toolCallId: "portal" });
  await assert.rejects(sms.result(prepared.sms.id, { messageSid, status: "delivered" }), {
    code: "provider_sid_mismatch",
  });
  await sms.confirm(call.id, prepared.sms.id);
  for (let i = 0; i < 25; i++) {
    const input = { messageSid: `SM${i.toString(16).padStart(32, "0")}`, status: "delivered" };
    assert.equal((await sms.result(prepared.sms.id, input)).status, "unknown");
    await sms.result(prepared.sms.id, input);
  }
  assert.equal(
    (
      await f.pool.query("SELECT * FROM voice_sms_status_evidence WHERE sms_id=$1", [
        prepared.sms.id,
      ])
    ).rowCount,
    16,
  );
  assert.equal((await sms.confirm(call.id, prepared.sms.id)).sms.status, "unknown");
  assert.equal(
    (await f.pool.query("SELECT provider_sid FROM voice_sms WHERE id=$1", [prepared.sms.id]))
      .rows[0].provider_sid,
    null,
  );
  assert.equal(attempts, 1);
});
