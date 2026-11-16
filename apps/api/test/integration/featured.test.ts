import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { createSession } from "../../src/identity.js";
import { ingestHl7 } from "../../src/journey/ingest.js";
import { registerJourneyRoutes } from "../../src/journey/routes.js";
import { featuredVisits } from "../../src/twin/featured.js";
import { buildDemoScenario } from "../../src/twin/scenario.js";
import { workflowFixture } from "./workflow-fixture.js";

const start = new Date("2030-01-07T12:00:00.000Z");
const MIN = 60_000;

test("each featured visit takes its own path, and staff can open any visit in full", async (t) => {
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
  const scenario = buildDemoScenario(start, undefined, { featured: true });
  // Every featured visit appears in the feed, and the core story is still there.
  assert.equal(scenario.length > buildDemoScenario(start).length + featuredVisits.length * 2, true);
  for (const message of scenario) {
    f.setNow(new Date(start.getTime() + message.atMinute * MIN));
    await ingestHl7(f.pool, message.raw, { now: f.now });
  }
  f.setNow(new Date(start.getTime() + 240 * MIN));

  const app = Fastify({ logger: false });
  registerJourneyRoutes(app, f.pool, { now: f.now });
  await app.ready();
  t.after(() => app.close());
  const expires = new Date(start.getTime() + 86_400_000);
  const token = async (id: string) => (await createSession(f.pool, id, expires, f.now())).token;
  const tokens = {
    staff: await token("synthetic-staff-001"),
    otherStaff: await token("synthetic-staff-other"),
    patient: await token("synthetic-patient-001"),
  };
  const detailOf = async (visit: string, who: keyof typeof tokens = "staff") => {
    const id = (await f.pool.query("SELECT id FROM ed_encounters WHERE visit_number = $1", [visit]))
      .rows[0].id;
    const response = await app.inject({
      method: "GET",
      url: `/journey/desk/encounters/${id}`,
      headers: { authorization: `Bearer ${tokens[who]}` },
    });
    return { id, status: response.statusCode, body: response.json() as any };
  };
  const visit = (given: string) =>
    featuredVisits.find((item) => item.patient.given === given)!.patient.visit;
  const labels = (detail: any) => detail.timeline.map((event: any) => event.label);

  const priya = (await detailOf(visit("PRIYA"))).body;
  assert.equal(priya.stream, "rapid_assessment");
  assert.equal(priya.step, "discharged");
  assert.equal(labels(priya)[0], "Arrived and registered");
  assert.equal(labels(priya).includes("X-ray ordered"), true);
  assert.equal(labels(priya).includes("X-ray result back"), true);
  // Registration recorded a phone number, so the only text is the invitation to opt in.
  const invites = await f.pool.query(
    "SELECT count(*)::int AS n FROM ed_sms WHERE encounter_id = $1",
    [priya.id],
  );
  assert.equal(invites.rows[0].n, 1);

  const walter = await detailOf(visit("WALTER"));
  assert.equal(walter.body.step, "moved_to_unit");
  assert.equal(walter.body.age, 82);
  for (const label of [
    "Bloodwork ordered",
    "CT scan ordered",
    "Specialist consult requested",
    "Decision to admit",
    "Inpatient bed requested",
    "Moved to unit 6.1",
  ])
    assert.equal(labels(walter.body).includes(label), true, label);
  // Reaching a ward closes the loop on the bed estimate, which staff alone ever saw.
  const beds = await f.pool.query(
    `SELECT count(*)::int AS n, count(actual_minutes)::int AS scored
     FROM ed_stage_estimates WHERE encounter_id = $1 AND stage = 'bed'`,
    [walter.id],
  );
  assert.equal(beds.rows[0].n > 0 && beds.rows[0].scored === beds.rows[0].n, true);
  assert.equal(
    walter.body.steps.every((step: any) => step.state === "done" && step.at),
    true,
  );

  const jordan = await detailOf(visit("JORDAN"));
  assert.equal(jordan.body.step, "left");
  assert.equal(labels(jordan.body).at(-1), "Left before being seen");
  // Leaving early is scored as a lower bound, never as the time to be seen.
  const censored = await f.pool.query(
    "SELECT bool_and(censored) AS all FROM ed_stage_estimates WHERE encounter_id = $1 AND stage = 'provider'",
    [jordan.id],
  );
  assert.equal(censored.rows[0].all, true);
  assert.equal(jordan.body.steps.find((step: any) => step.label === "Being seen").at, null);

  const fatima = await detailOf(visit("FATIMA"));
  assert.deepEqual(fatima.body.flags, ["confidential"]);
  assert.equal(labels(fatima.body).includes("Confidential set"), true);
  // Once the record says confidential, nothing more goes out, not even the discharge.
  const afterFlag = await f.pool.query(
    `SELECT count(*)::int AS n FROM ed_messages WHERE encounter_id = $1 AND direction = 'out'
       AND created_at >= $2`,
    [fatima.id, new Date(start.getTime() + 80 * MIN)],
  );
  assert.equal(afterFlag.rows[0].n, 0);

  const robert = await detailOf(visit("ROBERT"));
  const robertLabels = labels(robert.body);
  for (const label of [
    "CT scan ordered",
    "CT scan cancelled",
    "Ultrasound ordered",
    "Ultrasound result back",
  ])
    assert.equal(robertLabels.includes(label), true, label);
  assert.equal(
    robertLabels.indexOf("CT scan cancelled") < robertLabels.indexOf("Ultrasound result back"),
    true,
  );

  const grace = (await detailOf(visit("GRACE"))).body;
  assert.equal(grace.age, 11);
  assert.equal(grace.step, "discharged");

  const ahmed = await detailOf(visit("AHMED"));
  assert.equal(ahmed.body.step, "cancelled");
  assert.equal(labels(ahmed.body).at(-1), "Registration cancelled");
  const cancelledMessages = await f.pool.query(
    "SELECT count(*)::int AS n FROM ed_messages WHERE encounter_id = $1 AND created_at > $2",
    [ahmed.id, new Date(start.getTime() + 85 * MIN)],
  );
  assert.equal(cancelledMessages.rows[0].n, 0);

  const sam = (await detailOf(visit("SAM"))).body;
  assert.deepEqual(sam.flags, ["security"]);
  assert.equal(sam.step, "discharged");

  // Maya's own story still ends the way it always has.
  const maya = (await detailOf("FIN5500001")).body;
  assert.equal(maya.step, "discharged");
  assert.equal(maya.published.length >= 2, true);
  assert.equal(maya.runs.length > 0, true);

  // The detail is staff-only and stays inside the department.
  assert.equal((await detailOf(visit("PRIYA"), "otherStaff")).status, 404);
  assert.equal((await detailOf(visit("PRIYA"), "patient")).status, 404);
});
