import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonicalJson } from "../../src/journey/records.js";
import test, { type TestContext } from "node:test";
import Fastify, { type InjectOptions } from "fastify";
import { createSession } from "../../src/identity.js";
import { ingestHl7 } from "../../src/journey/ingest.js";
import { HANDOFF_REPLY, STALE_REPLY } from "../../src/journey/messages.js";
import { registerJourneyRoutes } from "../../src/journey/routes.js";
import { sendMllp, startMllpListener } from "../../src/opor/mllp.js";
import { buildDemoScenario } from "../../src/twin/scenario.js";
import { workflowFixture } from "./workflow-fixture.js";

const start = new Date("2030-01-07T12:00:00.000Z");
const MIN = 60_000;

async function fixture(t: TestContext) {
  const f = await workflowFixture(t);
  await f.pool.query("UPDATE patients SET display_name='Maya Chen' WHERE id=$1", [
    f.patient.patientId,
  ]);
  await f.pool.query(
    `INSERT INTO emergency_patient_records
    (patient_id,date_of_birth,contact_name,contact_relationship,contact_number,facility,department,area,visitor_instructions)
    VALUES ($1,'1990-04-12','Jamie Singh','Friend','+15005550006','Fictional Halifax hospital','Emergency department','Assessment area B','Check in at reception.')`,
    [f.patient.patientId],
  );
  const scenario = buildDemoScenario(start);
  // Wall clock follows the feed so the feed is never stale unless a test makes it so.
  const play = async (untilMinute: number, fromMinute = -Infinity) => {
    for (const message of scenario) {
      if (message.atMinute <= fromMinute || message.atMinute > untilMinute) continue;
      f.setNow(new Date(start.getTime() + message.atMinute * MIN));
      await ingestHl7(f.pool, message.raw, { now: f.now });
    }
    f.setNow(new Date(start.getTime() + untilMinute * MIN));
  };
  const app = Fastify({ logger: false });
  registerJourneyRoutes(app, f.pool, { now: f.now });
  await app.ready();
  t.after(() => app.close());
  const expires = new Date(start.getTime() + 86_400_000);
  const tokens = {
    patient: (await createSession(f.pool, "synthetic-patient-001", expires, f.now())).token,
    staff: (await createSession(f.pool, "synthetic-staff-001", expires, f.now())).token,
    otherStaff: (await createSession(f.pool, "synthetic-staff-other", expires, f.now())).token,
  };
  const call = async (who: keyof typeof tokens, options: InjectOptions) => {
    const response = await app.inject({
      ...options,
      headers: { authorization: `Bearer ${tokens[who]}` },
    });
    return { status: response.statusCode, body: response.json() as any };
  };
  const visit = () => call("patient", { method: "GET", url: "/journey/visit" });
  const thread = async () =>
    (
      await f.pool.query(
        `SELECT m.kind, m.body, m.audience, m.direction FROM ed_messages m
         JOIN ed_encounters c ON c.id = m.encounter_id WHERE c.patient_id = $1
         ORDER BY m.seq`,
        [f.patient.patientId],
      )
    ).rows as { kind: string; body: string; audience: string; direction: string }[];
  return { ...f, scenario, play, call, visit, thread };
}

test("the feed creates the visit, links the portal patient and tells them their step and range", async (t) => {
  const f = await fixture(t);
  assert.deepEqual((await f.visit()).body, { mode: "none" });
  await f.play(10);
  const view = (await f.visit()).body;
  assert.equal(view.mode, "live");
  assert.equal(view.firstName, "Maya");
  assert.equal(view.friendlyStep, 2);
  assert.equal(view.sentence, "You are waiting to be seen by the care team.");
  assert.ok(view.range, "a waiting patient at triage level 4 gets a range");
  assert.equal(view.range.highMinutes % 15, 0);
  assert.match(view.range.sentence, /^You'll likely be seen within about /);
  const kinds = (await f.thread()).map((message) => message.kind);
  assert.deepEqual(kinds, ["step", "step", "range"]);
});

test("a surge of urgent arrivals lengthens the range and says why", async (t) => {
  const f = await fixture(t);
  await f.play(10);
  const before = (await f.visit()).body.range.highMinutes;
  await f.play(40);
  const view = (await f.visit()).body;
  assert.equal(view.range.highMinutes > before, true);
  assert.equal(view.range.reason, "Several very sick patients arrived, so the wait is longer.");
  assert.equal(view.badges.testsInProgress, true);
  const changed = (await f.thread()).filter((message) => message.kind === "range");
  assert.match(changed.at(-1)!.body, /^Your estimate has changed\. /);
});

test("the whole visit plays through to discharge and scores its own estimates", async (t) => {
  const f = await fixture(t);
  await f.play(240);
  const view = (await f.visit()).body;
  assert.equal(view.step, "discharged");
  assert.equal(view.ended, true);
  assert.equal(view.range, null);
  const scored = await f.pool.query(
    `SELECT e.low_minutes, e.high_minutes, e.actual_minutes FROM ed_estimates e
     JOIN ed_encounters c ON c.id = e.encounter_id
     WHERE c.patient_id = $1 AND e.published AND e.abstain IS NULL ORDER BY e.computed_at`,
    [f.patient.patientId],
  );
  assert.equal(scored.rowCount! >= 2, true);
  assert.equal(
    scored.rows.every((row) => row.actual_minutes !== null),
    true,
  );
  const desk = (await f.call("staff", { method: "GET", url: "/journey/desk" })).body;
  assert.equal(desk.accuracy.total >= scored.rowCount!, true);
  // Replaying the same messages changes nothing.
  const events = (await f.pool.query("SELECT count(*)::int AS n FROM ed_events")).rows[0].n;
  assert.equal(await ingestHl7(f.pool, f.scenario[0]!.raw, { now: f.now }), "duplicate");
  assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM ed_events")).rows[0].n, events);
});

test("every step gets a model estimate: patients see the later steps, staff see all, each is scored", async (t) => {
  const f = await fixture(t);
  const desk = async () => (await f.call("staff", { method: "GET", url: "/journey/desk" })).body;
  const stagesOf = (view: any, name: string) =>
    view.patients.find((patient: any) => patient.name === name).stages as any[];

  // Waiting, with bloodwork started in the waiting room.
  await f.play(25);
  let view = (await f.visit()).body;
  assert.deepEqual(
    view.outlook.map((item: any) => [item.stage, item.label]),
    [
      ["results", "Test results"],
      ["decision", "Whole visit"],
    ],
  );
  for (const item of view.outlook) {
    assert.equal(item.lowMinutes < item.highMinutes, true);
    assert.equal(item.highMinutes % 5, 0);
    assert.match(item.headline, /^Within about /);
  }
  assert.match(
    view.outlook[0].sentence,
    /^Results for the tests under way are usually back within/,
  );
  let staff = await desk();
  assert.equal(staff.model.version, "stage-gbq-1");
  assert.deepEqual(
    stagesOf(staff, "Maya Chen").map((item: any) => item.stage),
    ["provider", "results", "decision"],
  );

  // Being seen, with imaging under way; an admitted patient is waiting for a bed.
  await f.play(130);
  view = (await f.visit()).body;
  assert.equal(view.range, null);
  assert.deepEqual(
    view.outlook.map((item: any) => [item.stage, item.label]),
    [
      ["results", "Test results"],
      ["decision", "Next steps decided"],
    ],
  );
  staff = await desk();
  const boarding = staff.patients.filter((patient: any) => patient.step === "admitted_waiting_bed");
  assert.equal(boarding.length > 0, true);
  // The wait for a bed is estimated for staff and never offered to the patient's own page.
  for (const patient of boarding)
    assert.deepEqual(
      patient.stages.map((item: any) => item.stage),
      ["bed"],
    );

  // After discharge every estimate made for the visit has been scored against what happened.
  await f.play(240);
  assert.deepEqual((await f.visit()).body.outlook, []);
  const logged = await f.pool.query(
    `SELECT s.stage, count(*)::int AS n, count(s.actual_minutes)::int AS scored,
            bool_or(s.censored) AS censored, min(s.model_version) AS version
     FROM ed_stage_estimates s JOIN ed_encounters c ON c.id = s.encounter_id
     WHERE c.patient_id = $1 GROUP BY s.stage ORDER BY s.stage`,
    [f.patient.patientId],
  );
  assert.deepEqual(
    logged.rows.map((row) => row.stage),
    ["decision", "provider", "results", "triage"],
  );
  for (const row of logged.rows) {
    assert.equal(row.scored, row.n, `${row.stage} estimates are all scored`);
    assert.equal(row.censored, false);
    assert.equal(row.version, "stage-gbq-1");
  }
  // A lab result that came back at minute 48 is scored on that order, not on the later scan.
  const lab = await f.pool.query(
    `SELECT s.open_orders, s.actual_minutes,
            EXTRACT(EPOCH FROM (s.computed_at - $2::timestamptz)) / 60 AS minute
     FROM ed_stage_estimates s JOIN ed_encounters c ON c.id = s.encounter_id
     WHERE c.patient_id = $1 AND s.stage = 'results' ORDER BY s.computed_at LIMIT 1`,
    [f.patient.patientId, start],
  );
  assert.deepEqual(lab.rows[0].open_orders, ["ORD-MAYA-1"]);
  assert.equal(Math.round(Number(lab.rows[0].minute) + lab.rows[0].actual_minutes), 48);
  staff = await desk();
  const stages = staff.stageAccuracy.map((row: any) => row.stage);
  for (const stage of ["decision", "provider", "results", "triage"])
    assert.equal(stages.includes(stage), true, `${stage} appears in the Desk's accuracy`);
  // Nobody in this scenario reaches a ward, so the bed estimates are logged but still open.
  assert.equal(stages.includes("bed"), false);
  const beds = await f.pool.query(
    "SELECT count(*)::int AS n, count(actual_minutes)::int AS scored FROM ed_stage_estimates WHERE stage = 'bed'",
  );
  assert.equal(beds.rows[0].n > 0 && beds.rows[0].scored === 0, true);
  for (const row of staff.stageAccuracy) assert.equal(row.inside + row.over <= row.total, true);
});

test("a worse or leaving message always reaches the Desk, and questions are relayed", async (t) => {
  const f = await fixture(t);
  await f.play(40);
  const say = (text: string) =>
    f.call("patient", { method: "POST", url: "/journey/visit/messages", payload: { text } });
  assert.equal((await say("I feel dizzy and my chest pain is worse")).body.kind, "worse");
  assert.equal((await say("I'm leaving, this is too long")).body.kind, "leaving");
  assert.equal((await say("Can I take my evening pills?")).body.kind, "question");
  const status = (await say("STATUS")).body;
  assert.equal(status.kind, "status");
  assert.match(status.reply, /waiting to be seen.*likely be seen within/);
  const checkIn = await f.call("patient", {
    method: "POST",
    url: "/journey/visit/check-in",
    payload: { answer: "worse" },
  });
  assert.match(checkIn.body.reply, /triage nurse/);

  const desk = (await f.call("staff", { method: "GET", url: "/journey/desk" })).body;
  const mine = desk.tasks.filter((task: any) => task.patientName === "Maya Chen");
  // The check-in adds to the open recheck instead of queueing a second one.
  assert.deepEqual(
    mine.map((task: any) => [task.kind, task.priority]),
    [
      ["recheck", 1],
      ["leaving", 2],
      ["question", 3],
    ],
  );
  assert.match(mine[0].summary, /Triage level 4\. Waited 0 h 3\d min\./);
  const question = mine.find((task: any) => task.kind === "question");
  await f.call("staff", {
    method: "POST",
    url: `/journey/desk/tasks/${question.id}/close`,
    payload: { outcome: "done" },
  });
  assert.equal((await f.thread()).at(-1)!.body, "The care team has picked up your question.");
  assert.equal(
    (
      await f.call("otherStaff", {
        method: "POST",
        url: `/journey/desk/tasks/${mine[0].id}/close`,
        payload: { outcome: "done" },
      })
    ).status,
    404,
  );
});

test("a sensitivity flag silences the visit with the same handoff wording", async (t) => {
  const f = await fixture(t);
  await f.play(40);
  const desk = (await f.call("staff", { method: "GET", url: "/journey/desk" })).body;
  const maya = desk.patients.find((patient: any) => patient.name === "Maya Chen");
  const flag = (active: boolean) =>
    f.call("staff", {
      method: "POST",
      url: `/journey/desk/encounters/${maya.id}/flags`,
      payload: { flag: "confidential", active },
    });
  assert.deepEqual((await flag(true)).body, { flags: ["confidential"] });
  const sent = (await f.thread()).length;
  const view = (await f.visit()).body;
  assert.equal(view.mode, "handoff");
  assert.equal(view.message, HANDOFF_REPLY);
  // Later feed events for a flagged visit send nothing.
  await f.play(110, 40);
  assert.equal((await f.thread()).length, sent);
  // The safety floor still works while silenced.
  const worse = await f.call("patient", {
    method: "POST",
    url: "/journey/visit/messages",
    payload: { text: "I feel much worse" },
  });
  assert.equal(worse.body.kind, "worse");
  assert.deepEqual((await flag(false)).body, { flags: [] });
  assert.equal((await f.visit()).body.mode, "live");
});

test("contacts hear only what their consent covers, and withdrawal is immediate", async (t) => {
  const f = await fixture(t);
  await f.play(5);
  const add = (name: string, scopes: string[]) =>
    f.call("patient", {
      method: "POST",
      url: "/journey/visit/contacts",
      payload: { name, relationship: "Daughter", phone: "+15005550007", scopes },
    });
  const full = (await add("Lin Chen", ["status", "alerts", "estimates"])).body.id;
  const statusOnly = (await add("Sam Chen", ["status", "alerts"])).body.id;
  assert.equal((await add("Bad", ["everything"])).status, 400);
  await f.play(10, 5);
  const to = async (contactId: string) =>
    (
      await f.pool.query("SELECT kind, body FROM ed_messages WHERE contact_id = $1 ORDER BY seq", [
        contactId,
      ])
    ).rows;
  assert.deepEqual(
    (await to(full)).map((message) => message.kind),
    ["step", "range"],
  );
  assert.equal((await to(full))[0]!.body, "Maya is waiting to be seen by the care team.");
  assert.match((await to(full))[1]!.body, /^They'll likely be seen within about /);
  assert.deepEqual(
    (await to(statusOnly)).map((message) => message.kind),
    ["step"],
  );
  const withdrawn = await f.call("patient", {
    method: "POST",
    url: `/journey/visit/contacts/${full}/withdraw`,
  });
  assert.deepEqual(withdrawn.body, { withdrawn: true });
  const count = (await to(full)).length;
  await f.play(110, 10);
  assert.equal((await to(full)).length, count);
  assert.equal((await f.visit()).body.contacts.length, 1);
});

test("a stale feed stops live updates for the patient", async (t) => {
  const f = await fixture(t);
  await f.play(10);
  f.setNow(new Date(start.getTime() + 26 * MIN));
  const view = (await f.visit()).body;
  assert.equal(view.mode, "handoff");
  assert.equal(view.message, STALE_REPLY);
});

test("sessions are scoped: staff cannot read a visit page and patients cannot open the Desk", async (t) => {
  const f = await fixture(t);
  await f.play(10);
  assert.equal((await f.call("staff", { method: "GET", url: "/journey/visit" })).status, 404);
  assert.equal((await f.call("patient", { method: "GET", url: "/journey/desk" })).status, 404);
  const anonymous = Fastify({ logger: false });
  registerJourneyRoutes(anonymous, f.pool, { now: f.now });
  assert.equal((await anonymous.inject({ method: "GET", url: "/journey/visit" })).statusCode, 401);
  await anonymous.close();
});

test("the event log and ledger are append-only, and the ledger's hash chain verifies", async (t) => {
  const f = await fixture(t);
  await f.play(40);
  await assert.rejects(f.pool.query("UPDATE ed_events SET kind = 'discharged'"), /append_only/);
  await assert.rejects(f.pool.query("DELETE FROM ed_audit"), /append_only/);
  const rows = (await f.pool.query("SELECT * FROM ed_audit ORDER BY seq")).rows;
  assert.equal(rows.length > 20, true);
  let previous = "genesis";
  for (const row of rows) {
    assert.equal(row.prev_hash, previous);
    const expected = createHash("sha256")
      .update(
        canonicalJson([
          row.prev_hash,
          row.at.toISOString(),
          row.actor,
          row.action,
          row.encounter_id,
          row.detail,
        ]),
      )
      .digest("hex");
    assert.equal(row.hash, expected);
    previous = row.hash;
  }
});

test("the feed arrives over MLLP and each message is acknowledged", async (t) => {
  const f = await fixture(t);
  const server = await startMllpListener({
    host: "127.0.0.1",
    port: 0,
    onMessage: (raw) => ingestHl7(f.pool, raw, { now: f.now }),
  });
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const target = { host: "127.0.0.1", port: address.port };
  const first = f.scenario.slice(0, 6).map((message) => message.raw);
  assert.deepEqual(await sendMllp(target, first), ["AA", "AA", "AA", "AA", "AA", "AA"]);
  assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM opor_messages")).rows[0].n, 6);
  // A message we cannot read is refused, and nothing is stored for it.
  await assert.rejects(sendMllp(target, ["MSH|^~\\&|X|Y|||20300107||ADT^A04|BAD1|P|2.5.1"]), /AE/);
});
