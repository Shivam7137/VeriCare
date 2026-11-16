import { createHash, randomUUID } from "node:crypto";
import type { StaffTaskKind } from "@prc/contracts";
import type { Database } from "../domain.js";
import { decideDisclosure } from "../journey/guardian.js";
import {
  COMFORT_REPLY,
  CONTACT_WORSE_REPLY,
  HANDOFF_REPLY,
  INTERPRETER_REPLY,
  LEAVING_REPLY,
  QUESTION_REPLY,
  WORSE_REPLY,
} from "../journey/messages.js";
import { deliver } from "../journey/outbox.js";
import {
  activeContacts,
  audit,
  canonicalJson,
  feedStatus,
  saveAgentMemory,
  type AgentMemory,
  type Encounter,
} from "../journey/records.js";
import {
  interpreterWords,
  openTask,
  statusWords,
  triageText,
  waitedText,
} from "../journey/tasks.js";
import { kbArticle } from "./kb.js";
import type { ToolCall } from "./llm.js";
import { toolsFor, type Candidate, type Wake, type WakePayload, type WakeReason } from "./wake.js";

// Turns a plan into actions. Every step passes the Guardian again here, with the visit's
// state as it is now, so a plan made a moment ago cannot send what is no longer allowed.

const MIN = 60_000;
const RANGE_TEXT_GAP_MS = 30 * MIN;
const RANGE_TEXT_LIMIT = 6;
const MAX_CALLS = 6;

export type PlanStep = {
  tool: string;
  args: Record<string, unknown>;
  verdict: "done" | "denied";
  why: string;
};
export type Outcome = {
  /** For an inbound message: what kind of reply it got (worse, question, kb, status...). */
  kind: string | null;
  reply: string | null;
  planner: "model" | "rules";
  steps: PlanStep[];
};
export type ModelPlan =
  | { calls: ToolCall[]; model: string; latencyMs: number }
  | { failed: string; model: string; latencyMs: number };

const taskKinds = new Set<string>(["question", "recheck", "leaving", "interpreter", "comfort"]);

/** A staff summary written by the model: one plain line, nothing that looks like contact details. */
export function cleanSummary(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value
    .replace(/\s+/g, " ")
    .replace(/^["'\s]+|["'\s]+$/g, "")
    .trim();
  if (text.length < 3 || text.length > 200) return null;
  if (/https?:|www\.|\d{7,}|@\w+\.\w/i.test(text)) return null;
  return text;
}

/**
 * Queues a wake for the Visit Agent. With `defer` the model plans it after this
 * transaction commits; without, the rules planner settles it here and now.
 */
export async function wakeAgent(
  db: Database,
  encounter: Encounter,
  reason: WakeReason,
  payload: WakePayload,
  now: Date,
  defer: boolean,
): Promise<{ wakeId: string; outcome: Outcome | null } | null> {
  if (payload.candidates.length === 0 && !payload.message) return null;
  const save = async (item: WakePayload) => {
    const wake: Wake = { id: randomUUID(), reason, payload: item };
    await db.query(
      "INSERT INTO ed_agent_wakes (id, encounter_id, reason, payload, created_at) VALUES ($1,$2,$3,$4,$5)",
      [wake.id, encounter.id, reason, item, now],
    );
    return wake;
  };
  const floors = payload.candidates.filter((candidate) => candidate.floor);
  const choices = payload.candidates.filter((candidate) => !candidate.floor);
  // Only a real choice is worth a model's time. With nothing optional, the rules settle it here.
  if (!defer || (choices.length === 0 && !payload.message)) {
    const wake = await save(payload);
    return { wakeId: wake.id, outcome: await settleWake(db, encounter, wake, null, now) };
  }
  // Floors never wait for a model: they go out now, in this transaction.
  if (floors.length > 0)
    await settleWake(db, encounter, await save({ ...payload, candidates: floors }), null, now);
  const wake = await save({ ...payload, candidates: choices });
  return { wakeId: wake.id, outcome: null };
}

export async function settleWake(
  db: Database,
  encounter: Encounter,
  wake: Wake,
  plan: ModelPlan | null,
  now: Date,
  contextHash?: string,
): Promise<Outcome> {
  const { candidates, message } = wake.payload;
  const feed = await feedStatus(db, encounter.site);
  const feedNow = feed?.feedTime.getTime() ?? now.getTime();
  const contacts = await activeContacts(db, encounter.id);
  // Read fresh: an earlier wake in this same transaction may have changed it.
  const saved = await db.query<{ agent: AgentMemory }>(
    "SELECT agent FROM ed_encounters WHERE id = $1",
    [encounter.id],
  );
  const memory: AgentMemory = structuredClone(saved.rows[0]?.agent ?? {});
  const sender = message?.contactId
    ? (contacts.find((contact) => contact.id === message.contactId) ?? null)
    : null;
  const sent = new Set<string>();
  const steps: PlanStep[] = [];
  let reply: string | null = null;
  let kind: string | null = null;
  let answers = 0;
  // A message can need two things at once (a blanket and where to park), so two fixed
  // replies may be joined. The first one names the kind.
  const answer = (text: string, as: string) => {
    kind ??= as;
    if (!reply) reply = text;
    else if (answers < 2 && !reply.includes(text)) reply = `${reply} ${text}`;
    else return;
    answers += 1;
  };

  const blocked = (candidate: Candidate): string | null => {
    if (candidate.step && encounter.state.step !== candidate.step) return "superseded";
    const contact = candidate.contactId
      ? contacts.find((item) => item.id === candidate.contactId)
      : null;
    if (candidate.audience === "contact" && !contact) return "consent_withdrawn";
    const decision = decideDisclosure({
      audience: candidate.audience,
      verified: true,
      consentScopes: contact?.scopes ?? null,
      state: encounter.state,
      feedLastMessageAt: feed?.lastMessageAt ?? null,
      now,
      request: candidate.requires,
    });
    if (decision.outcome !== "allow") return `guardian_${decision.reason}`;
    if (candidate.requires === "estimate" && !decision.estimate) return "guardian_no_estimate";
    if (contact && candidate.proactive && !contact.scopes.includes("alerts"))
      return "no_alerts_scope";
    return null;
  };

  const send = async (candidate: Candidate, why: string, args: Record<string, unknown>) => {
    const step = (verdict: PlanStep["verdict"], note: string) =>
      steps.push({ tool: candidate.tool, args, verdict, why: note });
    if (sent.has(candidate.id)) return step("denied", "already sent");
    const refusal = blocked(candidate);
    if (refusal) return step("denied", refusal);
    if (candidate.limited && !candidate.floor) {
      // No more than one unprompted range text per half hour, six per visit, per person.
      const key = candidate.contactId ?? "patient";
      const count = memory.range?.[key];
      if (count && (count.count >= RANGE_TEXT_LIMIT || feedNow - count.at < RANGE_TEXT_GAP_MS))
        return step("denied", "rate_limit");
      memory.range = { ...memory.range, [key]: { count: (count?.count ?? 0) + 1, at: feedNow } };
    }
    if (candidate.asReply) answer(candidate.body, candidate.kind);
    else
      await deliver(db, {
        encounterId: encounter.id,
        audience: candidate.audience,
        contactId: candidate.contactId,
        kind: candidate.kind,
        body: candidate.body,
        at: now,
      });
    if (candidate.tool === "ask_check_in") {
      memory.lastCheckInAskAt = feedNow;
      delete memory.nextCheckInAt;
    }
    sent.add(candidate.id);
    step("done", why);
  };

  /** Puts something on the Desk. Priority has a floor set here that no plan can lower. */
  const raise = async (
    taskKind: StaffTaskKind,
    wanted: number,
    detail: string,
    why: string,
    args: Record<string, unknown>,
  ) => {
    if (!message)
      return steps.push({ tool: "open_staff_task", args, verdict: "denied", why: "no_message" });
    const context = `${triageText(encounter)}${waitedText(encounter, feed?.feedTime)}`;
    const who = sender ? sender.relationship : "the patient";
    let priority: 1 | 2 | 3;
    let summary: string;
    let text: string;
    switch (taskKind) {
      case "recheck":
        priority = 1;
        summary = sender
          ? `${who} reports the patient may be getting worse: ${detail}${context}`
          : `Patient may be getting worse: ${detail}${context}`;
        text = sender ? CONTACT_WORSE_REPLY : WORSE_REPLY;
        break;
      case "leaving":
        priority = encounter.state.ctas !== null && encounter.state.ctas <= 3 ? 1 : 2;
        summary = `Patient is thinking of leaving.${context}`;
        text = sender ? QUESTION_REPLY : LEAVING_REPLY;
        break;
      case "interpreter":
        priority = 2;
        summary = `${sender ? who : "Patient"} asked for an interpreter: ${detail}`;
        text = INTERPRETER_REPLY;
        break;
      case "comfort":
        priority = wanted <= 2 ? 2 : 3;
        summary = `Comfort request from ${who}: ${detail}`;
        text = COMFORT_REPLY;
        break;
      default:
        priority = wanted <= 2 ? 2 : 3;
        summary = `Question from ${who}: ${detail}`;
        text = QUESTION_REPLY;
    }
    await openTask(db, encounter, taskKind, priority, summary, now, sender?.id ?? null);
    answer(text, taskKind === "recheck" ? "worse" : taskKind);
    steps.push({ tool: "open_staff_task", args: { ...args, priority }, verdict: "done", why });
  };

  const applyCall = async (call: ToolCall) => {
    const args = call.args;
    const why = typeof args.why === "string" ? args.why.slice(0, 200) : "";
    const deny = (note: string) =>
      steps.push({ tool: call.name, args, verdict: "denied", why: note });
    if (!toolsFor(wake.reason).some((tool) => tool.name === call.name))
      return deny("tool_not_offered");
    switch (call.name) {
      case "notify": {
        const candidate = candidates.find(
          (item) => item.tool === "notify" && item.id === args.action_id,
        );
        return candidate ? send(candidate, why, args) : deny("unknown_action");
      }
      case "ask_check_in": {
        const candidate = candidates.find((item) => item.tool === "ask_check_in");
        return candidate ? send(candidate, why, args) : deny("not_due");
      }
      case "open_staff_task": {
        const summary = cleanSummary(args.summary);
        if (typeof args.kind !== "string" || !taskKinds.has(args.kind)) return deny("unknown_kind");
        if (!summary) return deny("summary_rejected");
        return raise(args.kind as StaffTaskKind, Number(args.priority) || 3, summary, why, args);
      }
      case "answer_from_kb": {
        const article = typeof args.article_id === "string" ? kbArticle(args.article_id) : null;
        if (!message || !article) return deny("unknown_article");
        answer(article.body, "kb");
        return steps.push({ tool: call.name, args, verdict: "done", why });
      }
      case "handoff":
        answer(HANDOFF_REPLY, "handoff");
        return steps.push({ tool: call.name, args, verdict: "done", why });
      case "schedule_wake": {
        const minutes = Number(args.minutes);
        if (!Number.isInteger(minutes) || minutes < 10 || minutes > 60)
          return deny("out_of_bounds");
        memory.nextCheckInAt = feedNow + minutes * MIN;
        return steps.push({ tool: call.name, args, verdict: "done", why });
      }
      case "do_nothing":
        return steps.push({ tool: call.name, args, verdict: "done", why });
      default:
        return deny("tool_not_offered");
    }
  };

  /** The rules path: what the system does with no model, and whenever a plan fails. */
  const rules = async () => {
    for (const candidate of candidates)
      if (!candidate.asReply && !sent.has(candidate.id))
        await send(
          candidate,
          candidate.floor ? "Floor: always sent." : "Rules: every allowed update is sent.",
          { action_id: candidate.id },
        );
    if (!message || reply) return;
    const quoted = `"${message.text}".`;
    if (interpreterWords.test(message.text))
      await raise("interpreter", 2, quoted, "Rules: language words.", {});
    else if (statusWords.test(message.text)) {
      const status = candidates.find((candidate) => candidate.asReply);
      if (status) await send(status, "Rules: asked for status.", { action_id: status.id });
    } else await raise("question", 3, quoted, "Rules: anything unrecognised goes to staff.", {});
  };

  let planner: Outcome["planner"] = "rules";
  let fallback: string | null = null;
  if (plan && "calls" in plan) {
    for (const candidate of candidates)
      if (candidate.floor)
        await send(candidate, "Floor: always sent.", { action_id: candidate.id });
    const from = steps.length;
    for (const call of plan.calls.slice(0, MAX_CALLS)) await applyCall(call);
    if (steps.slice(from).some((step) => step.verdict === "done")) planner = "model";
    else fallback = plan.calls.length ? "plan_rejected" : "empty_plan";
    // The visit moved on while the model was thinking. The rules would be refused the same way.
    if (steps.length > from && steps.slice(from).every((step) => step.why === "superseded"))
      fallback = "superseded";
  } else if (plan) fallback = plan.failed;
  if (planner === "rules" && fallback !== "superseded") await rules();

  if (message) {
    // Whoever wrote to us always gets an answer, and never a silent one.
    if (!reply) answer(HANDOFF_REPLY, "handoff");
    await deliver(db, {
      encounterId: encounter.id,
      audience: message.from,
      contactId: sender?.id,
      kind: `reply_${kind}`,
      body: reply!,
      at: now,
      text: false,
      channel: message.channel,
    });
  }

  await saveAgentMemory(db, encounter.id, memory);
  await db.query(
    `INSERT INTO ed_agent_runs
       (id, encounter_id, wake, planner, model, fallback_reason, context_hash, plan, latency_ms, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      randomUUID(),
      encounter.id,
      wake.reason,
      planner,
      plan?.model ?? null,
      fallback,
      contextHash ?? createHash("sha256").update(canonicalJson(wake.payload)).digest("hex"),
      JSON.stringify(steps),
      plan?.latencyMs ?? null,
      now,
    ],
  );
  await db.query("UPDATE ed_agent_wakes SET settled_at = $2 WHERE id = $1", [wake.id, now]);
  await audit(db, {
    at: now,
    actor: "visit-agent",
    action: "agent_run",
    encounterId: encounter.id,
    detail: {
      wake: wake.reason,
      planner,
      done: steps.filter((step) => step.verdict === "done").map((step) => step.tool),
      denied: steps.filter((step) => step.verdict === "denied").length,
    },
  });
  return { kind, reply, planner, steps };
}
