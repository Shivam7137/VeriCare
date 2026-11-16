import { randomUUID } from "node:crypto";
import {
  callbackInputSchema,
  createTaskInputSchema,
  decisionInputSchema,
  proposeInputSchema,
  proposalDraftSchema,
  revisionInputSchema,
  stopInputSchema,
  taskSchema,
  type CreateTaskInput,
  type DecisionInput,
  type ProposeInput,
  type Task,
} from "@prc/contracts";
import type { Pool } from "pg";
import {
  BackendError,
  lockTask,
  readWorkflow,
  saveTaskEvent,
  saveWorkflow,
  transaction,
  type Database,
  type WorkflowRecord,
} from "./domain.js";
import { getPrincipal, requirePatientAccess, requireStaff, type Principal } from "./identity.js";
import { cancelPendingCommunications, enqueueCommunication } from "./delivery.js";
import type { Scheduler } from "./scheduler.js";

export type BackendOptions = { scheduler: Scheduler; now?: () => Date; autoPropose?: boolean };
// Not a principal: the scheduling agent has no session, so it can never approve or confirm.
export const SCHEDULING_AGENT_ID = "scheduling-agent";
const mutableStates = new Set([
  "awaiting_proposal",
  "awaiting_staff_approval",
  "awaiting_patient_confirmation",
  "ready_to_execute",
]);

export async function activeProposal(db: Database, taskId: string, version?: number) {
  const result = await db.query(
    "SELECT payload FROM proposal_drafts WHERE task_id = $1 AND version = $2",
    [taskId, version ?? 0],
  );
  if (!result.rows[0]) throw new BackendError("proposal_required");
  return proposalDraftSchema.parse(result.rows[0].payload);
}

export async function cancelActions(db: Database, taskId: string, invalidateApproved = true) {
  await db.query(
    "UPDATE action_requests SET status = 'cancelled' WHERE task_id = $1 AND status = ANY($2::text[])",
    [taskId, invalidateApproved ? ["pending", "approved"] : ["pending"]],
  );
  await cancelPendingCommunications(db, taskId);
}

export class WorkflowService {
  readonly now: () => Date;
  readonly autoPropose: boolean;
  constructor(
    readonly pool: Pool,
    readonly options: BackendOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.autoPropose = options.autoPropose ?? false;
  }

  private async requester(db: Database, actor: Principal, task: Task) {
    const current = await getPrincipal(db, actor.id);
    if (current.role !== "patient" || current.id !== task.requesterId)
      throw new BackendError("forbidden", 403);
  }

  private async mutate(
    actor: Principal,
    taskId: string,
    expectedRevision: number,
    work: (db: Database, task: Task, workflow: WorkflowRecord, now: Date) => Promise<Task>,
  ) {
    return transaction(this.pool, async (db) => {
      const task = await lockTask(db, taskId);
      const now = this.now();
      await requirePatientAccess(db, actor, task.patientId, now);
      if (task.revision !== expectedRevision) throw new BackendError("revision_conflict");
      return work(db, task, await readWorkflow(db, task.id), now);
    });
  }

  async create(actor: Principal, raw: CreateTaskInput) {
    const input = createTaskInputSchema.parse(raw);
    return transaction(this.pool, async (db) => {
      const now = this.now();
      await requirePatientAccess(db, actor, input.patientId, now);
      const principal = await getPrincipal(db, actor.id);
      if (principal.role !== "patient") throw new BackendError("requester_required", 403);
      const patient = (
        await db.query("SELECT department_id FROM patients WHERE id = $1", [input.patientId])
      ).rows[0];
      if (patient.department_id !== "demo-department")
        throw new BackendError("department_not_configured");
      const booking = await this.options.scheduler.getBooking(input.appointmentId, db);
      if (
        !booking ||
        booking.patientId !== input.patientId ||
        booking.departmentId !== patient.department_id
      )
        throw new BackendError("not_found", 404);
      if (
        Date.parse(input.availability.startsAt) <= now.getTime() ||
        Date.parse(input.callbackWindow.endsAt) <= now.getTime() ||
        Date.parse(input.callbackWindow.endsAt) > Date.parse(input.availability.startsAt)
      )
        throw new BackendError("invalid_windows", 400);
      const task = taskSchema.parse({
        id: `T-${randomUUID()}`,
        patientId: input.patientId,
        requesterId: actor.id,
        departmentId: patient.department_id,
        owner: "demo-staff-queue",
        state: "awaiting_verification",
        revision: 0,
        summary: input.summary,
        nextAction: "Verify access to this rescheduling request.",
        synthetic: true,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      });
      const workflow: WorkflowRecord = {
        appointmentId: input.appointmentId,
        availability: input.availability,
        callbackWindow: input.callbackWindow,
        requireStaffApproval: true,
      };
      await db.query("INSERT INTO tasks (id, payload) VALUES ($1, $2)", [task.id, task]);
      await db.query("INSERT INTO workflow_tasks (task_id, payload) VALUES ($1, $2)", [
        task.id,
        workflow,
      ]);
      await db.query(
        "INSERT INTO task_events (id,task_id,actor_id,action,occurred_at,evidence_ref) VALUES ($1,$2,$3,'request_created',$4,$5)",
        [randomUUID(), task.id, actor.id, now, `request:${task.id}`],
      );
      return task;
    });
  }

  async verify(actor: Principal, taskId: string, raw: { expectedRevision: number }) {
    const input = revisionInputSchema.parse(raw);
    return this.mutate(actor, taskId, input.expectedRevision, async (db, task, workflow, now) => {
      await this.requester(db, actor, task);
      if (task.state !== "awaiting_verification") throw new BackendError("invalid_transition");
      const booking = await this.options.scheduler.getBooking(workflow.appointmentId, db);
      if (
        !booking ||
        booking.patientId !== task.patientId ||
        booking.departmentId !== task.departmentId
      )
        throw new BackendError("not_found", 404);
      const verified = await saveTaskEvent(
        db,
        {
          ...task,
          state: "awaiting_proposal",
          nextAction: "Staff can propose a slot within the requested availability.",
        },
        actor.id,
        "access_verified",
        `identity:${actor.id}`,
        now,
      );
      return this.autoPropose ? this.agentPropose(db, verified, workflow, now) : verified;
    });
  }

  // The agent may only offer the earliest open slot inside the requested availability.
  // Staff approval and requester confirmation are still required before any booking change.
  private async agentPropose(db: Database, task: Task, workflow: WorkflowRecord, now: Date) {
    if (Date.parse(workflow.callbackWindow.endsAt) <= now.getTime() + 1000) return task;
    const slot = (await this.options.scheduler.listSlots(task.departmentId)).find(
      (item) =>
        item.available &&
        Date.parse(item.startsAt) >= Date.parse(workflow.availability.startsAt) &&
        Date.parse(item.endsAt) <= Date.parse(workflow.availability.endsAt),
    );
    if (!slot) return task;
    try {
      // One millisecond later keeps the agent's event after access_verified in the history.
      return await this.activate(db, task, workflow, new Date(now.getTime() + 1), {
        actorId: SCHEDULING_AGENT_ID,
        slotId: slot.id,
        expiresAt: workflow.callbackWindow.endsAt,
      });
    } catch (error) {
      // activate() rejects before it writes, so staff can still propose by hand.
      if (error instanceof BackendError) return task;
      throw error;
    }
  }

  async propose(actor: Principal, taskId: string, raw: ProposeInput) {
    const input = proposeInputSchema.parse(raw);
    return this.mutate(actor, taskId, input.expectedRevision, async (db, task, workflow, now) => {
      await requireStaff(db, actor, task.departmentId);
      if (!mutableStates.has(task.state)) throw new BackendError("invalid_transition");
      return this.activate(db, task, workflow, now, {
        actorId: actor.id,
        slotId: input.slotId,
        expiresAt: input.expiresAt,
      });
    });
  }

  private async activate(
    db: Database,
    task: Task,
    workflow: WorkflowRecord,
    now: Date,
    input: { actorId: string; slotId: string; expiresAt: string },
  ) {
    {
      const slot = await this.options.scheduler.getSlot(input.slotId, db);
      const booking = await this.options.scheduler.getBooking(workflow.appointmentId, db);
      if (
        !slot ||
        !booking ||
        slot.departmentId !== task.departmentId ||
        booking.patientId !== task.patientId ||
        !slot.available
      )
        throw new BackendError("slot_unavailable");
      if (
        Date.parse(slot.startsAt) < Date.parse(workflow.availability.startsAt) ||
        Date.parse(slot.endsAt) > Date.parse(workflow.availability.endsAt)
      )
        throw new BackendError("outside_availability");
      if (
        Date.parse(workflow.callbackWindow.endsAt) <= now.getTime() ||
        Date.parse(input.expiresAt) <=
          Math.max(now.getTime(), Date.parse(workflow.callbackWindow.startsAt))
      )
        throw new BackendError("callback_window_unavailable");
      const version = (
        await db.query(
          "SELECT COALESCE(MAX(version),0)+1 AS version FROM proposal_drafts WHERE task_id = $1",
          [task.id],
        )
      ).rows[0].version;
      const proposal = proposalDraftSchema.parse({
        id: randomUUID(),
        taskId: task.id,
        version,
        status: "draft",
        appointmentId: workflow.appointmentId,
        slotId: slot.id,
        expectedBookingVersion: booking.version,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        expiresAt: input.expiresAt,
        createdAt: now.toISOString(),
        createdBy: input.actorId,
      });
      await cancelActions(db, task.id);
      await db.query(
        "INSERT INTO proposal_drafts (id, task_id, version, payload) VALUES ($1,$2,$3,$4)",
        [proposal.id, task.id, version, proposal],
      );
      workflow.activeProposalVersion = version;
      delete workflow.callbackDelivered;
      delete workflow.operationId;
      await saveWorkflow(db, task.id, workflow);
      for (const kind of ["staff_approval", "patient_confirmation"]) {
        await db.query(
          "INSERT INTO action_requests (id,task_id,proposal_version,kind,assignee_id,status,expires_at) VALUES ($1,$2,$3,$4,$5,'pending',$6)",
          [
            randomUUID(),
            task.id,
            version,
            kind,
            kind === "staff_approval" ? task.departmentId : task.requesterId,
            input.expiresAt,
          ],
        );
      }
      return saveTaskEvent(
        db,
        {
          ...task,
          state: "awaiting_staff_approval",
          nextAction: `Staff must approve proposal version ${version}.`,
        },
        input.actorId,
        "proposal_activated",
        `proposal:${proposal.id}:v${version}`,
        now,
      );
    }
  }

  async decide(
    actor: Principal,
    taskId: string,
    kind: "staff_approval" | "patient_confirmation",
    raw: DecisionInput,
  ) {
    const input = decisionInputSchema.parse(raw);
    return this.mutate(actor, taskId, input.expectedRevision, async (db, task, workflow, now) => {
      if (workflow.activeProposalVersion !== input.proposalVersion)
        throw new BackendError("proposal_version_conflict");
      const proposal = await activeProposal(db, task.id, input.proposalVersion);
      if (Date.parse(proposal.expiresAt) <= now.getTime())
        throw new BackendError("proposal_expired");
      if (kind === "staff_approval") {
        await requireStaff(db, actor, task.departmentId);
        if (task.state !== "awaiting_staff_approval") throw new BackendError("invalid_transition");
      } else {
        await this.requester(db, actor, task);
        if (task.state !== "awaiting_patient_confirmation")
          throw new BackendError("invalid_transition");
        if (
          input.response === "approve" &&
          (workflow.callbackDelivered?.version !== input.proposalVersion ||
            now.getTime() < Date.parse(workflow.callbackWindow.startsAt) ||
            now.getTime() >= Date.parse(workflow.callbackWindow.endsAt))
        )
          throw new BackendError("callback_required");
      }
      const result = await db.query(
        "UPDATE action_requests SET status=$4, responded_by=$5, responded_at=$6,evidence_ref=$7 WHERE task_id=$1 AND proposal_version=$2 AND kind=$3 AND status='pending' AND expires_at > $6 RETURNING id",
        [
          task.id,
          input.proposalVersion,
          kind,
          input.response === "approve" ? "approved" : "rejected",
          actor.id,
          now,
          input.evidenceRef,
        ],
      );
      if (result.rowCount !== 1) throw new BackendError("action_not_pending");
      let state: Task["state"];
      let nextAction: string;
      if (input.response === "reject") {
        await cancelActions(db, task.id);
        delete workflow.activeProposalVersion;
        delete workflow.callbackDelivered;
        state = "awaiting_proposal";
        nextAction = "Prepare a new proposal after the rejected decision.";
      } else if (kind === "staff_approval") {
        state = "awaiting_patient_confirmation";
        nextAction = "Deliver the agreed callback, then obtain requester confirmation.";
        const expiresAt = new Date(
          Math.min(Date.parse(proposal.expiresAt), Date.parse(workflow.callbackWindow.endsAt)),
        ).toISOString();
        await enqueueCommunication(db, {
          taskId: task.id,
          proposalVersion: input.proposalVersion,
          kind: "callback",
          recipientId: task.requesterId,
          dueAt: workflow.callbackWindow.startsAt,
          expiresAt,
        });
        const reminderAt =
          Math.max(Date.parse(workflow.callbackWindow.startsAt), now.getTime()) + 300_000;
        if (reminderAt < Date.parse(expiresAt))
          await enqueueCommunication(db, {
            taskId: task.id,
            proposalVersion: input.proposalVersion,
            kind: "reminder",
            recipientId: task.requesterId,
            dueAt: new Date(reminderAt).toISOString(),
            expiresAt,
          });
      } else {
        await cancelPendingCommunications(db, task.id);
        state = "ready_to_execute";
        nextAction = "Backend will recheck the booking and execute this exact proposal.";
      }
      await saveWorkflow(db, task.id, workflow);
      return saveTaskEvent(
        db,
        { ...task, state, nextAction },
        actor.id,
        `${kind}_${input.response === "approve" ? "approved" : "rejected"}`,
        input.evidenceRef,
        now,
      );
    });
  }

  async callback(actor: Principal, taskId: string, raw: unknown) {
    const input = callbackInputSchema.parse(raw);
    return this.mutate(actor, taskId, input.expectedRevision, async (db, task, workflow, now) => {
      await this.requester(db, actor, task);
      if (![...mutableStates, "awaiting_verification"].includes(task.state))
        throw new BackendError("invalid_transition");
      if (
        Date.parse(input.callbackWindow.endsAt) <= now.getTime() ||
        Date.parse(input.callbackWindow.endsAt) > Date.parse(workflow.availability.startsAt)
      )
        throw new BackendError("invalid_windows", 400);
      await cancelActions(db, task.id);
      workflow.callbackWindow = input.callbackWindow;
      delete workflow.activeProposalVersion;
      delete workflow.callbackDelivered;
      await saveWorkflow(db, task.id, workflow);
      return saveTaskEvent(
        db,
        {
          ...task,
          state: task.state === "awaiting_verification" ? task.state : "awaiting_proposal",
          nextAction: "The callback window changed; prepare a new proposal and decisions.",
        },
        actor.id,
        "callback_window_changed",
        `callback:${task.id}`,
        now,
      );
    });
  }

  private async stop(actor: Principal, taskId: string, raw: unknown, takeover: boolean) {
    const input = stopInputSchema.parse(raw);
    return this.mutate(actor, taskId, input.expectedRevision, async (db, task, workflow, now) => {
      if (takeover) await requireStaff(db, actor, task.departmentId);
      else {
        const principal = await getPrincipal(db, actor.id);
        if (
          principal.role !== "patient" ||
          (principal.id !== task.requesterId && principal.patientId !== task.patientId)
        )
          throw new BackendError("forbidden", 403);
      }
      if (["completed", "withdrawn", "staff_takeover"].includes(task.state))
        throw new BackendError("invalid_transition");
      await cancelActions(db, task.id);
      workflow[takeover ? "takeoverRequested" : "withdrawalRequested"] = true;
      const operation = workflow.operationId
        ? (
            await db.query("SELECT status FROM booking_operations WHERE id=$1 FOR UPDATE", [
              workflow.operationId,
            ])
          ).rows[0]
        : null;
      const inFlight = operation && ["dispatched", "reconciling"].includes(operation.status);
      if (operation?.status === "prepared")
        await db.query(
          "UPDATE booking_operations SET status='cancelled',updated_at=$2,last_error='request_stopped' WHERE id=$1",
          [workflow.operationId, now],
        );
      await saveWorkflow(db, task.id, workflow);
      return saveTaskEvent(
        db,
        {
          ...task,
          state: inFlight ? "reconciling" : takeover ? "staff_takeover" : "withdrawn",
          owner: takeover ? actor.id : task.owner,
          nextAction: inFlight
            ? "Reconcile the in-flight operation before any further booking action."
            : takeover
              ? "Staff owns further actions; automated work is stopped."
              : "Request withdrawn; pending work is cancelled.",
        },
        actor.id,
        takeover ? "staff_takeover_requested" : "withdrawal_requested",
        input.evidenceRef,
        now,
      );
    });
  }
  withdraw(actor: Principal, taskId: string, raw: unknown) {
    return this.stop(actor, taskId, raw, false);
  }
  takeover(actor: Principal, taskId: string, raw: unknown) {
    return this.stop(actor, taskId, raw, true);
  }

  async callEnded(actor: Principal, taskId: string, evidenceRef: string) {
    return transaction(this.pool, async (db) => {
      const task = await lockTask(db, taskId);
      await requirePatientAccess(db, actor, task.patientId, this.now());
      await this.requester(db, actor, task);
      return saveTaskEvent(db, task, actor.id, "call_ended", evidenceRef, this.now());
    });
  }

  async progress(actor: Principal, taskId: string) {
    return transaction(this.pool, async (db) => {
      const task = await lockTask(db, taskId);
      await requirePatientAccess(db, actor, task.patientId, this.now());
      const workflow: WorkflowRecord | null =
        (await db.query("SELECT payload FROM workflow_tasks WHERE task_id=$1", [taskId])).rows[0]
          ?.payload ?? null;
      const proposals = (
        await db.query("SELECT payload FROM proposal_drafts WHERE task_id=$1 ORDER BY version", [
          taskId,
        ])
      ).rows.map((row) => proposalDraftSchema.parse(row.payload));
      const actions = (
        await db.query(
          `SELECT id,proposal_version AS "proposalVersion",kind,assignee_id AS "assigneeId",status,expires_at AS "expiresAt",responded_by AS "respondedBy",responded_at AS "respondedAt",evidence_ref AS "evidenceRef" FROM action_requests WHERE task_id=$1 ORDER BY proposal_version,kind`,
          [taskId],
        )
      ).rows;
      const events = (
        await db.query(
          `SELECT e.id,e.actor_id AS "actorId",
           COALESCE(p.display_name, CASE WHEN e.actor_id='${SCHEDULING_AGENT_ID}' THEN 'Scheduling agent' END) AS "actorDisplayName",e.action,
           e.occurred_at AS "occurredAt",e.evidence_ref AS "evidenceRef"
           FROM task_events e LEFT JOIN principals p ON p.id=e.actor_id
           WHERE e.task_id=$1 ORDER BY e.occurred_at,e.seq`,
          [taskId],
        )
      ).rows;
      const operations = (
        await db.query(
          `SELECT id,operation_key AS "operationKey",proposal_version AS "proposalVersion",status,result,attempts,last_error AS "lastError" FROM booking_operations WHERE task_id=$1 ORDER BY created_at,id`,
          [taskId],
        )
      ).rows;
      const jobs = (
        await db.query(
          `SELECT id,proposal_version AS "proposalVersion",kind,status,recipient_id AS "recipientId",due_at AS "dueAt",expires_at AS "expiresAt",attempts,last_error AS "lastError",delivered_at AS "deliveredAt" FROM communication_jobs WHERE task_id=$1 ORDER BY due_at,id`,
          [taskId],
        )
      ).rows;
      return {
        task,
        patient:
          (
            await db.query('SELECT id,display_name AS "displayName" FROM patients WHERE id=$1', [
              task.patientId,
            ])
          ).rows[0] ?? null,
        booking: workflow
          ? await this.options.scheduler.getBooking(workflow.appointmentId, db)
          : null,
        workflow,
        proposals,
        activeProposal:
          proposals.find((item) => item.version === workflow?.activeProposalVersion) ?? null,
        actions,
        events,
        operations,
        operation: operations.find((item) => item.id === workflow?.operationId) ?? null,
        jobs,
      };
    });
  }

  async list(actor: Principal) {
    const principal = await getPrincipal(this.pool, actor.id);
    if (!principal.active || !principal.verified) throw new BackendError("unauthorized", 401);
    const candidates = (
      await this.pool.query(
        "SELECT id FROM tasks WHERE payload->>'departmentId' = $1 OR payload->>'requesterId' = $2 OR payload->>'patientId' = $3 OR payload->>'patientId' IN (SELECT patient_id FROM authority_grants WHERE requester_id=$2 AND revoked_at IS NULL AND expires_at>$4) ORDER BY payload->>'updatedAt' DESC LIMIT 200",
        [
          principal.role === "patient" ? null : principal.departmentId,
          principal.id,
          principal.patientId,
          this.now(),
        ],
      )
    ).rows;
    const items = [];
    for (const row of candidates) {
      try {
        items.push(await this.progress(principal, row.id));
      } catch (error) {
        if (!(error instanceof BackendError && error.statusCode === 404)) throw error;
      }
    }
    return items;
  }
}
