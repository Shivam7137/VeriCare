import { randomUUID } from "node:crypto";
import {
  proposalDraftSchema,
  saveProposalDraftInputSchema,
  taskEventSchema,
  taskSchema,
  type SaveProposalDraftInput,
} from "@prc/contracts";
import type { Pool } from "pg";

export class ProposalDraftError extends Error {
  constructor(
    public readonly code: "task_not_found" | "revision_conflict" | "task_not_open_for_proposals",
  ) {
    super(code);
    this.name = "ProposalDraftError";
  }
}

// Internal persistence boundary. Future callers must authorize the actor/task first.
// Saving a draft never records approval, changes workflow state, or executes a booking.
export async function saveProposalDraft(pool: Pool, input: SaveProposalDraftInput) {
  const { taskId, expectedRevision, actorId, ...change } =
    saveProposalDraftInputSchema.parse(input);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query("SELECT payload FROM tasks WHERE id = $1 FOR UPDATE", [
      taskId,
    ]);
    if (!result.rows[0]) throw new ProposalDraftError("task_not_found");
    const current = taskSchema.parse(result.rows[0].payload);
    if (current.revision !== expectedRevision) throw new ProposalDraftError("revision_conflict");
    if (current.state !== "awaiting_proposal") {
      throw new ProposalDraftError("task_not_open_for_proposals");
    }

    // The task lock serializes version allocation and revision checks for this task.
    const versions = await client.query(
      "SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM proposal_drafts WHERE task_id = $1",
      [taskId],
    );
    const now = new Date().toISOString();
    const proposal = proposalDraftSchema.parse({
      ...change,
      id: randomUUID(),
      taskId,
      version: versions.rows[0].next_version,
      status: "draft",
      createdAt: now,
      createdBy: actorId,
    });
    const task = taskSchema.parse({ ...current, revision: current.revision + 1, updatedAt: now });
    const event = taskEventSchema.parse({
      id: randomUUID(),
      taskId,
      actorId,
      action: "proposal_drafted",
      occurredAt: now,
      evidenceRef: `proposal:${proposal.id}:v${proposal.version}`,
    });
    await client.query(
      "INSERT INTO proposal_drafts (id, task_id, version, payload) VALUES ($1, $2, $3, $4)",
      [proposal.id, taskId, proposal.version, proposal],
    );
    await client.query("UPDATE tasks SET payload = $2 WHERE id = $1", [taskId, task]);
    await client.query(
      `INSERT INTO task_events (id, task_id, actor_id, action, occurred_at, evidence_ref)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [event.id, taskId, actorId, event.action, now, event.evidenceRef],
    );
    await client.query("COMMIT");
    return { task, proposal, event };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
