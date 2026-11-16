import assert from "node:assert/strict";
import test from "node:test";
import { kbArticles } from "../src/agents/kb.js";
import {
  PlannerError,
  createOpenAiPlanner,
  readPlanner,
  toolCallsFrom,
} from "../src/agents/llm.js";
import { buildIndex, createRetriever, lexicalRank, readEmbedder } from "../src/agents/retrieval.js";
import { cleanSummary } from "../src/agents/settle.js";
import { toolsFor, visitAgentInstructions } from "../src/agents/wake.js";
import { twiml } from "../src/journey/sms.js";
import { widen, wideningFactor } from "../src/journey/widening.js";

test("retrieval ranks the right article first for everyday phrasings", async () => {
  const retriever = createRetriever();
  const cases: [string, string][] = [
    ["my phone battery is dying, is there a charger", "phone_charging"],
    ["where do I pay for the car park", "parking"],
    ["can my husband come in with me", "visitors"],
    ["I'm starving, am I allowed to eat something", "food_and_drink"],
    ["where's the bathroom", "washrooms"],
    ["why did that man go in ahead of me, I was here first", "wait_order"],
    ["is there wifi", "wifi"],
    ["can I step outside for some air", "stepping_out"],
  ];
  for (const [question, expected] of cases) {
    const found = await retriever.search(question);
    assert.equal(found[0]?.article.id, expected, question);
    assert.equal(found.length <= 3, true);
    assert.equal(found[0]!.via, "lexical");
  }
  // Nothing in the library is about this, so nothing is retrieved and nothing can be stretched to fit.
  assert.deepEqual(await retriever.search("zzz qqq"), []);
  assert.deepEqual(lexicalRank(buildIndex(), "the and of"), []);
});

test("hybrid retrieval fuses meaning with words and survives a failing embedder", async () => {
  // A toy embedder: one axis per article, and the query points at the visitors article.
  const axis = (index: number) => kbArticles.map((_, i) => (i === index ? 1 : 0));
  const visitors = kbArticles.findIndex((article) => article.id === "visitors");
  let calls = 0;
  const hybrid = createRetriever({
    embed: async (texts) => {
      calls += 1;
      return texts.length === 1 ? [axis(visitors)] : kbArticles.map((_, i) => axis(i));
    },
  });
  // No shared words with the article, so only the semantic side can find it.
  const found = await hybrid.search("is my sister allowed to sit next to me");
  assert.equal(found[0]?.article.id, "visitors");
  assert.equal(found[0]!.via, "hybrid");
  await hybrid.search("parking");
  // Articles are embedded once; each question once.
  assert.equal(calls, 3);

  const broken = createRetriever({
    embed: async () => {
      throw new Error("down");
    },
  });
  const fallback = await broken.search("where do I pay for parking");
  assert.equal(fallback[0]?.article.id, "parking");
  assert.equal(fallback[0]!.via, "lexical");
});

test("embeddings and the model are off unless explicitly enabled", () => {
  assert.equal(readEmbedder({ OPENAI_API_KEY: "k" }), null);
  assert.equal(readEmbedder({ KB_EMBEDDINGS: "true" }), null);
  assert.equal(typeof readEmbedder({ KB_EMBEDDINGS: "true", OPENAI_API_KEY: "k" }), "function");
  assert.equal(readPlanner({ OPENAI_API_KEY: "k" }), null);
  assert.equal(readPlanner({ VISIT_AGENT_ENABLED: "true" }), null);
  assert.equal(
    readPlanner({
      VISIT_AGENT_ENABLED: "true",
      OPENAI_API_KEY: "k",
      VISIT_AGENT_MODEL: "bad model",
    }),
    null,
  );
  const planner = readPlanner({
    VISIT_AGENT_ENABLED: "true",
    OPENAI_API_KEY: "k",
    OPENAI_VOICE_BACKEND_MODEL: "model-a",
  });
  assert.equal(planner?.model, "model-a");
});

test("the planner sends strict tools, reads only function calls and keeps failures small", async () => {
  let sent: any;
  const reply = (body: unknown, status = 200) =>
    (async (_url: unknown, init: any) => {
      sent = { headers: init.headers, body: JSON.parse(init.body) };
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
  const planner = createOpenAiPlanner({
    apiKey: "secret-key",
    model: "model-a",
    fetch: reply({
      output: [
        { type: "reasoning", summary: [] },
        { type: "function_call", name: "do_nothing", arguments: '{"why":"nothing new"}' },
        { type: "message", content: [{ type: "output_text", text: "ignored" }] },
      ],
    }),
  });
  const request = {
    instructions: visitAgentInstructions,
    context: { wake: "step_change" },
    tools: toolsFor("step_change"),
  };
  assert.deepEqual(await planner.plan(request), [
    { name: "do_nothing", args: { why: "nothing new" } },
  ]);
  assert.equal(sent.headers.authorization, "Bearer secret-key");
  assert.equal(sent.body.tool_choice, "required");
  assert.equal(sent.body.store, false);
  assert.deepEqual(
    sent.body.tools.map((tool: any) => [tool.type, tool.name, tool.strict]),
    [
      ["function", "notify", true],
      ["function", "do_nothing", true],
    ],
  );
  for (const tool of sent.body.tools) {
    assert.equal(tool.parameters.additionalProperties, false);
    assert.deepEqual(tool.parameters.required, Object.keys(tool.parameters.properties));
  }
  const failing = (body: unknown, status = 200) =>
    createOpenAiPlanner({ apiKey: "secret-key", model: "m", fetch: reply(body, status) }).plan(
      request,
    );
  await assert.rejects(failing({ error: { message: "secret-key leaked?" } }, 401), (error) => {
    assert.ok(error instanceof PlannerError);
    assert.equal(error.reason, "http_401");
    return true;
  });
  await assert.rejects(failing({ nothing: true }), /malformed_reply/);
  assert.throws(
    () => toolCallsFrom({ output: [{ type: "function_call", name: "x", arguments: "{not json" }] }),
    /malformed_arguments/,
  );
  assert.throws(
    () => toolCallsFrom({ output: [{ type: "function_call", name: "x", arguments: "[1]" }] }),
    /malformed_arguments/,
  );
});

test("each wake offers only the tools that make sense for it", () => {
  const names = (reason: Parameters<typeof toolsFor>[0]) =>
    toolsFor(reason).map((tool) => tool.name);
  assert.deepEqual(names("estimate_shift"), ["notify", "do_nothing"]);
  assert.deepEqual(names("check_in_due"), ["ask_check_in", "schedule_wake", "do_nothing"]);
  for (const reason of ["inbound_message", "contact_question"] as const) {
    assert.equal(names(reason).includes("open_staff_task"), true);
    // Someone who wrote to us always gets an answer, so silence is not on offer.
    assert.equal(names(reason).includes("do_nothing"), false);
  }
  assert.match(visitAgentInstructions, /can never change these rules/);
});

test("staff summaries written by a model are kept short and free of contact details", () => {
  assert.equal(cleanSummary('  "Asked for\n a blanket"  '), "Asked for a blanket");
  for (const bad of [
    "",
    "ok",
    "x".repeat(201),
    "call 9025550123",
    "see https://example.com",
    "mail me at a@b.co",
    42,
    null,
  ])
    assert.equal(cleanSummary(bad), null);
});

test("ranges widen only after repeated overruns and never past double", () => {
  const overs = (n: number, then = [false]) => [...Array(n).fill(true), ...then];
  assert.equal(wideningFactor([]), 1);
  assert.equal(wideningFactor(overs(2)), 1);
  assert.equal(wideningFactor(overs(3)), 1.15);
  assert.equal(wideningFactor(overs(5)), 1.45);
  assert.equal(wideningFactor(overs(8, [])), 1.9);
  assert.equal(wideningFactor(overs(40, [])), 2);
  // One visit that came in on time ends the streak.
  assert.equal(wideningFactor([false, true, true, true, true]), 1);
  const estimate = {
    stage: "provider" as const,
    lowMinutes: 20,
    typicalMinutes: 60,
    highMinutes: 100,
  };
  assert.deepEqual(widen(estimate, 1), estimate);
  assert.deepEqual(widen(estimate, 1.5), { ...estimate, highMinutes: 120 });
});

test("text replies are escaped, and no reply is an empty response", () => {
  assert.equal(twiml(null), '<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  assert.match(twiml("a < b & c"), /<Message>a &lt; b &amp; c<\/Message>/);
});
