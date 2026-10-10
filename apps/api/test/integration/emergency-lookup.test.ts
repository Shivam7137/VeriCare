import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { VoiceAgent, voiceAgentTools } from "../../src/voice-agent.js";
import { BackendError } from "../../src/domain.js";
import { SmsDispatchError, type SmsProvider } from "../../src/twilio-sms.js";
import { workflowFixture } from "./workflow-fixture.js";
import { seedEmergencyDemo } from "../../src/emergency-demo.js";

const contact = { contactName: "Jamie Singh", relationship: "Friend", resend: false };
const patient = { patientName: "Maya Chen", dateOfBirth: "1990-04-12" };
const registeredPhone = "+15005550006";
const rejects = (code: string) => (error: unknown) =>
  error instanceof BackendError && error.code === code;

async function fixture(t: TestContext, provider?: SmsProvider) {
  assert.ok(
    voiceAgentTools.some((tool) => tool.name === "identify_emergency_patient"),
    "patient lookup tool must be available",
  );
  const f = await workflowFixture(t);
  await f.pool.query("UPDATE patients SET display_name='Maya Chen' WHERE id=$1", [
    f.patient.patientId,
  ]);
  await f.pool.query(
    `INSERT INTO emergency_patient_records
    (patient_id,date_of_birth,contact_name,contact_relationship,contact_number,facility,department,area,visitor_instructions)
    VALUES ($1,'1990-04-12','Jamie Singh','Friend',$2,'Fictional Halifax hospital','Emergency department','Assessment area B','Check in at the emergency reception desk.')`,
    [f.patient.patientId, registeredPhone],
  );
  const sent: { smsId: string; to: string; body: string }[] = [];
  const agent = new VoiceAgent(f.pool, {
    now: f.now,
    smsProvider: provider ?? {
      send: async (input) => {
        sent.push(input);
        return { sid: `SM${String(sent.length).padStart(32, "0")}`, status: "queued" };
      },
    },
  });
  const call = await agent.store.beginInbound({
    sid: "CA-emergency",
    from: "+15005550009",
    departmentId: "demo-department",
  });
  let serial = 0;
  const run = (name: string, args: Record<string, unknown> = {}, id = `tool-${++serial}`) =>
    agent.run(call.id, id, name, args) as Promise<any>;
  const identify = () => run("identify_emergency_patient", patient);
  const send = (resend = false, id?: string) =>
    run("send_emergency_contact_code", { ...contact, resend }, id);
  const code = () => /\b\d{8}\b/.exec(sent.at(-1)!.body)![0];
  return { ...f, agent, call, sent, run, identify, send, code };
}

test("emergency lookup verifies the registered contact before revealing location without granting patient authority", async (t) => {
  const f = await fixture(t);
  const matched = await f.identify();
  assert.equal(matched.status, "patient_matched");
  assert.equal(JSON.stringify(matched).includes("Assessment"), false);
  assert.equal(JSON.stringify(matched).includes("Jamie"), false);
  assert.equal(
    (await f.run("get_emergency_patient_location")).status,
    "contact_verification_required",
  );
  const challenge = await f.send();
  assert.equal(challenge.status, "authorization_required");
  assert.equal(challenge.scope, "emergency_contact");
  assert.equal(challenge.digits, 8);
  assert.equal(f.sent[0]!.to, registeredPhone);
  assert.equal(f.sent[0]!.body.includes("Maya"), false);
  assert.equal(JSON.stringify(challenge).includes(f.code()), false);
  assert.equal(((await f.agent.verifyCode(f.call.id, f.code())) as any).role, "emergency_contact");
  const located = await f.run("get_emergency_patient_location");
  assert.equal(located.status, "location_available");
  assert.equal(located.location.area, "Assessment area B");
  assert.equal(located.synthetic, true);
  assert.equal((await f.agent.store.sessionState(f.call.id)).verified, false);
  await assert.rejects(f.agent.store.bound(f.call.id), rejects("voice_unverified"));
  assert.equal((await f.run("list_appointments")).status, "authorization_required");
  const stored = JSON.stringify(
    (await f.pool.query("SELECT * FROM voice_sms WHERE call_id=$1", [f.call.id])).rows,
  );
  assert.equal(stored.includes(f.code()), false);
  const sms = await f.agent.sms.list(f.staff, f.call.id);
  assert.match(sms[0]!.body, /redacted/);
});

test("spoken SMS digits verify only the emergency contact and share the same code consumption as the keypad", async (t) => {
  const f = await fixture(t);
  await f.identify();
  await f.send();
  const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
  const spoken = [...f.code()].map((digit) => words[Number(digit)]).join(" ");
  const result = await f.run("verify_emergency_contact_code", { code: spoken });
  assert.equal(result.status, "verified");
  assert.equal(result.role, "emergency_contact");
  assert.equal((await f.run("get_emergency_patient_location")).status, "location_available");
  assert.equal((await f.agent.store.sessionState(f.call.id)).verified, false);
  assert.equal(
    ((await f.agent.verifyCode(f.call.id, f.code())) as any).status,
    "verification_failed",
  );
  const stored = JSON.stringify(
    (await f.pool.query("SELECT * FROM voice_events WHERE call_id=$1", [f.call.id])).rows,
  );
  assert.equal(stored.includes(f.code()), false);
  assert.equal(stored.includes(spoken), false);
});

test("unclear spoken codes are not guessed or counted; wrong complete codes use the existing five-attempt limit", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.run("verify_emergency_contact_code", { code: "12345678" })).status,
    "patient_details_required",
  );
  await f.identify();
  await f.send();
  for (const code of [
    "one two three",
    "twenty three four five six seven eight",
    "my code is 12345678",
    "123456789",
  ]) {
    assert.equal(
      (await f.run("verify_emergency_contact_code", { code })).status,
      "spoken_code_unclear",
    );
  }
  const count = await f.pool.query(
    "SELECT verification_failures FROM voice_emergency_sessions WHERE call_id=$1",
    [f.call.id],
  );
  assert.equal(count.rows[0].verification_failures, 0);
  const wrong = f.code() === "00000000" ? "11111111" : "00000000";
  for (let attempt = 0; attempt < 5; attempt++) {
    assert.equal(
      (await f.run("verify_emergency_contact_code", { code: wrong })).status,
      attempt === 4 ? "verification_locked" : "verification_failed",
    );
  }
  assert.equal(
    (await f.run("verify_emergency_contact_code", { code: f.code() })).status,
    "verification_locked",
  );
});

test("spaced spoken digits preserve leading zeroes", async (t) => {
  const f = await fixture(t);
  await f.identify();
  await f.send();
  const { hash } = await import("../../src/voice-store-support.js");
  await f.pool.query("UPDATE voice_emergency_codes SET code_hash=$2 WHERE sms_id=$1", [
    f.sent[0]!.smsId,
    hash(`${f.sent[0]!.smsId}:01234567`),
  ]);
  const result = await f.run("verify_emergency_contact_code", {
    code: "oh, one two three four five six seven",
  });
  assert.equal(result.status, "verified");
});

test("a pending SMS challenge resumes verification without recollecting contact identity or resending", async (t) => {
  const f = await fixture(t);
  await f.identify();
  await f.send();
  const result = await f.run("get_emergency_patient_location");
  assert.equal(result.status, "authorization_required");
  assert.equal(result.scope, "emergency_contact");
  assert.equal(result.method, "speech_or_keypad");
  assert.equal(f.sent.length, 1);
});

test("patient matching needs full name and birthday; contact claims and arbitrary destinations do not authorize lookup", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.run("identify_emergency_patient", { ...patient, dateOfBirth: "1991-04-12" })).status,
    "patient_not_matched",
  );
  assert.equal(
    (await f.run("identify_emergency_patient", { ...patient, patientName: "Maya" })).status,
    "patient_not_matched",
  );
  await f.identify();
  assert.equal(
    (await f.run("send_emergency_contact_code", { ...contact, contactName: "Other Person" }))
      .status,
    "contact_not_matched",
  );
  assert.equal(
    (await f.run("send_emergency_contact_code", { ...contact, relationship: "Sibling" })).status,
    "contact_not_matched",
  );
  await assert.rejects(f.run("send_emergency_contact_code", { ...contact, to: "+15005550001" }));
  assert.equal(f.sent.length, 0);
  assert.equal(
    (await f.run("get_emergency_patient_location")).status,
    "contact_verification_required",
  );
});

test("replayed and concurrent code requests send once; explicit resend invalidates the old code", async (t) => {
  const f = await fixture(t);
  await f.identify();
  await Promise.all([
    f.send(false, "same-tool"),
    f.send(false, "same-tool"),
    f.send(false, "other-tool"),
  ]);
  assert.equal(f.sent.length, 1);
  const old = f.code();
  assert.equal((await f.send(true)).status, "code_resend_wait");
  f.setNow(new Date(f.now().getTime() + 61_000));
  await f.send(true);
  assert.equal(f.sent.length, 2);
  assert.equal(((await f.agent.verifyCode(f.call.id, old)) as any).status, "verification_failed");
  assert.equal(((await f.agent.verifyCode(f.call.id, f.code())) as any).status, "verified");
  assert.equal(
    ((await f.agent.verifyCode(f.call.id, f.code())) as any).status,
    "verification_failed",
  );
});

test("expired and cross-call codes fail; five wrong codes lock verification", async (t) => {
  const f = await fixture(t);
  await f.identify();
  await f.send();
  const other = await f.agent.store.beginInbound({
    sid: "CA-other",
    from: "+15005550009",
    departmentId: "demo-department",
  });
  await assert.rejects(f.agent.verifyCode(other.id, f.code()), rejects("invalid_voice_code"));
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = (await f.agent.verifyCode(f.call.id, "not-a-code")) as any;
    assert.equal(result.status, attempt === 4 ? "verification_locked" : "verification_failed");
  }
  assert.equal(
    ((await f.agent.verifyCode(f.call.id, f.code())) as any).status,
    "verification_locked",
  );
  assert.equal((await f.send(true)).status, "verification_locked");
  assert.equal(
    (await f.run("get_emergency_patient_location")).status,
    "contact_verification_required",
  );
});

test("a code expires after five minutes and changed patient details clear verified scope", async (t) => {
  const f = await fixture(t);
  await f.identify();
  await f.send();
  f.setNow(new Date(f.now().getTime() + 300_000));
  assert.equal(((await f.agent.verifyCode(f.call.id, f.code())) as any).status, "code_expired");
  await f.send(true);
  assert.equal(((await f.agent.verifyCode(f.call.id, f.code())) as any).status, "verified");
  await f.run("identify_emergency_patient", { ...patient, dateOfBirth: "1980-01-01" });
  assert.equal((await f.run("get_emergency_patient_location")).status, "patient_details_required");
});

test("changing the registered contact or withholding disclosure revokes prior verification", async (t) => {
  const f = await fixture(t);
  await f.identify();
  await f.send();
  await f.agent.verifyCode(f.call.id, f.code());
  await f.pool.query(
    "UPDATE emergency_patient_records SET contact_number='+15005550001' WHERE patient_id=$1",
    [f.patient.patientId],
  );
  assert.equal(
    (await f.run("get_emergency_patient_location")).status,
    "contact_verification_required",
  );
  await f.pool.query(
    "UPDATE emergency_patient_records SET location_shareable=false WHERE patient_id=$1",
    [f.patient.patientId],
  );
  assert.notEqual((await f.run("get_emergency_patient_location")).status, "location_available");
});

test("provider rejection is reported without exposing a code or retrying automatically", async (t) => {
  let attempts = 0;
  const f = await fixture(t, {
    send: async () => {
      attempts++;
      throw new SmsDispatchError("rejected", "21610");
    },
  });
  await f.identify();
  const result = await f.send(false, "failed-send");
  assert.equal(result.status, "code_send_failed");
  await f.send(false, "failed-send");
  assert.equal(attempts, 1);
  assert.equal((await f.run("get_emergency_patient_location")).status, "code_send_failed");
});

test("delivery callbacks arriving before acknowledgment reconcile with the acknowledged message", async (t) => {
  const sid = `SM${"8".repeat(32)}`;
  const f = await fixture(t, {
    send: async (input) => {
      await f.agent.sms.result(input.smsId, { messageSid: sid, status: "delivered" });
      return { sid, status: "queued" };
    },
  });
  await f.identify();
  const result = await f.send();
  assert.equal(result.smsStatus, "delivered");
  assert.equal((await f.agent.sms.list(f.staff, f.call.id))[0]!.status, "delivered");
});

test("uncertain SMS dispatch does not resend automatically but a received code can verify", async (t) => {
  let body = "",
    sends = 0;
  const f = await fixture(t, {
    send: async (input) => {
      sends++;
      body = input.body;
      throw new SmsDispatchError("uncertain");
    },
  });
  await f.identify();
  assert.equal((await f.send()).smsStatus, "unknown");
  assert.equal((await f.send()).smsStatus, "unknown");
  assert.equal(sends, 1);
  const code = /\b\d{8}\b/.exec(body)![0];
  assert.equal(((await f.agent.verifyCode(f.call.id, code)) as any).status, "verified");
});

test("a new contact claim and a refused patient match clear prior verified scope", async (t) => {
  const f = await fixture(t);
  await f.identify();
  await f.send();
  await f.agent.verifyCode(f.call.id, f.code());
  await f.run("send_emergency_contact_code", { ...contact, contactName: "Someone Else" });
  assert.equal(
    (await f.run("get_emergency_patient_location")).status,
    "contact_verification_required",
  );
  f.setNow(new Date(f.now().getTime() + 61_000));
  await f.send(true);
  await f.agent.verifyCode(f.call.id, f.code());
  for (let i = 0; i < 9; i++) await f.identify();
  const refused = await f.run("identify_emergency_patient", {
    ...patient,
    patientName: "Another Patient",
  });
  assert.equal(refused.status, "patient_lookup_limit");
  assert.equal((await f.run("get_emergency_patient_location")).status, "patient_details_required");
});

test("closed calls cannot verify or reveal location, and expired verification requires a fresh code", async (t) => {
  const f = await fixture(t);
  await f.identify();
  await f.send();
  await f.agent.verifyCode(f.call.id, f.code());
  f.setNow(new Date(f.now().getTime() + 900_000));
  assert.equal(
    (await f.run("get_emergency_patient_location")).status,
    "contact_verification_required",
  );
  await f.agent.store.end(f.call.id, "hangup");
  await assert.rejects(f.agent.verifyCode(f.call.id, f.code()), rejects("call_ended"));
  await assert.rejects(f.run("get_emergency_patient_location"), rejects("call_ended"));
});

test("concurrent incorrect codes respect the five-attempt limit", async (t) => {
  const f = await fixture(t);
  await f.identify();
  await f.send();
  const results = await Promise.all(
    Array.from({ length: 6 }, () => f.agent.verifyCode(f.call.id, "wrong")),
  );
  const count = (
    await f.pool.query(
      "SELECT verification_failures FROM voice_emergency_sessions WHERE call_id=$1",
      [f.call.id],
    )
  ).rows[0].verification_failures;
  assert.equal(count, 5);
  assert.equal(results.filter((result: any) => result.status === "verification_locked").length, 2);
  assert.equal(
    ((await f.agent.verifyCode(f.call.id, f.code())) as any).status,
    "verification_locked",
  );
});

test("emergency demo setup preserves birthdays and locations while applying private contact configuration", async (t) => {
  const f = await fixture(t);
  const before = (
    await f.pool.query("SELECT * FROM emergency_patient_records WHERE patient_id=$1", [
      f.patient.patientId,
    ])
  ).rows[0];
  const config = {
    DEMO_EMERGENCY_CONTACT_NAME: "Private Demo Contact",
    DEMO_EMERGENCY_CONTACT_RELATIONSHIP: "Friend",
    DEMO_EMERGENCY_CONTACT_PHONE: "+15005550001",
  };
  const seeded = await seedEmergencyDemo(f.pool, config);
  assert.equal(seeded.populated, 1);
  await seedEmergencyDemo(f.pool, config);
  const after = (
    await f.pool.query("SELECT * FROM emergency_patient_records WHERE patient_id=$1", [
      f.patient.patientId,
    ])
  ).rows[0];
  assert.deepEqual(after.date_of_birth, before.date_of_birth);
  assert.equal(after.facility, before.facility);
  assert.equal(after.area, before.area);
  assert.equal(after.contact_number, config.DEMO_EMERGENCY_CONTACT_PHONE);
  await assert.rejects(seedEmergencyDemo(f.pool, {}));
});
