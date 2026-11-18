import assert from "node:assert/strict";
import test from "node:test";
import { kbArticles } from "../src/agents/kb.js";
import { checkArticle, cleanTopic, redactQuestion } from "../src/agents/knowledge.js";
import { buildIndex, rankArticles } from "../src/agents/retrieval.js";
import { toolsFor, visitAgentInstructions } from "../src/agents/wake.js";

test("questions shown to staff lose numbers, links and addresses", () => {
  assert.equal(
    redactQuestion("Call me at +1 (902) 555-0199 or mail a.b@example.org,  see www.x.ca/y"),
    "Call me at [number] or mail [email], see [link]",
  );
  // Short numbers that carry no identity stay readable.
  assert.equal(redactQuestion("Is room 12 on level 2?"), "Is room 12 on level 2?");
  assert.equal(redactQuestion("x".repeat(400)).length, 200);
});

test("a gap topic must be short and generic", () => {
  assert.equal(cleanTopic('  "Pharmacy open at night" '), "Pharmacy open at night");
  for (const bad of ["no", "x".repeat(121), "Call 9025550123", "see http://x.ca", 42, null])
    assert.equal(cleanTopic(bad), null, String(bad));
});

test("published articles are plain text of a sensible length with no links", () => {
  assert.deepEqual(
    checkArticle({ title: "  Quiet   room ", body: "There is a quiet room by the chapel." }),
    {
      title: "Quiet room",
      body: "There is a quiet room by the chapel.",
    },
  );
  assert.throws(
    () => checkArticle({ title: "Pay", body: "Pay online at https://pay.example now." }),
    /link_not_allowed/,
  );
  assert.throws(() => checkArticle({ title: "ok title", body: "too short" }), /invalid_body/);
  assert.throws(
    () => checkArticle({ title: "x", body: "This body is long enough to pass." }),
    /invalid_title/,
  );
});

test("an article without a stored vector still ranks on words; one with a vector can rank on meaning", () => {
  const index = buildIndex(kbArticles);
  const wifi = kbArticles.findIndex((article) => article.id === "wifi");
  const axis = (i: number) => kbArticles.map((_, n) => (n === i ? 1 : 0));
  // "Hotspot" shares no word with the Wi-Fi article: only meaning finds it.
  assert.deepEqual(rankArticles(index, "hotspot", null), []);
  const vectors = kbArticles.map((_, i) => (i === wifi ? axis(wifi) : null));
  const found = rankArticles(index, "hotspot", { question: axis(wifi), vectors });
  assert.equal(found[0]?.article.id, "wifi");
  assert.equal(found[0]?.via, "hybrid");
});

test("message wakes offer the gap tool, other wakes do not, and the instructions say when to use it", () => {
  const names = (reason: Parameters<typeof toolsFor>[0]) =>
    toolsFor(reason).map((tool) => tool.name);
  assert.ok(names("inbound_message").includes("report_knowledge_gap"));
  assert.ok(names("contact_question").includes("report_knowledge_gap"));
  for (const reason of ["step_change", "estimate_shift", "check_in_due"] as const)
    assert.equal(names(reason).includes("report_knowledge_gap"), false);
  assert.match(visitAgentInstructions, /report_knowledge_gap/);
  assert.match(visitAgentInstructions, /Never report a gap for anything clinical/);
});
