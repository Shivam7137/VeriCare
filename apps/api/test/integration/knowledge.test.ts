import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import Fastify, { type InjectOptions } from "fastify";
import {
  createKnowledgeRetriever,
  recordGap,
  refreshKnowledge,
} from "../../src/agents/knowledge.js";
import type { PlanRequest, Planner, ToolCall } from "../../src/agents/llm.js";
import type { Embedder } from "../../src/agents/retrieval.js";
import { createVisitAgent } from "../../src/agents/visit-agent.js";
import { createSession } from "../../src/identity.js";
import { ingestHl7 } from "../../src/journey/ingest.js";
import { journeyTransaction } from "../../src/journey/records.js";
import { registerJourneyRoutes } from "../../src/journey/routes.js";
import { buildDemoScenario } from "../../src/twin/scenario.js";
import { workflowFixture } from "./workflow-fixture.js";

const start = new Date("2030-01-07T12:00:00.000Z");
const MIN = 60_000;
const NIGHT_BODY =
  "The hospital pharmacy closes at 9 pm. The pharmacy in the main lobby of the Dickson building is open all night.";

type Plan = (request: PlanRequest & { context: any }) => ToolCall[];
const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({
  name,
  args: { why: "test", ...args },
});

/** Every concept word becomes one axis, so "chemist" and "pharmacy" mean the same thing. */
const concepts = [/pharmac|chemist|prescription/i, /park|car/i, /charg|battery/i, /wifi|internet/i];
const fakeEmbedder = (): Embedder & { calls: number } => {
  const embed = (async (texts: readonly string[]) => {
    embed.calls += 1;
    return texts.map((text) => [...concepts.map((pattern) => (pattern.test(text) ? 1 : 0)), 0.01]);
  }) as Embedder & { calls: number };
  embed.calls = 0;
  embed.model = "fake-embedder";
  return embed;
};

async function fixture(t: TestContext, plan: Plan, embed: Embedder | null = null) {
  const f = await workflowFixture(t);
  await f.pool.query("UPDATE patients SET display_name='Maya Chen' WHERE id=$1", [
    f.patient.patientId,
  ]);
  // Registration links the feed's visit to this patient by name and birth date.
  await f.pool.query(
    `INSERT INTO emergency_patient_records
    (patient_id,date_of_birth,contact_name,contact_relationship,contact_number,facility,department,area,visitor_instructions)
    VALUES ($1,'1990-04-12','Jamie Singh','Friend','+15005550006','Fictional Halifax hospital','Emergency department','Assessment area B','Check in at reception.')`,
    [f.patient.patientId],
  );
  const seen: any[] = [];
  const planner: Planner = {
    model: "test-model",
    async plan(request) {
      seen.push(request.context);
      return plan(request as PlanRequest & { context: any });
    },
  };
  const retriever = createKnowledgeRetriever(f.pool, { embed, now: f.now });
  const agent = createVisitAgent(f.pool, { planner, retriever, now: f.now });
  for (const message of buildDemoScenario(start)) {
    if (message.atMinute > 40) continue;
    f.setNow(new Date(start.getTime() + message.atMinute * MIN));
    await ingestHl7(f.pool, message.raw, { now: f.now, defer: agent.defer });
    await agent.drain();
  }
  f.setNow(new Date(start.getTime() + 40 * MIN));
  const app = Fastify({ logger: false });
  registerJourneyRoutes(app, f.pool, { now: f.now, agent });
  await app.ready();
  t.after(() => app.close());
  const expires = new Date(start.getTime() + 86_400_000);
  const tokens = {
    patient: (await createSession(f.pool, "synthetic-patient-001", expires, f.now())).token,
    staff: (await createSession(f.pool, "synthetic-staff-001", expires, f.now())).token,
    other: (await createSession(f.pool, "synthetic-staff-other", expires, f.now())).token,
  };
  const as = async (who: keyof typeof tokens, options: InjectOptions) => {
    const response = await app.inject({
      ...options,
      headers: { authorization: `Bearer ${tokens[who]}` },
    });
    return { status: response.statusCode, body: response.json() as any };
  };
  const say = async (text: string) =>
    (await as("patient", { method: "POST", url: "/journey/visit/messages", payload: { text } }))
      .body as { kind: string; reply: string };
  const knowledge = async (who: "staff" | "other" = "staff") =>
    (await as(who, { method: "GET", url: "/journey/desk/knowledge" })).body;
  const save = (payload: Record<string, unknown>, who: "staff" | "other" = "staff") =>
    as(who, { method: "POST", url: "/journey/desk/knowledge/articles", payload });
  const lastPlan = async () =>
    (await f.pool.query("SELECT plan FROM ed_agent_runs ORDER BY seq DESC LIMIT 1")).rows[0]
      .plan as { tool: string; verdict: string; why: string }[];
  const encounterId = async () =>
    (
      await f.pool.query("SELECT id FROM ed_encounters WHERE patient_id = $1", [
        f.patient.patientId,
      ])
    ).rows[0].id as string;
  return { ...f, seen, retriever, as, say, knowledge, save, lastPlan, encounterId };
}

/** A model that answers from the library when it can, and otherwise reports the gap. */
const librarian: Plan = ({ context }) => {
  const text: string = context.message.text;
  const night = context.knowledge.find((item: any) => /pharmacy/i.test(item.title));
  if (night) return [call("answer_from_kb", { article_id: night.id })];
  if (/pharmacy/i.test(text))
    return [
      call("open_staff_task", { kind: "question", priority: 3, summary: "Asks about a pharmacy" }),
      call("report_knowledge_gap", { topic: "Is there a pharmacy open at night" }),
    ];
  return [call("handoff")];
};

test("an unanswered question becomes a gap, staff publish the answer, and the next person gets it", async (t) => {
  const f = await fixture(t, librarian);

  const first = await f.say("Is there a pharmacy open tonight? Text me on 902 555 0199");
  assert.equal(first.kind, "question");
  let view = await f.knowledge();
  assert.equal(view.stats.published, 10, "a department starts with the curated starters");
  assert.equal(view.gaps.length, 1);
  assert.equal(view.gaps[0].topic, "Is there a pharmacy open at night");
  // Staff never see the number the person typed.
  assert.deepEqual(view.gaps[0].examples, [
    "Is there a pharmacy open tonight? Text me on [number]",
  ]);

  // The same question again is folded into the same gap.
  await f.say("Any pharmacy open late around here?");
  view = await f.knowledge();
  assert.equal(view.gaps.length, 1);
  assert.equal(view.gaps[0].asked, 2);
  assert.equal(view.gaps[0].examples.length, 2);
  const gapId = view.gaps[0].id;

  // A draft is saved against the gap but reaches no one.
  const draft = await f.save({
    title: "Pharmacy at night",
    body: NIGHT_BODY,
    gapId,
    publish: false,
  });
  assert.equal(draft.status, 200);
  assert.equal(draft.body.state, "draft");
  view = await f.knowledge();
  assert.equal(view.gaps[0].draftId, draft.body.id);
  const tried = (
    await f.as("staff", {
      method: "POST",
      url: "/journey/desk/knowledge/search",
      payload: { question: "pharmacy open tonight" },
    })
  ).body;
  assert.equal(
    tried.matches.some((match: any) => match.id === draft.body.id),
    false,
  );

  // Publishing is the approval. It closes the gap.
  const published = await f.save({
    id: draft.body.id,
    title: "Pharmacy at night",
    body: NIGHT_BODY,
    gapId,
    publish: true,
  });
  assert.equal(published.body.state, "published");
  view = await f.knowledge();
  assert.equal(view.gaps.length, 0);
  assert.equal(view.stats.answeredGaps, 1);
  assert.equal(view.stats.published, 11);

  // The next person who asks gets the staff-written answer, word for word.
  const next = await f.say("where's a pharmacy open late tonight?");
  assert.equal(next.kind, "kb");
  assert.equal(next.reply, NIGHT_BODY);
  assert.equal(f.seen.at(-1).knowledge[0].id, "pharmacy_at_night");
  assert.equal((await f.knowledge()).stats.kbReplies, 1);

  const ledger = await f.pool.query<{ action: string }>("SELECT action FROM ed_audit ORDER BY seq");
  const actions = ledger.rows.map((row) => row.action);
  for (const action of ["kb_gap", "kb_article_saved", "kb_article_published"])
    assert.ok(actions.includes(action), action);
});

test("only published articles of the visit's own department can be sent, and inputs are checked", async (t) => {
  let wanted = "wifi";
  const f = await fixture(t, () => [
    call("answer_from_kb", { article_id: wanted }),
    call("report_knowledge_gap", { topic: "Call 9025550123 about it" }),
  ]);

  // A starter article works until staff retire it.
  assert.equal((await f.say("what is the wifi?")).kind, "kb");
  const plan = await f.lastPlan();
  assert.deepEqual(
    plan.map((step) => [step.tool, step.verdict, step.why]),
    [
      ["answer_from_kb", "done", "test"],
      ["report_knowledge_gap", "denied", "topic_rejected"],
    ],
  );
  const retired = await f.as("staff", {
    method: "POST",
    url: "/journey/desk/knowledge/articles/wifi/retire",
  });
  assert.equal(retired.status, 200);
  assert.notEqual((await f.say("what is the wifi?")).kind, "kb");
  assert.equal((await f.lastPlan())[0]!.why, "unknown_article");

  // A draft is never sent.
  const draft = await f.save({
    title: "Quiet room",
    body: "There is a quiet room by the chapel.",
    publish: false,
  });
  wanted = draft.body.id;
  assert.notEqual((await f.say("is there somewhere quiet?")).kind, "kb");

  // Links are refused, and so is a malformed article.
  const link = await f.save({
    title: "Parking app",
    body: "Pay for parking at https://pay.example before you leave.",
    publish: true,
  });
  assert.deepEqual([link.status, link.body.error], [400, "link_not_allowed"]);
  assert.equal((await f.save({ title: "x", body: "short", publish: true })).status, 400);

  // Another department sees its own starters and none of this department's work.
  const other = await f.knowledge("other");
  assert.equal(
    other.articles.some((article: any) => article.id === "quiet_room"),
    false,
  );
  assert.equal(other.articles.find((article: any) => article.id === "wifi").state, "published");
  const theirs = await f.as("other", {
    method: "POST",
    url: "/journey/desk/knowledge/articles/quiet_room/retire",
  });
  assert.equal(theirs.status, 404);

  // A patient has no access to the staff library.
  assert.equal(
    (await f.as("patient", { method: "GET", url: "/journey/desk/knowledge" })).status,
    404,
  );

  // Safety floors run before the library: the tester says so and retrieves nothing.
  const chest = (
    await f.as("staff", {
      method: "POST",
      url: "/journey/desk/knowledge/search",
      payload: { question: "I have chest pain, where is the washroom" },
    })
  ).body;
  assert.equal(chest.floor, "recheck");
  assert.deepEqual(chest.matches, []);
});

test("stored embeddings find answers by meaning and fold gaps that ask the same thing", async (t) => {
  const embed = fakeEmbedder();
  const f = await fixture(t, () => [call("handoff")], embed);
  const published = await f.save({ title: "Pharmacy at night", body: NIGHT_BODY, publish: true });
  assert.equal(published.status, 200);

  // "Chemist" shares no word with the article; meaning finds it.
  const lexical = createKnowledgeRetriever(f.pool, { now: f.now });
  assert.equal(
    (await lexical.search("late chemist", "demo-department")).some(
      (item) => item.article.id === "pharmacy_at_night",
    ),
    false,
  );
  const found = await f.retriever.search("late chemist", "demo-department");
  assert.equal(found[0]?.article.id, "pharmacy_at_night");
  assert.equal(found[0]?.via, "hybrid");
  // Article vectors were stored, so the next search embeds only the question.
  const before = embed.calls;
  await f.retriever.search("late chemist", "demo-department");
  assert.equal(embed.calls - before, 1);
  assert.equal(
    (await f.knowledge()).articles.find((article: any) => article.id === "pharmacy_at_night")
      .embedded,
    true,
  );

  // Two gaps too different in wording to fold on words, but the same in meaning, are folded
  // by the upkeep job.
  const encounterId = await f.encounterId();
  for (const [topic, question] of <[string, string][]>[
    ["Pharmacy open at night", "where can I get my prescription filled?"],
    ["Chemist open late", "is a chemist open late?"],
    ["Parking validation", "do you validate parking?"],
  ])
    await journeyTransaction(f.pool, (db) =>
      recordGap(db, {
        departmentId: "demo-department",
        encounterId,
        topic,
        question,
        now: f.now(),
      }),
    );
  assert.equal((await f.knowledge()).gaps.length, 3);
  const upkeep = await refreshKnowledge(f.pool, embed, f.now());
  assert.equal(upkeep.merged, 1);
  const gaps = (await f.knowledge()).gaps;
  assert.equal(gaps.length, 2);
  const medicine = gaps.find((gap: any) => gap.topic === "Pharmacy open at night");
  assert.equal(medicine.asked, 2);
  assert.equal(medicine.examples.length, 2);
  // The staff view points out an existing answer that may already cover it.
  assert.equal(medicine.suggestion?.id, "pharmacy_at_night");

  // An edited article loses its vector until it is embedded again.
  await f.save({
    id: "pharmacy_at_night",
    title: "Pharmacy at night",
    body: `${NIGHT_BODY} Bring your health card.`,
    publish: true,
  });
  const art = () =>
    f.knowledge().then((view) => view.articles.find((a: any) => a.id === "pharmacy_at_night"));
  assert.equal((await art()).embedded, false);
  assert.equal((await art()).version, 2);
  await refreshKnowledge(f.pool, embed, f.now());
  assert.equal((await art()).embedded, true);
});
