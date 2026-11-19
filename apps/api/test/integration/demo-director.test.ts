import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { buildApp } from "../../src/app.js";
import { createSession } from "../../src/identity.js";
import { createDemoDirector, type DemoState } from "../../src/journey/demo/director.js";
import { judgePhone } from "../../src/journey/demo/contact.js";
import { missionView } from "../../src/journey/insight.js";
import { addContact } from "../../src/journey/intake.js";
import { registerDemoRoutes } from "../../src/journey/demo/routes.js";
import { workflowFixture } from "./workflow-fixture.js";

const MIN = 60_000;
type Live = Extract<DemoState, { active: true }>;
const live = (state: DemoState): Live => {
  assert.equal(state.active, true);
  return state as Live;
};

test("the demo director runs a department a judge can steer", async (t) => {
  const f = await workflowFixture(t);
  // Maya's emergency record lets her visit link to the patient session.
  await f.pool.query("UPDATE patients SET display_name='Maya Chen' WHERE id=$1", [
    f.patient.patientId,
  ]);
  await f.pool.query(
    `INSERT INTO emergency_patient_records
    (patient_id,date_of_birth,contact_name,contact_relationship,contact_number,facility,department,area,visitor_instructions)
    VALUES ($1,'1990-04-12','Jamie Singh','Friend','+15005550006','Fictional Halifax hospital','Emergency department','Assessment area B','Check in at reception.')`,
    [f.patient.patientId],
  );
  let wall = Date.parse("2030-01-07T12:00:30.000Z");
  const now = () => new Date(wall);
  const director = createDemoDirector(f.pool, { now, seed: 5 });

  // Nothing exists yet, so the bar offers to start the demo.
  assert.deepEqual(await director.state(), { active: false });
  await assert.rejects(director.act({ type: "play" }), { code: "demo_not_started" });

  // Starting seeds the department, paused, with Maya at the front desk.
  wall += 5_000;
  const started = live((await director.act({ type: "reset" })).state);
  assert.equal(started.running, false);
  assert.equal(started.counts.waiting >= 5, true);
  const maya = started.patients.find((patient) => patient.name === "Maya Chen")!;
  assert.equal(maya.step, "arrived");
  assert.equal(maya.next, "Triage assessment");
  // Staff land on the demo patient's visit, and the patient's own app finds their visit as "mine".
  assert.equal(started.focus?.name, "Maya Chen");
  assert.equal(started.focus?.mine, false);
  const asPatient = live(await director.state({ patientId: f.patient.patientId }));
  assert.equal(asPatient.focus?.name, "Maya Chen");
  assert.equal(asPatient.focus?.mine, true);
  assert.equal(asPatient.patients[0]?.mine, true);
  // The eight edge-case visits follow their own script and cannot be nudged.
  assert.equal(
    started.patients.filter((patient) => patient.scripted).every((p) => p.next === null),
    true,
  );
  assert.ok(started.model.waiting >= 5);
  assert.equal(typeof started.model.medianMinutes, "number");

  // Adding patients fills the waiting room, and the model moves with it.
  wall += 5_000;
  const beforeAdd = started.model.medianMinutes!;
  const added = live((await director.act({ type: "add", count: 5 })).state);
  assert.equal(added.counts.waiting, started.counts.waiting + 5);
  assert.ok(added.model.medianMinutes! >= beforeAdd);
  wall += 5_000;
  const surged = live((await director.act({ type: "surge" })).state);
  assert.equal(surged.counts.waiting, added.counts.waiting + 5);
  assert.ok(surged.patients.filter((patient) => patient.ctas === 2).length >= 4);
  assert.ok(surged.recent.length > 0);

  // "Next step" walks one visit all the way home, one honest step at a time.
  const path: string[] = [];
  wall += 5_000;
  for (let index = 0; index < 8; index += 1) {
    const current = live(await director.state({ encounterId: maya.id }));
    if (!current.focus) break;
    path.push(current.focus.step);
    assert.ok(current.focus.next);
    wall += 1_000;
    await director.act({ type: "next", patientId: maya.id });
  }
  assert.deepEqual(path, ["arrived", "waiting", "being_seen", "being_seen", "deciding"]);
  const gone = live(await director.state({ encounterId: maya.id }));
  assert.equal(gone.focus, null);
  const ended = await f.pool.query(
    "SELECT state->>'step' AS step FROM ed_encounters WHERE visit_number = 'FIN5500001'",
  );
  assert.equal(ended.rows[0].step, "discharged");

  // Time passes on its own. Two simulated hours later people have been seen and sent home.
  wall += 5_000;
  const before = live(await director.state());
  await director.act({ type: "skip", minutes: 120 });
  for (let guard = 0; guard < 80; guard += 1) {
    wall += 1_000;
    await director.tick();
    if (live(await director.state()).skipping === null) break;
  }
  const after = live(await director.state());
  assert.equal(after.skipping, null);
  assert.equal(Date.parse(after.clock) - Date.parse(before.clock), 120 * MIN);
  assert.ok(after.counts.finished > before.counts.finished);
  assert.ok(after.counts.beingSeen > 0 || after.counts.boarding > 0);

  // The estimates the model made along the way were logged and scored against what happened.
  const logged = await f.pool.query(
    "SELECT count(*)::int AS n, count(actual_minutes)::int AS scored FROM ed_stage_estimates",
  );
  assert.ok(logged.rows[0].n > 20);
  assert.ok(logged.rows[0].scored > 0);

  // Speed, pause and the two levers are plain settings.
  const fast = live((await director.act({ type: "speed", value: 300 })).state);
  assert.equal(fast.speed, 300);
  assert.equal(fast.running, true);
  assert.equal(live((await director.act({ type: "pause" })).state).running, false);
  assert.equal(
    live((await director.act({ type: "arrivals", value: "busy" })).state).arrivals,
    "busy",
  );
  assert.equal(
    live((await director.act({ type: "staffing", value: "high" })).state).staffing,
    "high",
  );

  // A department that was running keeps its clock moving: with arrivals off it empties out.
  await director.act({ type: "arrivals", value: "off" });
  await director.runTo(director.clock() + 12 * 60 * MIN);
  const quiet = live(await director.state());
  assert.equal(quiet.counts.waiting, 0);
  assert.equal(quiet.counts.arrived, 0);
});

test("only signed-in staff and patients reach the control bar, and bad input is refused", async (t) => {
  const f = await workflowFixture(t);
  const director = createDemoDirector(f.pool, { now: f.now, seed: 1 });
  const app = Fastify({ logger: false });
  registerDemoRoutes(app, f.pool, { now: f.now, director });
  await app.ready();
  t.after(() => app.close());
  const expires = new Date(f.now().getTime() + 86_400_000);
  const token = async (id: string) => (await createSession(f.pool, id, expires, f.now())).token;
  const staff = await token("synthetic-staff-001");
  const operator = await token("synthetic-operator-001");

  const anonymous = await app.inject({ method: "GET", url: "/journey/demo/state" });
  assert.equal(anonymous.statusCode, 401);
  const refused = await app.inject({
    method: "GET",
    url: "/journey/demo/state",
    headers: { authorization: `Bearer ${operator}` },
  });
  assert.equal(refused.statusCode, 404);

  const idle = await app.inject({
    method: "GET",
    url: "/journey/demo/state",
    headers: { authorization: `Bearer ${staff}` },
  });
  assert.equal(idle.statusCode, 200);
  assert.deepEqual(idle.json(), { active: false });

  const bad = await app.inject({
    method: "POST",
    url: "/journey/demo/act",
    headers: { authorization: `Bearer ${staff}` },
    payload: { type: "speed", value: 9000 },
  });
  assert.equal(bad.statusCode, 400);
  assert.deepEqual(bad.json(), { error: "invalid_input" });

  const early = await app.inject({
    method: "POST",
    url: "/journey/demo/act",
    headers: { authorization: `Bearer ${staff}` },
    payload: { type: "play" },
  });
  assert.equal(early.statusCode, 409);
  assert.deepEqual(early.json(), { error: "demo_not_started" });

  // A body that isn't JSON is the caller's mistake, not a storage failure.
  const garbled = await app.inject({
    method: "POST",
    url: "/journey/demo/act",
    headers: { authorization: `Bearer ${staff}`, "content-type": "application/json" },
    payload: "{not json",
  });
  assert.equal(garbled.statusCode, 400);
  assert.deepEqual(garbled.json(), { error: "invalid_input" });
});

test("the control bar's routes exist only when the synthetic demo is enabled", async (t) => {
  const f = await workflowFixture(t);
  const expires = new Date(f.now().getTime() + 86_400_000);
  const staff = (await createSession(f.pool, "synthetic-staff-001", expires, f.now())).token;
  const ask = async (demoEnabled: boolean) => {
    const app = buildApp(f.pool, demoEnabled);
    await app.ready();
    try {
      return (
        await app.inject({
          method: "GET",
          url: "/journey/demo/state",
          headers: { authorization: `Bearer ${staff}` },
        })
      ).statusCode;
    } finally {
      await app.close();
    }
  };
  assert.equal(await ask(true), 200);
  assert.equal(await ask(false), 404);
});

test("the demo starts over by itself 30 minutes after it was last used, and only if it was used", async (t) => {
  const f = await workflowFixture(t);
  let wall = Date.parse("2030-01-07T12:00:30.000Z");
  const now = () => new Date(wall);
  const director = createDemoDirector(f.pool, { now, seed: 3, idleResetMinutes: 30 });
  wall += 5_000;
  const opening = live((await director.act({ type: "reset" })).state);
  assert.equal(opening.idleReset.minutes, 30);
  assert.equal(opening.idleReset.inMinutes, null);

  // Nobody has touched it, so waiting around never wipes it.
  wall += 45 * MIN;
  await director.tick();
  assert.equal(live(await director.state()).idleReset.lastAutoReset, null);

  // Someone uses it: speed and staffing changed, patients added.
  await director.act({ type: "staffing", value: "low" });
  await director.act({ type: "speed", value: 300 });
  const used = live((await director.act({ type: "add", count: 5 })).state);
  assert.equal(used.counts.waiting, opening.counts.waiting + 5);
  assert.equal(used.idleReset.inMinutes, 30);

  // Watching without pressing anything counts down, and nothing happens early.
  wall += 26 * MIN;
  assert.equal(live(await director.state()).idleReset.inMinutes, 4);
  await director.tick();
  assert.equal(live(await director.state()).idleReset.lastAutoReset, null);

  // Past the limit the next tick puts the original demo back, settings included.
  wall += 5 * MIN;
  await director.tick();
  const again = live(await director.state());
  assert.ok(again.idleReset.lastAutoReset);
  assert.equal(again.idleReset.inMinutes, null);
  assert.equal(again.counts.waiting, opening.counts.waiting);
  assert.equal(again.running, false);
  assert.equal(again.speed, 10);
  assert.equal(again.staffing, "normal");
  assert.equal(again.arrivals, "normal");
  // The opening scene is back: Maya freshly checked in, none of the added patients.
  assert.equal(again.patients.find((patient) => patient.name === "Maya Chen")?.step, "arrived");

  // A fresh demo that nobody touches stays as it is, however long it sits.
  wall += 90 * MIN;
  await director.tick();
  assert.equal(live(await director.state()).counts.waiting, opening.counts.waiting);
});

test("the automatic restart can be turned off", async (t) => {
  const f = await workflowFixture(t);
  let wall = Date.parse("2030-01-07T12:00:30.000Z");
  const director = createDemoDirector(f.pool, {
    now: () => new Date(wall),
    seed: 3,
    idleResetMinutes: 0,
  });
  wall += 5_000;
  await director.act({ type: "reset" });
  const used = live((await director.act({ type: "add", count: 3 })).state);
  assert.equal(used.idleReset.minutes, 0);
  assert.equal(used.idleReset.inMinutes, null);
  wall += 600 * MIN;
  await director.tick();
  const later = live(await director.state());
  assert.equal(later.idleReset.lastAutoReset, null);
  assert.equal(later.counts.waiting, used.counts.waiting);
});

test("a patient's bar keeps private visits private and always follows their own visit", async (t) => {
  const f = await workflowFixture(t);
  await f.pool.query("UPDATE patients SET display_name='Maya Chen' WHERE id=$1", [
    f.patient.patientId,
  ]);
  await f.pool.query(
    `INSERT INTO emergency_patient_records
    (patient_id,date_of_birth,contact_name,contact_relationship,contact_number,facility,department,area,visitor_instructions)
    VALUES ($1,'1990-04-12','Jamie Singh','Friend','+15005550006','F','E','A','x')`,
    [f.patient.patientId],
  );
  let wall = Date.parse("2030-01-07T12:00:30.000Z");
  const now = () => new Date(wall);
  const director = createDemoDirector(f.pool, { now, seed: 7 });
  const app = Fastify({ logger: false });
  registerDemoRoutes(app, f.pool, { now, director });
  await app.ready();
  t.after(() => app.close());
  const expires = new Date(wall + 86_400_000);
  const token = async (id: string) => (await createSession(f.pool, id, expires, now())).token;
  const patient = await token("synthetic-patient-001");
  const staff = await token("synthetic-staff-001");
  wall += 5_000;
  await director.act({ type: "reset" });
  // Play far enough for the confidential featured visit (Fatima) to arrive and be flagged.
  await director.runTo(director.clock() + 90 * MIN);

  const read = async (who: string, visit?: string) =>
    live(
      (
        await app.inject({
          method: "GET",
          url: `/journey/demo/state${visit ? `?visit=${visit}` : ""}`,
          headers: { authorization: `Bearer ${who}` },
        })
      ).json(),
    );
  const asStaff = await read(staff);
  const fatima = asStaff.patients.find((item) => item.name.startsWith("Fatima"));
  assert.ok(fatima, "the confidential visit is on the staff list");
  const other = asStaff.patients.find((item) => item.name !== "Maya Chen" && !item.scripted)!;

  const asPatient = await read(patient, other.id);
  // The patient asked about someone else; the bar ignores that and never shows their visit.
  assert.notEqual(asPatient.focus?.id, other.id);
  assert.equal(
    asPatient.patients.some((item) => item.name.startsWith("Fatima")),
    false,
  );
  assert.equal(asPatient.patients.find((item) => item.id === fatima.id)?.name, "Private visit");
  assert.equal(
    asPatient.recent.some((item) => item.text.startsWith("Fatima")),
    false,
  );
  // Staff may still look at any visit.
  assert.equal((await read(staff, other.id)).focus?.id, other.id);
});

test("pressing Reset twice in a row gives one reset, and a restarted API keeps the scripts", async (t) => {
  const f = await workflowFixture(t);
  let wall = Date.parse("2030-01-07T12:00:30.000Z");
  const now = () => new Date(wall);
  const first = createDemoDirector(f.pool, { now, seed: 9 });
  wall += 5_000;
  await first.act({ type: "reset" });
  const again = await first.act({ type: "reset" });
  assert.equal(again.note, "Already a fresh demo.");

  // Play past Fatima's triage (+57 min), then "restart the API" with a new director.
  await first.runTo(first.clock() + 60 * MIN);
  const fatima = async () =>
    (
      await f.pool.query(
        "SELECT state->>'step' AS step FROM ed_encounters WHERE display_name LIKE 'Fatima%'",
      )
    ).rows[0]?.step as string | undefined;
  assert.equal(await fatima(), "waiting");
  const second = createDemoDirector(f.pool, { now, seed: 9 });
  assert.equal(live(await second.state()).running, false);
  // Fatima's script says she is seen at +75 min. The adopted director still plays it.
  await second.runTo(second.clock() + 20 * MIN);
  assert.equal(await fatima(), "being_seen");
});

test("a judge who types their number becomes Maya's emergency contact and gets her texts", async (t) => {
  const f = await workflowFixture(t);
  let wall = Date.parse("2030-01-07T12:00:30.000Z");
  const director = createDemoDirector(f.pool, { now: () => new Date(wall), seed: 5 });
  await assert.rejects(director.act({ type: "contact", name: "", phone: "902 555 0134" }), {
    code: "demo_not_started",
  });
  const started = live((await director.act({ type: "reset" })).state);
  const maya = started.patients.find((patient) => patient.name === "Maya Chen")!;
  await assert.rejects(director.act({ type: "contact", name: "", phone: "12" }), {
    code: "invalid_phone",
  });

  wall += 1_000;
  const added = await director.act({ type: "contact", name: "", phone: "902 555 0134" });
  const contact = added.contact!;
  assert.equal(contact.phone, "••• 0134");
  // Typing the number was the opt-in. There is no web page: the text thread is the experience.
  const row = await f.pool.query(
    "SELECT phone, sms_opt_in_at IS NOT NULL AS opted, scopes FROM ed_contacts WHERE id = $1",
    [contact.id],
  );
  assert.equal(row.rows[0].phone, "+19025550134");
  assert.equal(row.rows[0].opted, true);
  assert.deepEqual(row.rows[0].scopes, ["status", "alerts", "estimates"]);
  const phone = (await judgePhone(f.pool, contact.id))!;
  assert.equal(phone.active, true);
  assert.equal(phone.patientId, maya.id);
  assert.equal(phone.messages.length, 1);
  assert.equal(phone.messages[0]!.direction, "out");
  assert.match(phone.messages[0]!.body, /Maya's emergency contact/);
  assert.doesNotMatch(phone.messages[0]!.body, /https?:/);
  // The welcome went to the text queue like any other text to an opted-in contact.
  const queued = await f.pool.query("SELECT count(*)::int AS n FROM ed_sms WHERE contact_id = $1", [
    contact.id,
  ]);
  assert.equal(queued.rows[0].n, 1);

  // Texting back a question is answered in the same thread, through the Visit Agent's rules.
  wall += 1_000;
  await director.act({ type: "ask", contactId: contact.id, text: "How is she doing?" });
  const thread = (await judgePhone(f.pool, contact.id))!.messages;
  assert.equal(thread.length, 3);
  assert.deepEqual(
    thread.map((message) => message.direction),
    ["out", "in", "out"],
  );
  assert.equal(thread[1]!.body, "How is she doing?");
  assert.ok(thread[0]!.body.length > 0);

  // At speed the department clock runs well ahead of the wall; the answer must still be
  // Maya's status, not the stale-feed handoff.
  await director.runTo(director.clock() + 40 * MIN);
  wall += 1_000;
  await director.act({ type: "ask", contactId: contact.id, text: "Any news?" });
  const answer = (await judgePhone(f.pool, contact.id))!.messages[0]!.body;
  assert.doesNotMatch(answer, /speak with the ER team/);

  // The same number again replaces the old entry; a reset forgets it entirely.
  wall += 1_000;
  const again = await director.act({ type: "contact", name: "Pat", phone: "+1 902 555 0134" });
  assert.equal((await judgePhone(f.pool, contact.id))!.active, false);
  assert.equal((await judgePhone(f.pool, again.contact!.id))!.active, true);
  wall += 10_000;
  await director.act({ type: "reset" });
  assert.equal(await judgePhone(f.pool, again.contact!.id), null);
});

test("Maya waits for a judge, can be re-seated alone, and contact refusals say why", async (t) => {
  const f = await workflowFixture(t);
  const patientId = f.patient.patientId!;
  await f.pool.query("UPDATE patients SET display_name='Maya Chen' WHERE id=$1", [
    f.patient.patientId,
  ]);
  await f.pool.query(
    `INSERT INTO emergency_patient_records
    (patient_id,date_of_birth,contact_name,contact_relationship,contact_number,facility,department,area,visitor_instructions)
    VALUES ($1,'1990-04-12','Jamie Singh','Friend','+15005550006','Fictional Halifax hospital','Emergency department','Assessment area B','Check in at reception.')`,
    [f.patient.patientId],
  );
  let wall = Date.parse("2030-01-07T12:00:30.000Z");
  const now = () => new Date(wall);
  const director = createDemoDirector(f.pool, { now, seed: 5 });
  wall += 5_000;
  const started = live((await director.act({ type: "reset" })).state);
  // A fresh demo is paused and set to Slow, so step 2 is reachable before Maya goes home.
  assert.equal(started.running, false);
  assert.equal(started.speed, 10);

  // Hours pass: Maya is triaged on her own, then waits for a judge while others are seen.
  await director.runTo(director.clock() + 4 * 60 * MIN);
  const later = live(await director.state());
  const maya = later.patients.find((patient) => patient.name === "Maya Chen")!;
  assert.equal(maya.step, "waiting");
  assert.equal(maya.next, "Seen by a provider");
  assert.ok(later.counts.finished > started.counts.finished);

  // The patient adds a family member to the live visit, then the same number again.
  wall += 1_000;
  const contact = { name: "Test Contact", relationship: "Family", phone: "+19025550134" };
  const scopes = ["status", "alerts", "estimates"] as const;
  await addContact(f.pool, patientId, { ...contact, scopes: [...scopes] }, now());
  await assert.rejects(addContact(f.pool, patientId, { ...contact, scopes: [...scopes] }, now()), {
    code: "duplicate_contact",
  });

  // Re-seat: the old visit ends, a new Maya waits, and nobody else is touched.
  wall += 1_000;
  const others = later.patients.filter((patient) => patient.name !== "Maya Chen").length;
  const reseated = live((await director.act({ type: "reseat" })).state);
  const fresh = reseated.patients.find((patient) => patient.name === "Maya Chen")!;
  assert.notEqual(fresh.id, maya.id);
  assert.equal(fresh.step, "waiting");
  assert.equal(reseated.patients.filter((patient) => patient.name !== "Maya Chen").length, others);
  const visits = await f.pool.query<{ visit: string; ended: boolean; linked: boolean }>(
    `SELECT visit_number AS visit, (state->>'ended')::boolean AS ended, patient_id = $1 AS linked
     FROM ed_encounters WHERE visit_number LIKE 'FIN5500001%' ORDER BY created_at`,
    [f.patient.patientId],
  );
  assert.deepEqual(
    visits.rows.map((row) => [row.ended, row.linked]),
    [
      [true, true],
      [false, true],
    ],
  );
  // The contact followed the visit that ended; the new visit starts with none.
  const left = await f.pool.query(
    "SELECT count(*)::int AS n FROM ed_contacts WHERE withdrawn_at IS NULL",
  );
  assert.equal(left.rows[0].n, 0);
  // Maya's app follows the new visit, so adding the same person works again.
  wall += 1_000;
  await addContact(f.pool, patientId, { ...contact, scopes: [...scopes] }, now());

  // A judge walks the new visit home; adding a contact then fails with its reason, on the ledger.
  for (let index = 0; index < 6; index += 1) {
    wall += 1_000;
    const current = live(await director.state({ encounterId: fresh.id }));
    if (!current.focus?.next) break;
    await director.act({ type: "next", patientId: fresh.id });
  }
  wall += 1_000;
  await assert.rejects(
    addContact(f.pool, patientId, { ...contact, phone: "+19025550199", scopes: ["status"] }, now()),
    { code: "no_active_visit" },
  );
  const refused = await f.pool.query<{ reason: string }>(
    "SELECT detail->>'reason' AS reason FROM ed_audit WHERE action = 'contact_refused' ORDER BY seq",
  );
  assert.deepEqual(
    refused.rows.map((row) => row.reason),
    ["duplicate_contact", "no_active_visit"],
  );

  // Re-seating when she has already gone home brings her back too.
  wall += 1_000;
  const back = live((await director.act({ type: "reseat" })).state);
  assert.equal(back.patients.find((patient) => patient.name === "Maya Chen")?.step, "waiting");
});

test("a silenced visit's estimate never reaches the demo bar", async (t) => {
  const f = await workflowFixture(t);
  let wall = Date.parse("2030-01-07T12:00:30.000Z");
  const director = createDemoDirector(f.pool, { now: () => new Date(wall), seed: 5 });
  wall += 5_000;
  const started = live((await director.act({ type: "reset" })).state);
  const someone = started.patients.find(
    (patient) => patient.step === "waiting" && !patient.scripted,
  )!;
  const shown = live(await director.state({ encounterId: someone.id }));
  assert.equal(shown.focus?.silenced, false);
  assert.ok(shown.focus?.estimate);

  await f.pool.query(
    `UPDATE ed_encounters SET state = jsonb_set(state, '{sensitivity}', '["confidential"]')
     WHERE id = $1`,
    [someone.id],
  );
  wall += 5_000;
  const hidden = live(await director.state({ encounterId: someone.id }));
  assert.equal(hidden.focus?.silenced, true);
  assert.equal(hidden.focus?.estimate, null);
});

test("a paused ER says when it resumes, a steps-only contact gets no ranges, and orders are named", async (t) => {
  const f = await workflowFixture(t);
  let wall = Date.parse("2030-01-07T12:00:30.000Z");
  const director = createDemoDirector(f.pool, { now: () => new Date(wall), seed: 5 });
  wall += 5_000;
  const fresh = live((await director.act({ type: "reset" })).state);
  assert.equal(fresh.started, false);
  // The first press starts; after a pause, choosing a speed says it resumed.
  const first = await director.act({ type: "speed", value: 10 });
  assert.equal(first.note, "Time is moving at ×10");
  assert.equal(live(first.state).started, true);
  await director.act({ type: "pause" });
  assert.equal((await director.act({ type: "play" })).note, "Resumed at ×10");
  assert.equal((await director.act({ type: "speed", value: 60 })).note, "Speed ×60");
  await director.act({ type: "pause" });
  assert.equal((await director.act({ type: "speed", value: 10 })).note, "Resumed at ×10");
  await director.act({ type: "pause" });

  // A judge who unticks "shares her wait times" gets steps only; the Guardian logs each hold-back.
  wall += 1_000;
  const added = await director.act({
    type: "contact",
    name: "",
    phone: "902 555 0177",
    estimates: false,
  });
  const scopes = await f.pool.query("SELECT scopes FROM ed_contacts WHERE id = $1", [
    added.contact!.id,
  ]);
  assert.deepEqual(scopes.rows[0].scopes, ["status", "alerts"]);
  const welcome = (await judgePhone(f.pool, added.contact!.id))!.messages[0]!.body;
  assert.doesNotMatch(welcome, /wait changes/);
  wall += 1_000;
  await director.act({ type: "surge" });
  await director.runTo(director.clock() + 90 * MIN);
  const withheld = await f.pool.query(
    `SELECT count(*)::int AS n FROM ed_audit
     WHERE action = 'estimate_withheld' AND detail->>'contactId' = $1`,
    [added.contact!.id],
  );
  assert.ok(withheld.rows[0].n > 0);
  const ranges = await f.pool.query(
    "SELECT count(*)::int AS n FROM ed_messages WHERE contact_id = $1 AND kind = 'range'",
    [added.contact!.id],
  );
  assert.equal(ranges.rows[0].n, 0);

  // The feed names each order, so one patient's lab and scan are two different lines.
  const mission = await missionView(f.pool, "demo-department", "qeii-hi", new Date(wall));
  const orders = mission.hl7.filter((line) => /^OR[MU]/.test(line.type));
  assert.ok(orders.length > 0);
  assert.ok(orders.every((line) => line.detail));
});
