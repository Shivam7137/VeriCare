import { randomUUID } from "node:crypto";
import { taskSchema, type Task } from "@prc/contracts";
import type { Pool } from "pg";
import {
  BackendError,
  readWorkflow,
  saveTaskEvent,
  saveWorkflow,
  transaction,
  type Database,
  type WorkflowRecord,
} from "./domain.js";
import { canAccessPatient, getPrincipal } from "./identity.js";

export type CommunicationJob = {
  id: string;
  taskId: string;
  proposalVersion: number;
  kind: "callback" | "reminder";
  recipientId: string;
  dueAt: string;
  expiresAt: string;
  status: "pending" | "delivered" | "cancelled" | "failed";
  attempts: number;
  lastError: string | null;
  deliveredAt: string | null;
};

type JobRow = {
  id: string;
  task_id: string;
  proposal_version: number;
  kind: CommunicationJob["kind"];
  recipient_id: string;
  due_at: Date;
  expires_at: Date;
  status: CommunicationJob["status"];
  attempts: number;
  last_error: string | null;
  delivered_at: Date | null;
};

function toJob(row: JobRow): CommunicationJob {
  return {
    id: row.id,
    taskId: row.task_id,
    proposalVersion: row.proposal_version,
    kind: row.kind,
    recipientId: row.recipient_id,
    dueAt: row.due_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error,
    deliveredAt: row.delivered_at?.toISOString() ?? null,
  };
}

export async function enqueueCommunication(
  client: Database,
  input: Pick<
    CommunicationJob,
    "taskId" | "proposalVersion" | "kind" | "recipientId" | "dueAt" | "expiresAt"
  >,
): Promise<CommunicationJob> {
  if (
    !input.taskId ||
    !input.recipientId ||
    !Number.isInteger(input.proposalVersion) ||
    input.proposalVersion < 1 ||
    !["callback", "reminder"].includes(input.kind) ||
    !Number.isFinite(Date.parse(input.dueAt)) ||
    !(Date.parse(input.expiresAt) > Date.parse(input.dueAt))
  ) {
    throw new BackendError("invalid_communication_job", 400);
  }
  // A repeated enqueue returns the original job without reviving or rescheduling it.
  const result = await client.query<JobRow>(
    `INSERT INTO communication_jobs
       (id, task_id, proposal_version, kind, recipient_id, due_at, expires_at, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
     ON CONFLICT (task_id, proposal_version, kind)
     DO UPDATE SET task_id = communication_jobs.task_id
     RETURNING *`,
    [
      randomUUID(),
      input.taskId,
      input.proposalVersion,
      input.kind,
      input.recipientId,
      input.dueAt,
      input.expiresAt,
    ],
  );
  return toJob(result.rows[0]!);
}

export async function cancelPendingCommunications(client: Database, taskId: string): Promise<void> {
  await client.query(
    `UPDATE communication_jobs SET status = 'cancelled', last_error = 'task_cancelled'
     WHERE task_id = $1 AND status = 'pending'`,
    [taskId],
  );
}

type Eligibility =
  { reason: string } | { deferUntil: string } | { workflow: WorkflowRecord; expiresAt: number };

async function eligibility(
  client: Database,
  task: Task,
  job: CommunicationJob,
  now: Date,
): Promise<Eligibility> {
  if (task.state !== "awaiting_patient_confirmation")
    return { reason: "task_not_awaiting_confirmation" };
  if (job.recipientId !== task.requesterId) return { reason: "recipient_changed" };
  if (Date.parse(job.expiresAt) <= now.getTime()) return { reason: "job_expired" };
  let workflow: WorkflowRecord;
  try {
    workflow = await readWorkflow(client, task.id);
  } catch (error) {
    if (error instanceof BackendError && error.code === "workflow_not_initialized") {
      return { reason: "workflow_not_initialized" };
    }
    throw error;
  }
  if (workflow.withdrawalRequested) return { reason: "withdrawal_requested" };
  if (workflow.takeoverRequested) return { reason: "takeover_requested" };
  if (workflow.activeProposalVersion !== job.proposalVersion) return { reason: "proposal_changed" };
  if (job.kind === "callback" && workflow.callbackDelivered?.version === job.proposalVersion) {
    return { reason: "callback_already_delivered" };
  }
  const proposal = await client.query(
    "SELECT payload FROM proposal_drafts WHERE task_id = $1 AND version = $2",
    [task.id, job.proposalVersion],
  );
  const proposalExpiry = Date.parse(proposal.rows[0]?.payload.expiresAt);
  if (!(proposalExpiry > now.getTime())) return { reason: "proposal_expired_or_missing" };
  const actions = await client.query(
    `SELECT * FROM action_requests
     WHERE task_id = $1 AND proposal_version = $2 AND kind = 'patient_confirmation'`,
    [task.id, job.proposalVersion],
  );
  const action = actions.rows[0];
  if (!action || action.status !== "pending" || action.assignee_id !== job.recipientId) {
    return { reason: "confirmation_not_pending" };
  }
  if (action.expires_at.getTime() <= now.getTime()) return { reason: "confirmation_expired" };

  // Keep authority valid until this transaction records the fake receipt. Revocations
  // lock these same rows through UPDATE; a later worker always reads current state.
  await client.query("SELECT id FROM principals WHERE id = $1 FOR SHARE", [job.recipientId]);
  await client.query(
    "SELECT id FROM authority_grants WHERE patient_id = $1 AND requester_id = $2 FOR SHARE",
    [task.patientId, job.recipientId],
  );
  try {
    const principal = await getPrincipal(client, job.recipientId);
    if (!(await canAccessPatient(client, principal, task.patientId, now))) {
      return { reason: "recipient_not_authorized" };
    }
  } catch (error) {
    if (error instanceof BackendError && error.code === "not_found") {
      return { reason: "recipient_not_authorized" };
    }
    throw error;
  }
  const windowStartsAt = Date.parse(workflow.callbackWindow.startsAt);
  const windowEndsAt = Date.parse(workflow.callbackWindow.endsAt);
  if (!Number.isFinite(windowStartsAt) || !(windowEndsAt > now.getTime())) {
    return { reason: "callback_window_expired" };
  }
  const expiresAt = Math.min(
    Date.parse(job.expiresAt),
    proposalExpiry,
    action.expires_at.getTime(),
    windowEndsAt,
  );
  if (windowStartsAt >= expiresAt) return { reason: "callback_window_unavailable" };
  if (windowStartsAt > now.getTime()) return { deferUntil: new Date(windowStartsAt).toISOString() };
  return { workflow, expiresAt };
}

type DispatchResult = { delivered: number; cancelled: number; failed: number; retried: number };
type Outcome = keyof DispatchResult | undefined;

async function persistEligibility(
  client: Database,
  job: CommunicationJob,
  eligible: Eligibility,
): Promise<"cancelled" | undefined> {
  if ("reason" in eligible) {
    await client.query(
      "UPDATE communication_jobs SET status = 'cancelled', last_error = $2 WHERE id = $1",
      [job.id, eligible.reason],
    );
    return "cancelled";
  }
  if ("deferUntil" in eligible) {
    await client.query("UPDATE communication_jobs SET due_at = $2 WHERE id = $1", [
      job.id,
      eligible.deferUntil,
    ]);
  }
  return undefined;
}

export async function dispatchDueJobs(
  pool: Pool,
  options: {
    now?: Date | (() => Date);
    limit?: number;
    beforeDelivery?: (job: CommunicationJob) => Promise<void>;
  } = {},
): Promise<DispatchResult> {
  const clock = () => {
    const now = typeof options.now === "function" ? options.now() : (options.now ?? new Date());
    return new Date(now.getTime());
  };
  const limit = options.limit ?? 50;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 1_000 ||
    !Number.isFinite(clock().getTime())
  ) {
    throw new BackendError("invalid_dispatch_options", 400);
  }
  const result: DispatchResult = { delivered: 0, cancelled: 0, failed: 0, retried: 0 };
  const candidates = await pool.query<{ id: string; task_id: string }>(
    `SELECT id, task_id FROM communication_jobs
     WHERE status = 'pending' AND due_at <= $1 ORDER BY due_at, id LIMIT $2`,
    [clock(), limit],
  );
  for (const candidate of candidates.rows) {
    const outcome = await transaction<Outcome>(pool, async (client) => {
      // Workflow commands also lock the task before its jobs. SKIP LOCKED lets
      // concurrent workers make progress without waiting or reversing that order.
      const tasks = await client.query(
        "SELECT payload FROM tasks WHERE id = $1 FOR UPDATE SKIP LOCKED",
        [candidate.task_id],
      );
      if (!tasks.rows[0]) return;
      const task = taskSchema.parse(tasks.rows[0].payload);
      const jobs = await client.query<JobRow>(
        "SELECT * FROM communication_jobs WHERE id = $1 FOR UPDATE SKIP LOCKED",
        [candidate.id],
      );
      if (!jobs.rows[0]) return;
      const job = toJob(jobs.rows[0]);
      if (job.status !== "pending" || Date.parse(job.dueAt) > clock().getTime()) return;
      let eligible = await eligibility(client, task, job, clock());
      if (!("workflow" in eligible)) return persistEligibility(client, job, eligible);

      try {
        // Internal fault injection only: the synthetic transport has no network I/O.
        await options.beforeDelivery?.({ ...job });
      } catch {
        const attempts = job.attempts + 1;
        const retryAt = new Date(clock().getTime() + 1_000 * 2 ** (attempts - 1));
        const retry = attempts < 3 && retryAt.getTime() < eligible.expiresAt;
        await client.query(
          `UPDATE communication_jobs SET status = $2, attempts = $3,
             last_error = 'delivery_failed', due_at = $4 WHERE id = $1`,
          [job.id, retry ? "pending" : "failed", attempts, retry ? retryAt : job.dueAt],
        );
        return retry ? "retried" : "failed";
      }

      // Recheck the clock after an injected delay and before recording any delivery.
      const deliveredAt = clock();
      eligible = await eligibility(client, task, job, deliveredAt);
      if (!("workflow" in eligible)) return persistEligibility(client, job, eligible);
      const receiptRef = `mock-delivery:${job.id}`;
      await client.query(
        `INSERT INTO mock_deliveries (job_id, recipient_id, delivered_at, receipt_ref)
         VALUES ($1, $2, $3, $4)`,
        [job.id, job.recipientId, deliveredAt, receiptRef],
      );
      await client.query(
        `UPDATE communication_jobs SET status = 'delivered', delivered_at = $2,
           attempts = attempts + 1, last_error = NULL WHERE id = $1`,
        [job.id, deliveredAt],
      );
      if (job.kind === "callback") {
        eligible.workflow.callbackDelivered = {
          version: job.proposalVersion,
          at: deliveredAt.toISOString(),
        };
        await saveWorkflow(client, task.id, eligible.workflow);
      }
      await saveTaskEvent(
        client,
        task,
        "delivery-worker",
        `${job.kind}_delivered`,
        receiptRef,
        deliveredAt,
      );
      return "delivered";
    });
    if (outcome) result[outcome] += 1;
  }
  return result;
}
