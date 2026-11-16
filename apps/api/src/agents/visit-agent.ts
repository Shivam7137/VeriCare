import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { canonicalJson, encounterById, journeyTransaction } from "../journey/records.js";
import { PlannerError, type Planner } from "./llm.js";
import { createRetriever, type Retriever } from "./retrieval.js";
import { settleWake, type ModelPlan, type Outcome } from "./settle.js";
import { contextPack, toolsFor, visitAgentInstructions, type Wake } from "./wake.js";

// The Visit Agent's runner. Each wake is planned outside any transaction (the model can be
// slow), then applied inside one. Without a planner the rules path settles wakes where they
// are raised and this runner has nothing to do.

export type VisitAgent = ReturnType<typeof createVisitAgent>;

/**
 * How many visits are planned at once. A model call holds no database connection, and each
 * visit holds at most one while it applies a plan, so three leave room in the five-connection
 * pool for the feed and the pages.
 */
const PARALLEL_VISITS = 3;

export function createVisitAgent(
  pool: Pool,
  options: {
    planner?: Planner | null;
    retriever?: Retriever;
    now?: () => Date;
    onError?: (error: unknown) => void;
  } = {},
) {
  const planner = options.planner ?? null;
  const retriever = options.retriever ?? createRetriever();
  const now = options.now ?? (() => new Date());
  const claimed = new Set<string>();
  let chain: Promise<void> = Promise.resolve();

  async function run(wakeId: string): Promise<Outcome | null> {
    if (claimed.has(wakeId)) return null;
    claimed.add(wakeId);
    try {
      const row = await pool.query<Wake & { encounterId: string; settledAt: Date | null }>(
        `SELECT id, reason, payload, encounter_id AS "encounterId", settled_at AS "settledAt"
         FROM ed_agent_wakes WHERE id = $1`,
        [wakeId],
      );
      const wake = row.rows[0];
      if (!wake || wake.settledAt) return null;
      const seen = await encounterById(pool, wake.encounterId);
      if (!seen) return null;
      const knowledge = wake.payload.message
        ? await retriever.search(wake.payload.message.text)
        : [];
      const context = await contextPack(pool, seen, wake, knowledge);
      const hash = createHash("sha256").update(canonicalJson(context)).digest("hex");
      let plan: ModelPlan | null = null;
      // A visit that ended while this wake waited has nothing left to decide: the rules
      // settle it (and the Guardian refuses its updates) without a model call.
      if (planner && !(seen.state.ended && !wake.payload.message)) {
        const started = Date.now();
        try {
          const calls = await planner.plan({
            instructions: visitAgentInstructions,
            context,
            tools: toolsFor(wake.reason),
          });
          plan = { calls, model: planner.model, latencyMs: Date.now() - started };
        } catch (error) {
          plan = {
            failed: error instanceof PlannerError ? error.reason : "planner_error",
            model: planner.model,
            latencyMs: Date.now() - started,
          };
        }
      }
      return await journeyTransaction(pool, async (db) => {
        // The visit row is the lock every writer takes first, so take it before the wake.
        const encounter = await encounterById(db, wake.encounterId, true);
        const open = await db.query(
          "SELECT 1 FROM ed_agent_wakes WHERE id = $1 AND settled_at IS NULL FOR UPDATE",
          [wakeId],
        );
        if (!encounter || open.rowCount === 0) return null;
        return settleWake(db, encounter, wake, plan, now(), hash);
      });
    } finally {
      claimed.delete(wakeId);
    }
  }

  return {
    /** True when a model plans the wakes, so callers leave them for this runner. */
    defer: planner !== null,
    model: planner?.model ?? null,
    retriever,
    /** Settles one wake now and returns what happened. Used for a message that needs a reply. */
    settle: run,
    /**
     * Settles every waiting wake. Visits are planned side by side, because a model call takes
     * a second or two and a busy department wakes many visits at once; one visit's wakes still
     * run strictly in order, so its updates never arrive out of sequence. Safe to call often.
     */
    drain(): Promise<void> {
      chain = chain.then(async () => {
        // A message that needs a reply is settled by the request that brought it. It is
        // picked up here only if that request died and left it waiting.
        const waiting = await pool.query<{ id: string; encounterId: string }>(
          `SELECT id, encounter_id AS "encounterId" FROM ed_agent_wakes WHERE settled_at IS NULL
             AND (reason NOT IN ('inbound_message', 'contact_question') OR created_at < $1)
           ORDER BY seq LIMIT 100`,
          [new Date(now().getTime() - 30_000)],
        );
        const byVisit = new Map<string, string[]>();
        for (const row of waiting.rows)
          byVisit.set(row.encounterId, [...(byVisit.get(row.encounterId) ?? []), row.id]);
        const queues = [...byVisit.values()];
        const worker = async () => {
          for (let queue = queues.shift(); queue; queue = queues.shift())
            for (const id of queue) await run(id).catch((error) => options.onError?.(error));
        };
        await Promise.all(Array.from({ length: Math.min(PARALLEL_VISITS, queues.length) }, worker));
      });
      return chain.catch((error) => options.onError?.(error));
    },
  };
}
