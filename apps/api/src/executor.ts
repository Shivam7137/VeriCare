import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { Task } from "@prc/contracts";
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
import { activeProposal, cancelActions, type BackendOptions } from "./workflow.js";
import type { ChangeRequest, SchedulerResult } from "./scheduler.js";

type Operation = {
  id: string;
  task_id: string;
  proposal_version: number;
  status: string;
  request: ChangeRequest;
  result: SchedulerResult | null;
  attempts: number;
  last_error: string | null;
};
const terminal = new Set(["confirmed", "rejected", "cancelled"]);

export class BookingExecutor {
  readonly now: () => Date;
  constructor(
    readonly pool: Pool,
    readonly options: BackendOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  private async eligible(db: Database, task: Task, workflow: WorkflowRecord, operation: Operation) {
    if (workflow.takeoverRequested || workflow.withdrawalRequested)
      throw new BackendError("request_stopped");
    if (
      !["ready_to_execute", "executing", "reconciling"].includes(task.state) ||
      workflow.activeProposalVersion !== operation.proposal_version
    )
      throw new BackendError("proposal_version_conflict");
    const proposal = await activeProposal(db, task.id, operation.proposal_version);
    const actions = (
      await db.query("SELECT * FROM action_requests WHERE task_id=$1 AND proposal_version=$2", [
        task.id,
        operation.proposal_version,
      ])
    ).rows;
    const staff = actions.find((a) => a.kind === "staff_approval");
    const patient = actions.find((a) => a.kind === "patient_confirmation");
    const slot = await this.options.scheduler.getSlot(proposal.slotId, db);
    if (
      !slot ||
      Date.parse(slot.startsAt) !== Date.parse(proposal.startsAt) ||
      Date.parse(slot.endsAt) !== Date.parse(proposal.endsAt)
    )
      throw new BackendError("slot_time_conflict");
    // Revocation must commit before this final check or wait until dispatch is committed.
    await db.query("SELECT id FROM principals WHERE id = ANY($1::text[]) ORDER BY id FOR SHARE", [
      [task.requesterId, staff?.responded_by].filter(Boolean),
    ]);
    await db.query(
      "SELECT id FROM authority_grants WHERE patient_id=$1 AND requester_id=$2 FOR SHARE",
      [task.patientId, task.requesterId],
    );
    const now = this.now();
    const requester = await getPrincipal(db, task.requesterId);
    try {
      await requirePatientAccess(db, requester, task.patientId, now);
    } catch (error) {
      if (!(error instanceof BackendError)) throw error;
      throw new BackendError("authority_required");
    }
    if (Date.parse(proposal.expiresAt) <= now.getTime()) throw new BackendError("proposal_expired");
    for (const action of [staff, patient]) {
      if (
        !action ||
        action.status !== "approved" ||
        new Date(action.expires_at).getTime() <= now.getTime()
      )
        throw new BackendError("decisions_required");
    }
    if (patient.responded_by !== task.requesterId) throw new BackendError("decisions_required");
    await requireStaff(db, await getPrincipal(db, staff.responded_by), task.departmentId);
    const delivered = workflow.callbackDelivered;
    const start = Date.parse(workflow.callbackWindow.startsAt),
      end = Date.parse(workflow.callbackWindow.endsAt);
    const confirmedAt = new Date(patient.responded_at).getTime();
    if (
      !delivered ||
      delivered.version !== operation.proposal_version ||
      Date.parse(delivered.at) < start ||
      Date.parse(delivered.at) >= end ||
      confirmedAt < Date.parse(delivered.at) ||
      confirmedAt >= end ||
      confirmedAt > now.getTime()
    )
      throw new BackendError("callback_required");
  }

  async execute(taskId: string, guard?: { actor: Principal; expectedRevision: number }) {
    const operation = await transaction(this.pool, async (db) => {
      const task = await lockTask(db, taskId);
      const workflow = await readWorkflow(db, task.id);
      if (guard) {
        await requirePatientAccess(db, guard.actor, task.patientId, this.now());
        await requireStaff(db, guard.actor, task.departmentId);
      }
      if (workflow.operationId) {
        const existing = (
          await db.query("SELECT * FROM booking_operations WHERE id=$1 FOR UPDATE", [
            workflow.operationId,
          ])
        ).rows[0] as Operation | undefined;
        if (
          guard &&
          task.revision !== guard.expectedRevision &&
          existing?.proposal_version !== workflow.activeProposalVersion
        )
          throw new BackendError("revision_conflict");
        if (existing) return existing;
      }
      if (guard && task.revision !== guard.expectedRevision)
        throw new BackendError("revision_conflict");
      if (task.state !== "ready_to_execute") throw new BackendError("not_ready_to_execute");
      const proposal = await activeProposal(db, task.id, workflow.activeProposalVersion);
      const now = this.now(),
        id = randomUUID();
      const request: ChangeRequest = {
        operationKey: `reschedule:${task.id}:v${proposal.version}`,
        appointmentId: proposal.appointmentId,
        patientId: task.patientId,
        departmentId: task.departmentId,
        slotId: proposal.slotId,
        expectedBookingVersion: proposal.expectedBookingVersion,
        expectedStartsAt: proposal.startsAt,
        expectedEndsAt: proposal.endsAt,
      };
      const result = await db.query(
        "INSERT INTO booking_operations (id,operation_key,task_id,proposal_version,status,request,created_at,updated_at) VALUES ($1,$2,$3,$4,'prepared',$5,$6,$6) RETURNING *",
        [id, request.operationKey, task.id, proposal.version, request, now],
      );
      workflow.operationId = id;
      await saveWorkflow(db, task.id, workflow);
      await saveTaskEvent(
        db,
        {
          ...task,
          state: "executing",
          nextAction: "Recheck and dispatch the saved booking operation.",
        },
        "backend-executor",
        "booking_prepared",
        `operation:${id}`,
        now,
      );
      return result.rows[0] as Operation;
    });
    if (terminal.has(operation.status)) return operation;
    if (operation.status === "prepared") return this.dispatch(operation);
    return this.reconcile(operation);
  }

  private async dispatch(operation: Operation) {
    const dispatch = await transaction(this.pool, async (db) => {
      const task = await lockTask(db, operation.task_id);
      const current = (
        await db.query("SELECT * FROM booking_operations WHERE id=$1 FOR UPDATE", [operation.id])
      ).rows[0] as Operation;
      if (current.status !== "prepared") return { operation: current, send: false };
      const workflow = await readWorkflow(db, task.id);
      try {
        await this.eligible(db, task, workflow, current);
      } catch (error) {
        if (!(error instanceof BackendError)) throw error;
        const result = await db.query(
          "UPDATE booking_operations SET status='cancelled',last_error=$2,updated_at=$3 WHERE id=$1 RETURNING *",
          [current.id, error.code, this.now()],
        );
        await cancelActions(db, task.id);
        delete workflow.activeProposalVersion;
        await saveWorkflow(db, task.id, workflow);
        await saveTaskEvent(
          db,
          {
            ...task,
            state:
              error.code === "authority_required"
                ? "awaiting_verification"
                : workflow.takeoverRequested
                  ? "staff_takeover"
                  : workflow.withdrawalRequested
                    ? "withdrawn"
                    : "awaiting_proposal",
            nextAction: `Booking was not dispatched: ${error.code}. Review the request.`,
          },
          "backend-executor",
          "booking_dispatch_blocked",
          `operation:${current.id}`,
          this.now(),
        );
        return { operation: result.rows[0] as Operation, send: false };
      }
      const result = await db.query(
        "UPDATE booking_operations SET status='dispatched',attempts=attempts+1,updated_at=$2 WHERE id=$1 RETURNING *",
        [current.id, this.now()],
      );
      return { operation: result.rows[0] as Operation, send: true };
    });
    if (!dispatch.send)
      return terminal.has(dispatch.operation.status)
        ? dispatch.operation
        : this.reconcile(dispatch.operation);
    return this.change(dispatch.operation);
  }

  private async change(operation: Operation) {
    try {
      return await this.finish(operation, await this.options.scheduler.change(operation.request));
    } catch {
      return this.uncertain(operation, "scheduler_response_unknown");
    }
  }

  private async reconcile(operation: Operation) {
    try {
      const saved = await this.options.scheduler.lookup(operation.request.operationKey);
      if (saved) return this.finish(operation, saved);
      // A lookup precedes every retry. Only this same durable key may be retried.
      const retry = await transaction(this.pool, async (db) => {
        const task = await lockTask(db, operation.task_id);
        const current = (
          await db.query("SELECT * FROM booking_operations WHERE id=$1 FOR UPDATE", [operation.id])
        ).rows[0] as Operation;
        if (terminal.has(current.status) || current.attempts >= 3) return false;
        await this.eligible(db, task, await readWorkflow(db, task.id), current);
        await db.query(
          "UPDATE booking_operations SET status='dispatched',attempts=attempts+1,updated_at=$2 WHERE id=$1",
          [operation.id, this.now()],
        );
        return true;
      });
      return retry
        ? this.change(operation)
        : this.uncertain(operation, "awaiting_scheduler_confirmation");
    } catch {
      return this.uncertain(operation, "awaiting_scheduler_confirmation");
    }
  }

  private async uncertain(operation: Operation, reason: string) {
    return transaction(this.pool, async (db) => {
      const task = await lockTask(db, operation.task_id);
      const current = (
        await db.query("SELECT * FROM booking_operations WHERE id=$1 FOR UPDATE", [operation.id])
      ).rows[0] as Operation;
      if (terminal.has(current.status)) return current;
      const result = await db.query(
        "UPDATE booking_operations SET status='reconciling',last_error=$2,updated_at=$3 WHERE id=$1 RETURNING *",
        [operation.id, reason, this.now()],
      );
      if (task.state !== "reconciling")
        await saveTaskEvent(
          db,
          {
            ...task,
            state: "reconciling",
            nextAction:
              "The original booking result is being checked; do not submit another change.",
          },
          "backend-executor",
          "booking_reconciliation_required",
          `operation:${operation.id}`,
          this.now(),
        );
      return result.rows[0] as Operation;
    });
  }

  private async finish(operation: Operation, result: SchedulerResult) {
    if (result.status === "confirmed") {
      const expected = operation.request,
        actual = result.booking;
      if (
        !result.confirmationRef ||
        actual.id !== expected.appointmentId ||
        actual.patientId !== expected.patientId ||
        actual.departmentId !== expected.departmentId ||
        actual.slotId !== expected.slotId ||
        actual.version === expected.expectedBookingVersion ||
        Date.parse(actual.startsAt) !== Date.parse(expected.expectedStartsAt) ||
        Date.parse(actual.endsAt) !== Date.parse(expected.expectedEndsAt)
      )
        throw new BackendError("invalid_scheduler_evidence");
    }
    return transaction(this.pool, async (db) => {
      const task = await lockTask(db, operation.task_id);
      const current = (
        await db.query("SELECT * FROM booking_operations WHERE id=$1 FOR UPDATE", [operation.id])
      ).rows[0] as Operation;
      if (terminal.has(current.status)) return current;
      const workflow = await readWorkflow(db, task.id);
      const saved = await db.query(
        "UPDATE booking_operations SET status=$2,result=$3,last_error=NULL,updated_at=$4 WHERE id=$1 RETURNING *",
        [operation.id, result.status, result, this.now()],
      );
      const confirmed = result.status === "confirmed";
      await cancelActions(db, task.id, !confirmed);
      await saveTaskEvent(
        db,
        {
          ...task,
          state: confirmed
            ? "completed"
            : workflow.takeoverRequested
              ? "staff_takeover"
              : workflow.withdrawalRequested
                ? "withdrawn"
                : "awaiting_proposal",
          nextAction: confirmed
            ? workflow.takeoverRequested || workflow.withdrawalRequested
              ? "Booking confirmed before the stop request was resolved; staff must review any further change."
              : "Appointment changed with recorded scheduler confirmation."
            : "The scheduler rejected this change; review the reason and propose a new option.",
        },
        "backend-executor",
        confirmed ? "booking_confirmed" : "booking_rejected",
        confirmed ? result.confirmationRef : `operation:${operation.id}:${result.reason}`,
        this.now(),
      );
      return saved.rows[0] as Operation;
    });
  }

  async recover(limit = 100) {
    const rows = (
      await this.pool.query(
        "SELECT DISTINCT t.id FROM tasks t LEFT JOIN booking_operations o ON o.task_id=t.id WHERE t.payload->>'state'='ready_to_execute' OR o.status IN ('prepared','dispatched','reconciling') ORDER BY t.id LIMIT $1",
        [limit],
      )
    ).rows;
    const results = [];
    for (const row of rows) {
      try {
        results.push({ taskId: row.id, status: (await this.execute(row.id)).status });
      } catch (error) {
        results.push({
          taskId: row.id,
          status: "error",
          error: error instanceof BackendError ? error.code : "storage_unavailable",
        });
      }
    }
    return results;
  }
}
