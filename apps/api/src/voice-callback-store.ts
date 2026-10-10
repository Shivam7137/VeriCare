import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { BackendError, transaction } from "./domain.js";
import type { Principal } from "./identity.js";
import {
  assignedTask,
  callRow,
  currentPatient,
  event,
  mask,
  mutableTask,
  publicCall,
  safeReason,
  terminalCalls,
  type CallRow,
  type VoiceCall,
} from "./voice-store-support.js";

export class VoiceCallbackStore {
  readonly now: () => Date;
  constructor(
    readonly pool: Pool,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async scheduleCallback(
    actor: Principal,
    input: {
      taskId: string;
      to: string;
      dueAt: string;
      mode: "simulated" | "twilio";
    },
  ): Promise<VoiceCall> {
    const now = this.now();
    const due = new Date(input.dueAt);
    if (
      typeof input.to !== "string" ||
      !/^\+[1-9]\d{7,14}$/.test(input.to) ||
      !["simulated", "twilio"].includes(input.mode) ||
      typeof input.dueAt !== "string" ||
      !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(input.dueAt) ||
      !Number.isFinite(due.getTime()) ||
      due <= now
    )
      throw new BackendError("invalid_callback", 400);
    return transaction(this.pool, async (db) => {
      const principal = await currentPatient(db, actor.id);
      const task = await assignedTask(db, principal, input.taskId, now);
      const workflow = await mutableTask(db, task);
      if (
        due.getTime() < Date.parse(workflow.callbackWindow.startsAt) ||
        due.getTime() >= Date.parse(workflow.callbackWindow.endsAt)
      )
        throw new BackendError("outside_callback_window", 400);
      const existing = await db.query(
        `SELECT id FROM voice_calls WHERE task_id=$1 AND direction='outbound'
         AND status NOT IN ('completed','failed','cancelled','handoff')`,
        [task.id],
      );
      if (existing.rowCount) throw new BackendError("callback_already_scheduled", 409);
      const id = randomUUID();
      await db.query(
        `INSERT INTO voice_calls (id,task_id,actor_id,mode,direction,status,created_at,updated_at,
          due_at,recipient_number,masked_number)
         VALUES ($1,$2,$3,$4,'outbound','queued',$5,$5,$6,$7,$8)`,
        [id, task.id, principal.id, input.mode, now, due, input.to, mask(input.to)],
      );
      await event(db, id, "callback_scheduled", now);
      return publicCall(await callRow(db, id));
    });
  }

  async claimDue(limit = 20): Promise<(VoiceCall & { to: string })[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200)
      throw new BackendError("invalid_input", 400);
    return transaction(this.pool, async (db) => {
      const now = this.now();
      // Dispatch was durably claimed before an uncertain worker crash. Never redial it.
      const stale = await db.query<CallRow>(
        `UPDATE voice_calls SET status='reconciling',last_error='dispatch_outcome_unknown',updated_at=$1
         WHERE status='dialing' AND updated_at <= $2 RETURNING *`,
        [now, new Date(now.getTime() - 60_000)],
      );
      for (const row of stale.rows) await event(db, row.id, "dispatch_reconciling", now);
      const due = await db.query<CallRow>(
        `SELECT * FROM voice_calls WHERE status='queued' AND due_at <= $1
         ORDER BY due_at,id LIMIT $2 FOR UPDATE SKIP LOCKED`,
        [now, limit],
      );
      const claimed: (VoiceCall & { to: string })[] = [];
      for (const row of due.rows) {
        try {
          if (!row.actor_id || !row.task_id || !row.recipient_number)
            throw new BackendError("callback_ineligible");
          const actor = await currentPatient(db, row.actor_id);
          const task = await assignedTask(db, actor, row.task_id, now);
          const workflow = await mutableTask(db, task);
          const start = Date.parse(workflow.callbackWindow.startsAt);
          const end = Date.parse(workflow.callbackWindow.endsAt);
          if (
            !row.due_at ||
            row.due_at.getTime() < start ||
            row.due_at.getTime() >= end ||
            now.getTime() < start ||
            now.getTime() >= end
          )
            throw new BackendError("outside_callback_window");
        } catch (error) {
          if (!(error instanceof BackendError)) throw error;
          await db.query(
            "UPDATE voice_calls SET status='cancelled',last_error=$2,updated_at=$3 WHERE id=$1",
            [row.id, error.code, now],
          );
          await event(db, row.id, "callback_cancelled", now, { reason: error.code });
          continue;
        }
        await db.query("UPDATE voice_calls SET status='dialing',updated_at=$2 WHERE id=$1", [
          row.id,
          now,
        ]);
        await event(db, row.id, "dispatch_claimed", now);
        claimed.push({ ...publicCall(await callRow(db, row.id)), to: row.recipient_number! });
      }
      return claimed;
    });
  }

  async markDialed(id: string, sid: string): Promise<void> {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(sid)) throw new BackendError("invalid_input", 400);
    await transaction(this.pool, async (db) => {
      const row = await callRow(db, id, true);
      if (row.provider_sid && row.provider_sid !== sid)
        throw new BackendError("provider_sid_mismatch", 403);
      if (row.direction !== "outbound" || row.status === "queued")
        throw new BackendError("invalid_transition");
      const status = ["dialing", "reconciling"].includes(row.status) ? "ringing" : row.status;
      await db.query("UPDATE voice_calls SET provider_sid=$2,status=$3,updated_at=$4 WHERE id=$1", [
        id,
        sid,
        status,
        this.now(),
      ]);
      await event(db, id, "provider_dialed", this.now(), {}, "provider_dialed");
    });
  }

  async markDispatchFailed(id: string, reason: string, uncertain: boolean): Promise<void> {
    await transaction(this.pool, async (db) => {
      const row = await callRow(db, id, true);
      if (row.status !== "dialing") return;
      await db.query("UPDATE voice_calls SET status=$2,last_error=$3,updated_at=$4 WHERE id=$1", [
        id,
        uncertain ? "reconciling" : "failed",
        safeReason(reason),
        this.now(),
      ]);
      await event(db, id, "dispatch_failed", this.now(), { reason: safeReason(reason), uncertain });
    });
  }

  async statusCallback(id: string, sid: string, status: string): Promise<void> {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(sid)) throw new BackendError("invalid_input", 400);
    const mapped: Record<string, VoiceCall["status"]> = {
      queued: "dialing",
      initiated: "dialing",
      ringing: "ringing",
      "in-progress": "in_progress",
      completed: "completed",
      busy: "failed",
      "no-answer": "failed",
      canceled: "cancelled",
      failed: "failed",
    };
    if (!mapped[status]) throw new BackendError("invalid_provider_status", 400);
    await transaction(this.pool, async (db) => {
      const row = await callRow(db, id, true);
      if (row.provider_sid !== sid) {
        if (
          row.provider_sid ||
          row.direction !== "outbound" ||
          !["dialing", "reconciling"].includes(row.status)
        )
          throw new BackendError("provider_sid_mismatch", 403);
        // This method is reached only through a signed webhook containing our outbound call ID.
        await db.query("UPDATE voice_calls SET provider_sid=$2 WHERE id=$1", [id, sid]);
      }
      if (terminalCalls.has(row.status)) return;
      const next =
        mapped[status] === "in_progress" && !row.verified_at
          ? "awaiting_verification"
          : mapped[status]!;
      if (row.status === "transferring" && !terminalCalls.has(next)) return;
      const ranks: Record<string, number> = {
        queued: 0,
        dialing: 1,
        ringing: 2,
        awaiting_verification: 3,
        in_progress: 4,
        reconciling: 0,
      };
      if (!terminalCalls.has(next) && (ranks[next] ?? 0) < (ranks[row.status] ?? 0)) return;
      await db.query(
        `UPDATE voice_calls SET status=$2,updated_at=$3,
         pending_action=CASE WHEN $4 THEN NULL ELSE pending_action END,
         stream_token_hash=CASE WHEN $4 THEN NULL ELSE stream_token_hash END WHERE id=$1`,
        [id, next, this.now(), terminalCalls.has(next)],
      );
      await event(db, id, "provider_status", this.now(), { status }, `provider_status:${status}`);
    });
  }
}
