import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { BackendError, transaction, type Database } from "./domain.js";
import { getPrincipal, type Principal } from "./identity.js";
import { VoiceCallbackStore } from "./voice-callback-store.js";
import {
  assignedTask,
  boundActor,
  callRow,
  currentPatient,
  event,
  hash,
  mask,
  publicCall,
  requireActiveCall,
  requireOpen,
  safeReason,
  terminalCalls,
  visible,
  type CallRow,
  type PendingVoiceAction,
  type VoiceCall,
} from "./voice-store-support.js";

export type { PendingVoiceAction, VoiceCall } from "./voice-store-support.js";

type AccessCode = {
  id: string;
  actor_id: string;
  task_id: string | null;
  expires_at: Date;
  revoked_at: Date | null;
  consumed_call_id: string | null;
};

export class VoiceStore extends VoiceCallbackStore {
  async issueCode(actor: Principal, taskId?: string): Promise<{ code: string; expiresAt: string }> {
    return transaction(this.pool, async (db) => {
      // Serialize rotations, so one patient can have at most one unused access code.
      await db.query("SELECT id FROM principals WHERE id=$1 FOR NO KEY UPDATE", [actor.id]);
      const principal = await currentPatient(db, actor.id);
      const now = this.now();
      await db.query(
        "UPDATE voice_access_codes SET revoked_at=$2 WHERE actor_id=$1 AND consumed_call_id IS NULL AND revoked_at IS NULL",
        [actor.id, now],
      );
      if (taskId) await assignedTask(db, principal, taskId, now);
      const expiresAt = new Date(now.getTime() + 600_000);
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = randomInt(100_000_000).toString().padStart(8, "0");
        const result = await db.query(
          `INSERT INTO voice_access_codes (id,code_hash,actor_id,task_id,created_at,expires_at)
           VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (code_hash) DO NOTHING RETURNING id`,
          [randomUUID(), hash(code), actor.id, taskId ?? null, now, expiresAt],
        );
        if (result.rowCount) return { code, expiresAt: expiresAt.toISOString() };
      }
      throw new BackendError("code_unavailable", 503);
    });
  }

  private async verify(
    db: Database,
    row: CallRow,
    code: string,
    expectedActor?: string,
  ): Promise<VoiceCall | BackendError> {
    const now = this.now();
    const failure = new BackendError("invalid_voice_code", 401);
    if (row.verification_failures >= 5) return new BackendError("voice_verification_locked", 429);
    const found =
      typeof code === "string" && /^\d{8}$/.test(code)
        ? (
            await db.query<AccessCode>(
              "SELECT * FROM voice_access_codes WHERE code_hash=$1 FOR UPDATE",
              [hash(code)],
            )
          ).rows[0]
        : undefined;
    let valid =
      !!found &&
      !found.revoked_at &&
      (!found.consumed_call_id ? found.expires_at > now : found.consumed_call_id === row.id) &&
      (!expectedActor || found.actor_id === expectedActor) &&
      (!row.actor_id || row.actor_id === found.actor_id) &&
      (!row.task_id || !found.task_id || row.task_id === found.task_id);
    if (valid && found) {
      try {
        const actor = await currentPatient(db, found.actor_id);
        const taskId = row.task_id ?? found.task_id;
        if (taskId) await assignedTask(db, actor, taskId, now);
      } catch (error) {
        if (!(error instanceof BackendError)) throw error;
        valid = false;
      }
    }
    if (!valid || !found) {
      if (!row.verified_at && !terminalCalls.has(row.status)) {
        await db.query(
          `UPDATE voice_calls SET verification_failures=verification_failures+1,updated_at=$2,
           status=CASE WHEN verification_failures=4 THEN 'failed' ELSE status END,
           last_error=CASE WHEN verification_failures=4 THEN 'voice_verification_locked' ELSE last_error END WHERE id=$1`,
          [row.id, now],
        );
        await event(db, row.id, "verification_failed", now);
      }
      return failure;
    }
    if (found.consumed_call_id === row.id) return publicCall(row);
    if (terminalCalls.has(row.status) || row.verified_at || row.status === "queued")
      return new BackendError("invalid_transition", 409);
    await db.query("UPDATE voice_access_codes SET consumed_call_id=$2 WHERE id=$1", [
      found.id,
      row.id,
    ]);
    await db.query(
      `UPDATE voice_calls SET actor_id=$2,task_id=COALESCE(task_id,$3),verified_at=$4,
       status='in_progress',updated_at=$4,last_error=NULL WHERE id=$1`,
      [row.id, found.actor_id, found.task_id, now],
    );
    await event(db, row.id, "caller_verified", now);
    return publicCall(await callRow(db, row.id));
  }

  async simulate(actor: Principal, code: string): Promise<VoiceCall> {
    return transaction(this.pool, async (db) => {
      await currentPatient(db, actor.id);
      const id = randomUUID();
      await db.query(
        `INSERT INTO voice_calls (id,mode,direction,status,created_at,updated_at)
         VALUES ($1,'simulated','inbound','awaiting_verification',$2,$2)`,
        [id, this.now()],
      );
      const verified = await this.verify(db, await callRow(db, id, true), code, actor.id);
      if (verified instanceof BackendError) throw verified;
      await event(db, id, "simulation_started", this.now());
      return verified;
    });
  }

  async beginInbound(input: { sid: string; from: string }): Promise<VoiceCall> {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(input.sid))
      throw new BackendError("invalid_input", 400);
    return transaction(this.pool, async (db) => {
      const id = randomUUID();
      const result = await db.query<CallRow>(
        `INSERT INTO voice_calls (id,mode,direction,status,created_at,updated_at,provider_sid,masked_number)
         VALUES ($1,'twilio','inbound','awaiting_verification',$2,$2,$3,$4)
         ON CONFLICT (provider_sid) DO NOTHING RETURNING *`,
        [id, this.now(), input.sid, mask(input.from)],
      );
      if (result.rows[0]) {
        await event(db, id, "inbound_started", this.now());
        return publicCall(result.rows[0]);
      }
      const previous = (
        await db.query<CallRow>("SELECT * FROM voice_calls WHERE provider_sid=$1", [input.sid])
      ).rows[0]!;
      if (previous.direction !== "inbound") throw new BackendError("provider_sid_mismatch", 403);
      return publicCall(previous);
    });
  }

  async verifyCode(id: string, code: string): Promise<VoiceCall> {
    const result = await transaction(this.pool, async (db) =>
      this.verify(db, await callRow(db, id, true), code),
    );
    // Failures are thrown after commit so the five-attempt limit cannot roll back.
    if (result instanceof BackendError) throw result;
    return result;
  }

  async get(actor: Principal, id: string): Promise<VoiceCall> {
    return transaction(this.pool, async (db) => {
      const row = await callRow(db, id);
      await visible(db, actor, row, this.now());
      const events = (
        await db.query(
          `SELECT id,kind,detail,occurred_at AS "occurredAt" FROM voice_events
         WHERE call_id=$1 ORDER BY occurred_at,id LIMIT 200`,
          [id],
        )
      ).rows.map((item) => ({ ...item, occurredAt: item.occurredAt.toISOString() }));
      return { ...publicCall(row), events };
    });
  }

  async list(actor: Principal): Promise<VoiceCall[]> {
    const current = await getPrincipal(this.pool, actor.id);
    if (!current.active || !current.verified) throw new BackendError("unauthorized", 401);
    const result = await this.pool.query<CallRow>(
      `SELECT c.* FROM voice_calls c LEFT JOIN tasks t ON t.id=c.task_id
       LEFT JOIN principals p ON p.id=c.actor_id LEFT JOIN patients patient ON patient.id=p.patient_id
       WHERE ($1='patient' AND c.actor_id=$2) OR ($1 IN ('staff','operator') AND
       COALESCE(t.payload->>'departmentId',patient.department_id)=$3)
       ORDER BY c.created_at DESC,c.id LIMIT 200`,
      [current.role, current.id, current.departmentId],
    );
    const calls: VoiceCall[] = [];
    for (const row of result.rows) {
      try {
        calls.push(await this.get(current, row.id));
      } catch (error) {
        if (!(error instanceof BackendError && [403, 404].includes(error.statusCode))) throw error;
      }
    }
    return calls;
  }

  async getInternal(id: string): Promise<VoiceCall> {
    return publicCall(await callRow(this.pool, id));
  }

  async bySid(sid: string): Promise<VoiceCall | null> {
    const row = (
      await this.pool.query<CallRow>("SELECT * FROM voice_calls WHERE provider_sid=$1", [sid])
    ).rows[0];
    return row ? publicCall(row) : null;
  }

  async bound(id: string): Promise<{ call: VoiceCall; actor: Principal }> {
    return transaction(this.pool, async (db) => {
      const row = await callRow(db, id, true);
      const actor = await boundActor(db, row, this.now());
      return { call: publicCall(row), actor };
    });
  }

  async attachTask(id: string, taskId: string): Promise<void> {
    await transaction(this.pool, async (db) => {
      const row = await callRow(db, id, true);
      const actor = await requireOpen(db, row, this.now());
      if (row.task_id && row.task_id !== taskId) throw new BackendError("call_already_bound", 409);
      await assignedTask(db, actor, taskId, this.now());
      await db.query("UPDATE voice_calls SET task_id=$2,updated_at=$3 WHERE id=$1", [
        id,
        taskId,
        this.now(),
      ]);
      await event(db, id, "task_attached", this.now(), { taskId });
    });
  }

  async setPending(id: string, pending: PendingVoiceAction): Promise<VoiceCall> {
    const expires = new Date(pending.expiresAt);
    if (
      typeof pending.id !== "string" ||
      !pending.id ||
      pending.id.length > 120 ||
      !["create_request", "callback", "confirm", "withdraw"].includes(pending.kind) ||
      !pending.input ||
      typeof pending.input !== "object" ||
      Array.isArray(pending.input) ||
      typeof pending.description !== "string" ||
      !pending.description.trim() ||
      pending.description.length > 2000 ||
      !Number.isFinite(expires.getTime()) ||
      expires <= this.now() ||
      JSON.stringify(pending).length > 20_000
    )
      throw new BackendError("invalid_pending_action", 400);
    return transaction(this.pool, async (db) => {
      const row = await callRow(db, id, true);
      await requireOpen(db, row, this.now());
      if (row.pending_action && Date.parse(row.pending_action.expiresAt) > this.now().getTime())
        throw new BackendError("pending_action_exists", 409);
      await db.query("UPDATE voice_calls SET pending_action=$2,updated_at=$3 WHERE id=$1", [
        id,
        pending,
        this.now(),
      ]);
      await event(db, id, "action_proposed", this.now(), {
        actionId: pending.id,
        kind: pending.kind,
      });
      return publicCall(await callRow(db, id));
    });
  }

  async consumePending(id: string, actionId: string): Promise<PendingVoiceAction> {
    const result = await transaction(this.pool, async (db) => {
      const row = await callRow(db, id, true);
      await requireOpen(db, row, this.now());
      const pending = row.pending_action;
      if (!pending || pending.id !== actionId)
        return new BackendError("pending_action_missing", 409);
      await db.query("UPDATE voice_calls SET pending_action=NULL,updated_at=$2 WHERE id=$1", [
        id,
        this.now(),
      ]);
      if (Date.parse(pending.expiresAt) <= this.now().getTime()) {
        await event(db, id, "action_expired", this.now(), { actionId });
        return new BackendError("pending_action_expired", 409);
      }
      await event(db, id, "action_confirmed", this.now(), { actionId, kind: pending.kind });
      return pending;
    });
    if (result instanceof BackendError) throw result;
    return result;
  }

  async cancelPending(id: string): Promise<void> {
    await transaction(this.pool, async (db) => {
      const row = await callRow(db, id, true);
      await boundActor(db, row, this.now());
      await db.query("UPDATE voice_calls SET pending_action=NULL,updated_at=$2 WHERE id=$1", [
        id,
        this.now(),
      ]);
      if (row.pending_action)
        await event(db, id, "action_cancelled", this.now(), { actionId: row.pending_action.id });
    });
  }

  async recordEvent(
    id: string,
    kind: string,
    detail: Record<string, unknown> = {},
    dedupeKey?: string,
  ): Promise<void> {
    await event(this.pool, id, kind, this.now(), detail, dedupeKey);
  }

  async end(id: string, reason: string): Promise<VoiceCall> {
    return transaction(this.pool, async (db) => {
      const row = await callRow(db, id, true);
      if (!terminalCalls.has(row.status)) {
        await db.query(
          `UPDATE voice_calls SET status='completed',pending_action=NULL,stream_token_hash=NULL,
           updated_at=$2 WHERE id=$1`,
          [id, this.now()],
        );
        await event(db, id, "call_ended", this.now(), { reason: safeReason(reason) }, "call_ended");
      }
      return publicCall(await callRow(db, id));
    });
  }

  async handoff(id: string): Promise<VoiceCall> {
    return transaction(this.pool, async (db) => {
      const row = await callRow(db, id, true);
      await boundActor(db, row, this.now());
      if (row.status === "handoff") return publicCall(row);
      if (terminalCalls.has(row.status)) throw new BackendError("call_ended", 409);
      await db.query(
        `UPDATE voice_calls SET status='handoff',pending_action=NULL,stream_token_hash=NULL,
         updated_at=$2 WHERE id=$1`,
        [id, this.now()],
      );
      await event(db, id, "handoff_requested", this.now(), {}, "handoff_requested");
      return publicCall(await callRow(db, id));
    });
  }

  async issueStream(id: string): Promise<{ token: string }> {
    return transaction(this.pool, async (db) => {
      const row = await callRow(db, id, true);
      await requireActiveCall(db, row, this.now());
      if (!row.provider_sid || row.mode !== "twilio")
        throw new BackendError("provider_call_required", 409);
      if (row.stream_claimed_at) throw new BackendError("stream_already_connected", 409);
      const token = randomBytes(32).toString("base64url");
      await db.query(
        "UPDATE voice_calls SET stream_token_hash=$2,stream_expires_at=$3 WHERE id=$1",
        [id, hash(token), new Date(this.now().getTime() + 300_000)],
      );
      return { token };
    });
  }

  async claimStream(id: string, token: string, providerSid: string): Promise<{ callId: string }> {
    return transaction(this.pool, async (db) => {
      const row = await callRow(db, id, true);
      if (
        typeof token !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(token) ||
        row.stream_claimed_at ||
        !row.stream_token_hash ||
        row.stream_token_hash !== hash(token) ||
        !row.stream_expires_at ||
        row.stream_expires_at <= this.now() ||
        row.provider_sid !== providerSid
      )
        throw new BackendError("invalid_stream_token", 401);
      await requireActiveCall(db, row, this.now());
      await db.query(
        "UPDATE voice_calls SET stream_token_hash=NULL,stream_expires_at=NULL,stream_claimed_at=$2,status='in_progress',updated_at=$2 WHERE id=$1",
        [id, this.now()],
      );
      await event(db, id, "stream_connected", this.now());
      return { callId: id };
    });
  }

  async getToolResult(callId: string, toolCallId: string): Promise<unknown | undefined> {
    const result = await this.pool.query(
      "SELECT result FROM voice_tool_results WHERE call_id=$1 AND tool_call_id=$2",
      [callId, toolCallId],
    );
    return result.rows[0]?.result;
  }

  async saveToolResult(callId: string, toolCallId: string, result: unknown): Promise<void> {
    await this.pool.query(
      `INSERT INTO voice_tool_results (call_id,tool_call_id,result) VALUES ($1,$2,$3)
       ON CONFLICT (call_id,tool_call_id) DO NOTHING`,
      [callId, toolCallId, JSON.stringify(result ?? null)],
    );
  }
}
