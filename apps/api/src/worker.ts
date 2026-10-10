import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type { Pool } from "pg";
import { runVoiceWorker } from "./voice-worker.js";
import { VoiceSms } from "./voice-sms.js";
import { createPool } from "./db.js";
import { dispatchDueJobs } from "./delivery.js";
import { lockTask, readWorkflow, saveTaskEvent, saveWorkflow, transaction } from "./domain.js";
import { BookingExecutor } from "./executor.js";
import { MockScheduler, type Scheduler } from "./scheduler.js";
import { activeProposal, cancelActions } from "./workflow.js";

async function expirePendingTasks(pool: Pool, now: Date) {
  const candidates = (
    await pool.query(
      `SELECT t.id FROM tasks t JOIN workflow_tasks w ON w.task_id=t.id
    JOIN proposal_drafts p ON p.task_id=t.id AND p.version=(w.payload->>'activeProposalVersion')::integer
    WHERE t.payload->>'state' IN ('awaiting_staff_approval','awaiting_patient_confirmation','ready_to_execute')
    AND ((p.payload->>'expiresAt')::timestamptz <= $1 OR (t.payload->>'state'<>'ready_to_execute' AND (w.payload->'callbackWindow'->>'endsAt')::timestamptz <= $1)) ORDER BY t.id LIMIT 100`,
      [now],
    )
  ).rows;
  let expired = 0;
  for (const { id } of candidates) {
    expired += await transaction(pool, async (db) => {
      const task = await lockTask(db, id);
      if (
        !["awaiting_staff_approval", "awaiting_patient_confirmation", "ready_to_execute"].includes(
          task.state,
        )
      )
        return 0;
      const workflow = await readWorkflow(db, id);
      if (!workflow.activeProposalVersion) return 0;
      const proposal = await activeProposal(db, id, workflow.activeProposalVersion);
      if (
        Date.parse(proposal.expiresAt) > now.getTime() &&
        (task.state === "ready_to_execute" ||
          Date.parse(workflow.callbackWindow.endsAt) > now.getTime())
      )
        return 0;
      await cancelActions(db, id);
      delete workflow.activeProposalVersion;
      delete workflow.callbackDelivered;
      await saveWorkflow(db, id, workflow);
      await saveTaskEvent(
        db,
        {
          ...task,
          state: "awaiting_proposal",
          nextAction:
            "The proposal or callback window expired. Update the window and obtain new decisions.",
        },
        "backend-worker",
        "request_window_expired",
        `proposal:${proposal.id}:v${proposal.version}`,
        now,
      );
      return 1;
    });
  }
  return expired;
}

export async function runWorkerOnce(
  pool: Pool,
  options: { scheduler?: Scheduler; now?: () => Date } = {},
) {
  const now = options.now ?? (() => new Date());
  const scheduler = options.scheduler ?? new MockScheduler(pool, { now });
  const expired = await expirePendingTasks(pool, now());
  const delivery = await dispatchDueJobs(pool, { now, limit: 100 });
  const operations = await new BookingExecutor(pool, { scheduler, now }).recover(100);
  const calls = await runVoiceWorker(pool, { now });
  await new VoiceSms(pool, { now }).reconcileStale();
  return { expired, delivery, operations, calls };
}

async function main() {
  const pool = createPool();
  const once = process.argv.includes("--once");
  const interval = Number(process.env.WORKER_INTERVAL_MS ?? 1000);
  if (!Number.isInteger(interval) || interval < 100 || interval > 60_000)
    throw new Error("WORKER_INTERVAL_MS must be between 100 and 60000.");
  let stopped = false;
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      stopped = true;
    });
  console.log("Synthetic backend worker started.");
  try {
    do {
      try {
        const result = await runWorkerOnce(pool);
        if (
          once ||
          result.expired ||
          result.operations.length ||
          result.calls.length ||
          Object.values(result.delivery).some(Boolean)
        )
          console.log(
            JSON.stringify({
              service: "prc-worker",
              expired: result.expired,
              delivery: result.delivery,
              operations: result.operations.length,
              calls: result.calls.length,
              errors: result.operations.filter((item) => item.status === "error").length,
            }),
          );
      } catch {
        console.error("Backend worker iteration failed; check database readiness.");
        if (once) {
          process.exitCode = 1;
          break;
        }
      }
      if (!once && !stopped) await setTimeout(interval);
    } while (!once && !stopped);
  } finally {
    await pool.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
