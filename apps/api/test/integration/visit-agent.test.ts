import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import Fastify, { type InjectOptions } from "fastify";
import {
  PlannerError,
  type PlanRequest,
  type Planner,
  type ToolCall,
} from "../../src/agents/llm.js";
import { createVisitAgent } from "../../src/agents/visit-agent.js";
import { createSession } from "../../src/identity.js";
import { ingestHl7, tickFeed } from "../../src/journey/ingest.js";
import {
  CHECK_IN_ASK,
  HANDOFF_REPLY,
  PICKED_UP,
  QUESTION_REPLY,
  SMS_INVITE,
  SMS_WELCOME,
  WORSE_REPLY,
} from "../../src/journey/messages.js";
import { registerJourneyRoutes } from "../../src/journey/routes.js";
import { dispatchJourneySms, inboundSms } from "../../src/journey/sms.js";
import { buildDemoScenario } from "../../src/twin/scenario.js";
import { VoiceAgent } from "../../src/voice-agent.js";
import { workflowFixture } from "./workflow-fixture.js";

const start = new Date("2030-01-07T12:00:00.000Z");
const MIN = 60_000;
const mayaPhone = "+15005550101";
const registeredPhone = "+15005550006";

type Plan = (request: PlanRequest & { context: any }) => ToolCall[] | Promise<ToolCall[]>;

/** A scripted stand-in for the language model: each test says what the "model" would call. */
function scripted(plan: Plan): Planner & { seen: any[] } {
  const seen: any[] = [];
  return {
    model: "test-model",
    seen,
    async plan(request) {
      seen.push(request.context);
      return plan(request as PlanRequest & { context: any });
    },
  };
}
const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({
  name,
  args: { why: "test", ...args },
});

async function fixture(t: TestContext, plan?: Plan, phone?: string) {
  const f = await workflowFixture(t);
  await f.pool.query("UPDATE patients SET display_name='Maya Chen' WHERE id=$1", [
    f.patient.patientId,
  ]);
  await f.pool.query(
    `INSERT INTO emergency_patient_records
    (patient_id,date_of_birth,contact_name,contact_relationship,contact_number,facility,department,area,visitor_instructions)
    VALUES ($1,'1990-04-12','Jamie Singh','Friend',$2,'Fictional Halifax hospital','Emergency department','Assessment area B','Check in at reception.')`,
    [f.patient.patientId, registeredPhone],
  );
  const planner = plan ? scripted(plan) : null;
  const agent = createVisitAgent(f.pool, { planner, now: f.now });
  const scenario = buildDemoScenario(start, phone);
  const play = async (untilMinute: number, fromMinute = -Infinity) => {
    for (const message of scenario) {
      if (message.atMinute <= fromMinute || message.atMinute > untilMinute) continue;
      f.setNow(new Date(start.getTime() + message.atMinute * MIN));
      await ingestHl7(f.pool, message.raw, { now: f.now, defer: agent.defer });
      await agent.drain();
    }
    f.setNow(new Date(start.getTime() + untilMinute * MIN));
  };
  const app = Fastify({ logger: false });
  registerJourneyRoutes(app, f.pool, { now: f.now, agent });
  await app.ready();
  t.after(() => app.close());
  const expires = new Date(start.getTime() + 86_400_000);
  const tokens = {
    patient: (await createSession(f.pool, "synthetic-patient-001", expires, f.now())).token,
    staff: (await createSession(f.pool, "synthetic-staff-001", expires, f.now())).token,
  };
  const as = async (who: keyof typeof tokens | null, options: InjectOptions) => {
    const response = await app.inject({
      ...options,
      headers: who ? { authorization: `Bearer ${tokens[who]}` } : {},
    });
    return { status: response.statusCode, body: response.json() as any };
  };
  const say = (text: string) =>
    as("patient", { method: "POST", url: "/journey/visit/messages", payload: { text } });
  const maya = async () =>
    (
      await f.pool.query("SELECT id FROM ed_encounters WHERE patient_id = $1", [
        f.patient.patientId,
      ])
    ).rows[0].id as string;
  const thread = async (contactId?: string) =>
    (
      await f.pool.query(
        `SELECT m.kind, m.body, m.direction, m.channel FROM ed_messages m
         JOIN ed_encounters c ON c.id = m.encounter_id
         WHERE c.patient_id = $1 AND m.contact_id IS NOT DISTINCT FROM $2 ORDER BY m.seq`,
        [f.patient.patientId, contactId ?? null],
      )
    ).rows as { kind: string; body: string; direction: string; channel: string }[];
  const runs = async () =>
    (
      await f.pool.query(
        `SELECT r.wake, r.planner, r.model, r.fallback_reason AS fallback, r.plan
         FROM ed_agent_runs r JOIN ed_encounters c ON c.id = r.encounter_id
         WHERE c.patient_id = $1 ORDER BY r.seq`,
        [f.patient.patientId],
      )
    ).rows as { wake: string; planner: string; model: string; fallback: string; plan: any[] }[];
  const addContact = async (scopes = ["status", "alerts", "estimates"]) =>
    (
      await as("patient", {
        method: "POST",
        url: "/journey/visit/contacts",
        payload: { name: "Lin Chen", relationship: "Daughter", phone: "+15005550007", scopes },
      })
    ).body as { id: string; link: string };
  const tasks = async () =>
    (await as("staff", { method: "GET", url: "/journey/desk" })).body.tasks.filter(
      (task: any) => task.patientName === "Maya Chen",
    ) as any[];
  return { ...f, planner, agent, play, as, say, maya, thread, runs, addContact, tasks };
}

test("the model chooses which updates to send; floors go out whatever it decides", async (t) => {
  // This model never thinks anything is worth sending.
  const f = await fixture(t, () => [call("do_nothing")]);
  await f.play(5);
  const contact = await f.addContact();
  await f.play(10, 5);
  // The patient still hears their step and first range: those are floors in code.
  assert.deepEqual(
    (await f.thread()).map((message) => message.kind),
    ["step", "step", "range"],
  );
  // The contact hears nothing, because the model held every optional update back.
  assert.deepEqual(await f.thread(contact.id), []);
  const runs = await f.runs();
  // Floors were settled at once by code; only the optional contact updates went to the model.
  const planned = runs.filter((run) => run.planner === "model");
  assert.equal(planned.length, 2);
  assert.equal(
    planned.every((run) => run.model === "test-model"),
    true,
  );
  assert.equal(runs.filter((run) => run.planner === "rules").length >= 3, true);
  const held = planned.at(-1)!.plan.find((step: any) => step.tool === "do_nothing");
  assert.equal(held.verdict, "done");
  // The model saw the contact by role and scope, never the patient's name, birth date or triage level.
  const seen = JSON.stringify(f.planner!.seen);
  assert.match(seen, /"relationship":"Daughter"/);
  assert.doesNotMatch(seen, /Lin Chen|\+1500|1990-04-12|ctas/i);
  assert.equal(seen.includes('"text":"Maya is waiting to be seen by the care team."'), true);
  // A visit with nobody optional to tell never calls the model for a step change.
  assert.equal(
    f.planner!.seen.every((context: any) => context.actions.length > 0),
    true,
  );
});

test("a model that picks the contact's update sends exactly that sentence", async (t) => {
  const f = await fixture(t, ({ context }) =>
    context.actions
      .filter((action: any) => !action.floor && action.tool === "notify")
      .map((action: any) => call("notify", { action_id: action.id })),
  );
  await f.play(5);
  const contact = await f.addContact();
  await f.play(10, 5);
  const heard = await f.thread(contact.id);
  assert.deepEqual(
    heard.map((message) => message.kind),
    ["step", "range"],
  );
  assert.equal(heard[0]!.body, "Maya is waiting to be seen by the care team.");
});

test("a failed, empty or rejected plan falls back to the rules path", async (t) => {
  let mode = "throw";
  const f = await fixture(t, () => {
    if (mode === "throw") throw new PlannerError("http_503");
    if (mode === "empty") return [];
    // An action that was never offered, a tool that is not on the list, and an invented one.
    return [
      call("notify", { action_id: "contact:someone-else" }),
      call("open_staff_task", { kind: "question", priority: 3, summary: "hello" }),
      call("delete_everything"),
    ];
  });
  await f.play(5);
  const contact = await f.addContact();
  await f.play(10, 5);
  mode = "rejected";
  await f.play(40, 10);
  mode = "empty";
  await f.play(56, 40);
  // Every allowed update still went out: the step, the first range, and the surge's change.
  const heard = await f.thread(contact.id);
  assert.deepEqual(
    heard.map((message) => message.kind),
    ["step", "range", "range"],
  );
  assert.match(heard[2]!.body, /Several very sick patients arrived/);
  assert.equal((await f.thread()).at(-1)!.kind, "check_in_ask");
  const runs = await f.runs();
  assert.equal(
    runs.every((run) => run.planner === "rules"),
    true,
  );
  const reasons = new Set(runs.map((run) => run.fallback));
  for (const reason of ["http_503", "plan_rejected", "empty_plan"])
    assert.equal(reasons.has(reason), true, `${reason} is logged`);
  const denied = runs
    .find((run) => run.fallback === "plan_rejected")!
    .plan.filter((step: any) => step.verdict === "denied");
  assert.deepEqual(
    denied.map((step: any) => step.why),
    ["unknown_action", "tool_not_offered", "tool_not_offered"],
  );
});

test("the Guardian re-checks a plan when it is applied: withdrawn consent is not notified", async (t) => {
  let contactId = "";
  const f = await fixture(t, async ({ context }) => {
    // Consent is withdrawn while the "model" is still thinking.
    if (contactId && context.wake === "step_change")
      await f.as("patient", {
        method: "POST",
        url: `/journey/visit/contacts/${contactId}/withdraw`,
      });
    return context.actions.map((action: any) => call("notify", { action_id: action.id }));
  });
  await f.play(5);
  contactId = (await f.addContact()).id;
  await f.play(10, 5);
  assert.deepEqual(await f.thread(contactId), []);
  const denied = (await f.runs())
    .flatMap((run) => run.plan)
    .filter((step: any) => step.verdict === "denied");
  assert.equal(
    denied.some((step: any) => step.why === "consent_withdrawn"),
    true,
  );
});

test("questions are answered from retrieved knowledge, relayed, or escalated; floors never reach the model", async (t) => {
  const f = await fixture(t, ({ context }) => {
    const text: string = context.message.text;
    if (/charge/.test(text))
      return [call("answer_from_kb", { article_id: context.knowledge[0].id })];
    if (/blanket/.test(text))
      return [
        call("open_staff_task", { kind: "comfort", priority: 3, summary: "Asked for a blanket" }),
        call("answer_from_kb", { article_id: "parking" }),
      ];
    if (/tingly/.test(text))
      // The model spots deterioration the keyword list misses, and under-rates it.
      return [
        call("open_staff_task", { kind: "recheck", priority: 3, summary: "Arm tingly and heavy" }),
      ];
    if (/long/.test(text)) return [call("notify", { action_id: "status" })];
    if (/pills/.test(text))
      return [
        call("open_staff_task", {
          kind: "question",
          priority: 3,
          summary: "Call me at 9025550123 or see http://x.example",
        }),
      ];
    return [call("answer_from_kb", { article_id: "not_an_article" })];
  });
  await f.play(40);

  // Retrieval put the right article first, and the reply is the article word for word.
  const charge = (await f.say("Where can I charge my phone? Battery is nearly dead")).body;
  assert.equal(charge.kind, "kb");
  assert.match(charge.reply, /^There are free charging lockers/);
  const context = f.planner!.seen.at(-1);
  assert.equal(context.knowledge[0].id, "phone_charging");
  assert.equal(context.knowledge.length <= 3, true);

  // Two needs in one message: a task for staff and an answer.
  const blanket = (await f.say("Could I get a blanket, and where do I pay for parking?")).body;
  assert.equal(blanket.kind, "comfort");

  // Priority has a floor the model cannot lower, and the reply is the safety wording.
  const tingly = (await f.say("my arm feels tingly and heavy")).body;
  assert.equal(tingly.kind, "worse");
  assert.equal(tingly.reply, WORSE_REPLY);

  const status = (await f.say("how much longer do you think?")).body;
  assert.equal(status.kind, "status");
  assert.match(status.reply, /waiting to be seen.*likely be seen within/);

  // A summary that carries contact details is refused; the rules path relays the question.
  const pills = (await f.say("Can I take my evening pills?")).body;
  assert.equal(pills.kind, "question");
  assert.equal(pills.reply, QUESTION_REPLY);

  // An article that does not exist is refused the same way.
  assert.equal((await f.say("is there a vending machine")).body.kind, "question");

  // The safety floor runs in code before any model is asked.
  const asked = f.planner!.seen.length;
  assert.equal((await f.say("my chest pain is getting worse")).body.kind, "worse");
  assert.equal(f.planner!.seen.length, asked);

  const mine = await f.tasks();
  assert.deepEqual(
    mine.map((task) => [task.kind, task.priority]),
    [
      ["recheck", 1],
      ["comfort", 3],
      ["question", 3],
    ],
  );
  assert.match(
    mine[0].summary,
    /^Patient may be getting worse: Arm tingly and heavy Triage level 4\./,
  );
  assert.equal(mine[1].summary, "Comfort request from the patient: Asked for a blanket");
  assert.equal(mine[2].summary, 'Question from the patient: "Can I take my evening pills?".');
});

test("the model never sees a message from a silenced visit", async (t) => {
  const f = await fixture(t, () => [call("handoff")]);
  await f.play(40);
  const id = await f.maya();
  await f.as("staff", {
    method: "POST",
    url: `/journey/desk/encounters/${id}/flags`,
    payload: { flag: "confidential", active: true },
  });
  const modelRuns = async () => (await f.runs()).filter((run) => run.planner === "model").length;
  const before = await modelRuns();
  const asked = f.planner!.seen.length;
  const reply = (await f.say("where is the cafeteria")).body;
  // The rules path relays it; the text never left this process.
  assert.equal(reply.kind, "question");
  assert.equal(f.planner!.seen.length, asked);
  assert.equal(JSON.stringify(f.planner!.seen).includes("cafeteria"), false);
  // Later feed events for the silenced visit wake nothing for the model to plan.
  await f.play(120, 40);
  assert.equal(await modelRuns(), before);
});

test("check-ins are asked on a timer tied to triage level, and an answer restarts the clock", async (t) => {
  const f = await fixture(t);
  await f.play(50);
  const asks = async () => (await f.thread()).filter((message) => message.kind === "check_in_ask");
  // Triage level 4 waits 45 minutes from triage (minute 8) before the first question.
  assert.equal((await asks()).length, 0);
  await f.play(56, 50);
  assert.deepEqual(
    (await asks()).map((message) => message.body),
    [CHECK_IN_ASK],
  );
  await f.as("patient", {
    method: "POST",
    url: "/journey/visit/check-in",
    payload: { answer: "same" },
  });
  await f.play(98, 56);
  assert.equal((await asks()).length, 1);
  // With no feed message at all, the background timer still asks when the next one is due.
  f.setNow(new Date(start.getTime() + 103 * MIN));
  assert.equal(await tickFeed(f.pool, { now: f.now }), true);
  assert.equal((await asks()).length, 2);
  // A feed that has gone stale is left alone.
  f.setNow(new Date(start.getTime() + 200 * MIN));
  assert.equal(await tickFeed(f.pool, { now: f.now }), false);
});

test("the family page shows what consent covers, relays questions, and closes on withdrawal", async (t) => {
  const f = await fixture(t);
  await f.play(5);
  const contact = await f.addContact(["status", "alerts"]);
  assert.match(contact.link, /^\/family\/[A-Za-z0-9_-]{32}$/);
  const token = contact.link.split("/")[2]!;
  // Only a hash of the link is stored.
  const stored = await f.pool.query("SELECT link_hash FROM ed_contacts WHERE id = $1", [
    contact.id,
  ]);
  assert.equal(stored.rows[0].link_hash.length, 64);
  assert.equal(stored.rows[0].link_hash.includes(token), false);
  await f.play(40, 5);

  const page = () => f.as(null, { method: "GET", url: `/journey/family/${token}` });
  const view = (await page()).body;
  assert.equal(view.mode, "live");
  assert.equal(view.sentence, "Maya is waiting to be seen, and some tests have been started.");
  // Estimates were not shared with this contact.
  assert.equal(view.range, null);
  assert.equal(JSON.stringify(view).includes("Triage"), false);

  const ask = (text: string) =>
    f.as(null, { method: "POST", url: `/journey/family/${token}/messages`, payload: { text } });
  assert.equal((await ask("Can she take her evening pills?")).body.reply, QUESTION_REPLY);
  assert.equal((await ask("She says she can't breathe properly")).body.kind, "worse");
  const mine = await f.tasks();
  assert.deepEqual(
    mine.map((task) => [task.kind, task.priority]),
    [
      ["recheck", 1],
      ["question", 3],
    ],
  );
  assert.match(mine[0].summary, /^Daughter reports the patient may be getting worse/);
  assert.equal(mine[1].summary, 'Question from Daughter: "Can she take her evening pills?".');
  // The "picked up" note goes back to the person who asked, not to the patient.
  await f.as("staff", {
    method: "POST",
    url: `/journey/desk/tasks/${mine[1].id}/close`,
    payload: { outcome: "done" },
  });
  assert.equal((await f.thread(contact.id)).at(-1)!.body, PICKED_UP);
  assert.equal(
    (await f.thread()).some((message) => message.body === PICKED_UP),
    false,
  );

  // A wrong link, a withdrawn contact and a silenced visit all look the same.
  const closed = { mode: "handoff", message: HANDOFF_REPLY };
  assert.deepEqual(
    (await f.as(null, { method: "GET", url: `/journey/family/${"x".repeat(32)}` })).body,
    closed,
  );
  await f.as("patient", { method: "POST", url: `/journey/visit/contacts/${contact.id}/withdraw` });
  assert.deepEqual((await page()).body, closed);
  assert.deepEqual((await ask("hello?")).body, { kind: "handoff", reply: HANDOFF_REPLY });
});

test("texts need a YES first, are queued for the sender, and inbound texts are answered", async (t) => {
  const f = await fixture(t, undefined, mayaPhone);
  await f.play(10);
  const texts = async () =>
    (await f.pool.query("SELECT to_number, body, status FROM ed_sms ORDER BY seq")).rows as {
      to_number: string;
      body: string;
      status: string;
    }[];
  // Before consent the only text is the invitation.
  assert.deepEqual(
    (await texts()).map((row) => [row.to_number, row.body]),
    [[mayaPhone, SMS_INVITE]],
  );
  let sid = 0;
  const text = (from: string, body: string, id = `SM${String(++sid).padStart(32, "0")}`) =>
    inboundSms(f.pool, { from, body, sid: id }, f.now());
  assert.equal(await text(mayaPhone, " yes "), SMS_WELCOME);
  // A stranger's text gets no reply at all, and a redelivered webhook is ignored.
  assert.equal(await text("+15005550199", "STATUS"), null);
  assert.equal((await text(mayaPhone, "STATUS", "SM".padEnd(34, "9"))) !== null, true);
  assert.equal(await text(mayaPhone, "STATUS", "SM".padEnd(34, "9")), null);
  assert.match((await text(mayaPhone, "status"))!, /waiting to be seen.*likely be seen within/);
  assert.equal(await text(mayaPhone, "Worse"), WORSE_REPLY);
  assert.equal((await f.tasks())[0].kind, "recheck");

  await f.play(40, 10);
  const queued = (await texts()).filter((row) => row.status === "queued");
  assert.equal(queued.length >= 2, true);
  assert.match(queued.at(-1)!.body, /^Your estimate has changed\./);
  // With no provider configured the sender marks them simulated; a live sender delivers them.
  assert.equal(await dispatchJourneySms(f.pool, null, f.now()), queued.length);
  assert.equal(
    (await texts()).every((row) => row.status === "simulated"),
    true,
  );
  await f.play(112, 40);
  const sent: string[] = [];
  await dispatchJourneySms(
    f.pool,
    {
      send: async (input) => {
        sent.push(input.to);
        return { sid: `SM${"a".repeat(32)}`, status: "accepted" };
      },
    },
    f.now(),
  );
  assert.equal(sent.length > 0 && sent.every((to) => to === mayaPhone), true);

  // STOP ends texts at once.
  await text(mayaPhone, "STOP");
  const before = (await texts()).length;
  await f.play(160, 112);
  assert.equal((await texts()).length, before);
});

test("Alex's journey tools unlock only after the code, and speak through the Guardian", async (t) => {
  const f = await fixture(t);
  await f.play(40);
  const sent: { body: string }[] = [];
  const voice = new VoiceAgent(f.pool, {
    now: f.now,
    smsProvider: {
      send: async (input) => {
        sent.push(input);
        return { sid: `SM${String(sent.length).padStart(32, "0")}`, status: "queued" };
      },
    },
  });
  const line = await voice.store.beginInbound({
    sid: "CA-journey",
    from: "+15005550009",
    departmentId: "demo-department",
  });
  let serial = 0;
  const run = (name: string, args: Record<string, unknown> = {}) =>
    voice.run(line.id, `tool-${++serial}`, name, args) as Promise<any>;

  assert.equal((await run("get_journey_status")).status, "patient_details_required");
  await run("identify_emergency_patient", { patientName: "Maya Chen", dateOfBirth: "1990-04-12" });
  await run("send_emergency_contact_code", {
    contactName: "Jamie Singh",
    relationship: "Friend",
    resend: false,
  });
  assert.equal((await run("get_journey_status")).status, "authorization_required");
  assert.equal(
    (await run("relay_question", { question: "Can she eat?" })).status,
    "authorization_required",
  );
  await voice.verifyCode(line.id, /\b\d{8}\b/.exec(sent.at(-1)!.body)![0]);

  // The registered contact, with no entry on the visit page, hears the step and no estimate.
  const status = await run("get_journey_status");
  assert.equal(status.status, "journey_status");
  assert.equal(status.say, "Maya is waiting to be seen, and some tests have been started.");
  assert.equal(status.estimateShared, false);

  const relayed = await run("relay_question", { question: "Can she take her evening pills?" });
  assert.equal(relayed.status, "relayed");
  assert.equal(relayed.say, QUESTION_REPLY);
  const mine = await f.tasks();
  assert.equal(
    mine[0].summary,
    'Question by phone from Friend: "Can she take her evening pills?".',
  );

  // Once the patient shares estimates with that number, the caller hears the range too.
  await f.as("patient", {
    method: "POST",
    url: "/journey/visit/contacts",
    payload: {
      name: "Jamie Singh",
      relationship: "Friend",
      phone: registeredPhone,
      scopes: ["status", "estimates"],
    },
  });
  const shared = await run("get_journey_status");
  assert.equal(shared.estimateShared, true);
  assert.match(shared.say, /They'll likely be seen within about /);

  // A silenced visit sounds like any other transfer.
  await f.as("staff", {
    method: "POST",
    url: `/journey/desk/encounters/${await f.maya()}/flags`,
    payload: { flag: "vip", active: true },
  });
  assert.deepEqual(
    [
      (await run("get_journey_status")).say,
      (await run("relay_question", { question: "Any news?" })).say,
    ],
    [HANDOFF_REPLY, HANDOFF_REPLY],
  );
  const audited = await f.pool.query(
    "SELECT action FROM ed_audit WHERE action LIKE 'voice_status_%' ORDER BY seq",
  );
  assert.deepEqual(
    audited.rows.map((row) => row.action),
    ["voice_status_allow", "voice_status_allow", "voice_status_handoff"],
  );
});

test("the accuracy ledger and mission control report what happened", async (t) => {
  const f = await fixture(t, () => [call("do_nothing")]);
  await f.play(240);
  const accuracy = (await f.as("staff", { method: "GET", url: "/journey/desk/accuracy" })).body;
  assert.equal(accuracy.model, "stage-gbq-1");
  const stages = accuracy.stages.map((row: any) => row.stage).sort();
  assert.deepEqual(stages, ["decision", "provider", "results", "triage"]);
  for (const row of accuracy.stages) {
    assert.equal(row.inside + row.over + row.under <= row.total, true);
    assert.equal(row.widening >= 1 && row.widening <= 2, true);
    assert.equal(typeof row.medianErrorMinutes, "number");
  }
  assert.equal(accuracy.points.length > 10, true);
  assert.equal(
    accuracy.points.every((point: any) => point.low <= point.high),
    true,
  );
  assert.equal(accuracy.published.total > 0, true);

  const mission = (await f.as("staff", { method: "GET", url: "/journey/desk/mission" })).body;
  assert.equal(mission.hl7.length, 30);
  assert.match(mission.hl7[0].type, /^(ADT|ORM|ORU) /);
  assert.equal(
    mission.runs.some((run: any) => run.planner === "model"),
    true,
  );
  assert.equal(mission.totals.modelRuns > 0 && mission.totals.held > 0, true);
  assert.equal(mission.thread.length > 0, true);
  // Neither view is open to a patient session or to nobody.
  assert.equal(
    (await f.as("patient", { method: "GET", url: "/journey/desk/mission" })).status,
    404,
  );
  assert.equal((await f.as(null, { method: "GET", url: "/journey/desk/accuracy" })).status, 401);
});
