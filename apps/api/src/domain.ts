import { randomUUID } from "node:crypto";
import { taskSchema, type Task } from "@prc/contracts";
import type { Pool, PoolClient } from "pg";

export type Database = Pick<Pool, "query">;

export class BackendError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode = 409,
  ) {
    super(code);
    this.name = "BackendError";
  }
}

export type TimeWindow = { startsAt: string; endsAt: string; timeZone: string };
export type WorkflowRecord = {
  appointmentId: string;
  availability: TimeWindow;
  callbackWindow: TimeWindow;
  requireStaffApproval: boolean;
  activeProposalVersion?: number;
  callbackDelivered?: { version: number; at: string };
  operationId?: string;
  takeoverRequested?: boolean;
  withdrawalRequested?: boolean;
};

export async function transaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function lockTask(client: Database, taskId: string) {
  const result = await client.query("SELECT payload FROM tasks WHERE id = $1 FOR UPDATE", [taskId]);
  if (!result.rows[0]) throw new BackendError("not_found", 404);
  return taskSchema.parse(result.rows[0].payload);
}

export async function saveTaskEvent(
  client: Database,
  task: Task,
  actorId: string,
  action: string,
  evidenceRef: string,
  now: Date,
) {
  const updated = taskSchema.parse({
    ...task,
    revision: task.revision + 1,
    updatedAt: now.toISOString(),
  });
  await client.query("UPDATE tasks SET payload = $2 WHERE id = $1", [task.id, updated]);
  await client.query(
    `INSERT INTO task_events (id, task_id, actor_id, action, occurred_at, evidence_ref) VALUES ($1,$2,$3,$4,$5,$6)`,
    [randomUUID(), task.id, actorId, action, now, evidenceRef],
  );
  return updated;
}

export async function readWorkflow(client: Database, taskId: string): Promise<WorkflowRecord> {
  const result = await client.query("SELECT payload FROM workflow_tasks WHERE task_id = $1", [
    taskId,
  ]);
  if (!result.rows[0]) throw new BackendError("workflow_not_initialized", 409);
  return result.rows[0].payload;
}

export async function saveWorkflow(client: Database, taskId: string, workflow: WorkflowRecord) {
  await client.query("UPDATE workflow_tasks SET payload = $2 WHERE task_id = $1", [
    taskId,
    workflow,
  ]);
}
