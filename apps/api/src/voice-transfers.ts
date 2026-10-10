import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { voiceTransferInputSchema, type VoiceTransfer } from "@prc/contracts";
import { BackendError, transaction, type Database } from "./domain.js";
import type { Principal } from "./identity.js";
import { directoryScope, validateDestination, type DirectoryRow } from "./care-team-directory.js";
import {
  callRow,
  event,
  mask,
  requireActiveCall,
  terminalCalls,
  visible,
  type PendingVoiceAction,
} from "./voice-store-support.js";
import { TwilioDispatchError } from "./twilio-provider.js";

export interface TransferProvider {
  transfer(input: {
    parentSid: string;
    transferId: string;
    destination: string;
    name: string;
  }): Promise<void>;
}
type TransferRow = {
  id: string;
  call_id: string;
  member_id: string;
  patient_id: string | null;
  destination_name: string;
  destination_role: VoiceTransfer["destinationRole"];
  department_id: string;
  destination_number: string | null;
  destination_revision: number;
  mode: VoiceTransfer["mode"];
  status: VoiceTransfer["status"];
  created_at: Date;
  updated_at: Date;
  last_error: string | null;
  parent_sid: string | null;
  child_sid: string | null;
};
const finalStatuses = new Set<VoiceTransfer["status"]>([
  "connected",
  "no-answer",
  "busy",
  "failed",
  "cancelled",
]);
function publicTransfer(row: TransferRow): VoiceTransfer {
  return {
    id: row.id,
    callId: row.call_id,
    memberId: row.member_id,
    patientId: row.patient_id,
    destinationName: row.destination_name,
    destinationRole: row.destination_role,
    departmentId: row.department_id,
    maskedNumber: row.destination_number ? mask(row.destination_number) : null,
    mode: row.mode,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    lastError: row.last_error,
  };
}
async function transferRow(db: Database, id: string, lock = false) {
  const row = (
    await db.query<TransferRow>(
      `SELECT * FROM voice_transfers WHERE id=$1${lock ? " FOR UPDATE" : ""}`,
      [id],
    )
  ).rows[0];
  if (!row) throw new BackendError("not_found", 404);
  return row;
}
export class VoiceTransfers {
  readonly now: () => Date;
  constructor(
    readonly pool: Pool,
    readonly options: {
      now?: () => Date;
      ownNumber?: string | null;
      provider?: TransferProvider;
    } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }
  async reconcileStale(): Promise<void> {
    const cutoff = new Date(this.now().getTime() - 60_000);
    const stale = (
      await this.pool.query<TransferRow>(
        "SELECT * FROM voice_transfers WHERE status='dispatching' AND updated_at <= $1 ORDER BY updated_at LIMIT 100",
        [cutoff],
      )
    ).rows;
    for (const item of stale)
      await transaction(this.pool, async (db) => {
        await callRow(db, item.call_id, true);
        const row = await transferRow(db, item.id, true);
        if (row.status !== "dispatching" || row.updated_at > cutoff) return;
        await db.query(
          "UPDATE voice_transfers SET status='reconciling',last_error='transfer_dispatch_outcome_unknown',updated_at=$2 WHERE id=$1",
          [row.id, this.now()],
        );
        await event(
          db,
          row.call_id,
          "transfer_dispatch",
          this.now(),
          { transferId: row.id, status: "reconciling", mode: row.mode, uncertain: true },
          `transfer_dispatch:${row.id}`,
        );
      });
  }
  async list(actor: Principal, callId: string): Promise<VoiceTransfer[]> {
    const call = await callRow(this.pool, callId);
    await visible(this.pool, actor, call, this.now());
    return (
      await this.pool.query<TransferRow>(
        "SELECT * FROM voice_transfers WHERE call_id=$1 ORDER BY created_at,id",
        [callId],
      )
    ).rows.map(publicTransfer);
  }
  async prepare(
    callId: string,
    raw: unknown,
  ): Promise<{
    status: "awaiting_explicit_confirmation";
    pendingAction: PendingVoiceAction;
    transfer: VoiceTransfer;
    instruction: string;
  }> {
    const input = voiceTransferInputSchema.parse(raw);
    return transaction(this.pool, async (db) => {
      const call = await callRow(db, callId, true);
      const actor = await requireActiveCall(db, call, this.now());
      if (call.status !== "in_progress") throw new BackendError("call_not_active", 409);
      if (call.pending_action && Date.parse(call.pending_action.expiresAt) > this.now().getTime())
        throw new BackendError("pending_action_exists", 409);
      const taskPatient = call.task_id
        ? (
            await db.query("SELECT payload->>'patientId' AS id FROM tasks WHERE id=$1", [
              call.task_id,
            ])
          ).rows[0]?.id
        : null;
      if (taskPatient && input.patientId && taskPatient !== input.patientId)
        throw new BackendError("patient_context_mismatch", 403);
      const scope = await directoryScope(
        db,
        actor,
        input.patientId ?? taskPatient ?? undefined,
        this.now(),
      );
      const member = (
        await db.query<DirectoryRow>(
          "SELECT * FROM care_team_directory WHERE id=$1 AND department_id=$2 FOR SHARE",
          [input.memberId, scope.departmentId],
        )
      ).rows[0];
      if (!member) throw new BackendError("not_found", 404);
      // Explicit member selection is allowed; assigned-doctor lookup is a separate, ambiguity-aware tool.
      if (call.mode === "twilio") {
        validateDestination(member.phone_number, this.options.ownNumber);
        if (!call.provider_sid || !/^CA[0-9a-f]{32}$/i.test(call.provider_sid))
          throw new BackendError("provider_call_required", 409);
        if (!this.options.provider) throw new BackendError("transfer_unavailable", 503);
      }
      if (call.pending_action?.kind === "transfer")
        await db.query(
          "UPDATE voice_transfers SET status='cancelled',last_error='action_expired',updated_at=$2 WHERE id=$1 AND status='prepared'",
          [call.pending_action.id, this.now()],
        );
      const id = randomUUID();
      const label =
        call.mode === "simulated" ? "SIMULATED transfer" : "Transfer this live phone call";
      const pending: PendingVoiceAction = {
        id,
        kind: "transfer",
        input: { transferId: id },
        description: `${label} to ${member.name}, ${member.role}, ${member.department_name}${member.phone_number ? `, destination ending ${member.phone_number.slice(-4)}` : ", no phone number configured"}. ${call.mode === "simulated" ? "No phone will be dialed. " : ""}This does not approve or change an appointment. Press 1 to confirm or 2 to cancel.`,
        expiresAt: new Date(this.now().getTime() + 300_000).toISOString(),
      };
      await db.query(
        `INSERT INTO voice_transfers(id,call_id,member_id,patient_id,destination_name,destination_role,
        department_id,destination_number,destination_revision,mode,status,created_at,updated_at,parent_sid)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'prepared',$11,$11,$12)`,
        [
          id,
          callId,
          member.id,
          scope.patientId,
          member.name,
          member.role,
          member.department_id,
          member.phone_number,
          member.revision,
          call.mode,
          this.now(),
          call.provider_sid,
        ],
      );
      await db.query("UPDATE voice_calls SET pending_action=$2,updated_at=$3 WHERE id=$1", [
        callId,
        pending,
        this.now(),
      ]);
      await event(
        db,
        callId,
        "transfer_prepared",
        this.now(),
        { transferId: id, memberId: member.id, mode: call.mode },
        `transfer_prepared:${id}`,
      );
      return {
        status: "awaiting_explicit_confirmation",
        pendingAction: pending,
        transfer: publicTransfer(await transferRow(db, id)),
        instruction:
          "Read the entire named destination aloud. Only explicit keypad confirmation approves a live transfer. A transfer never completes an appointment.",
      };
    });
  }
  async confirm(
    callId: string,
    actionId: string,
  ): Promise<{
    status: "transfer_dispatched" | "transfer_reconciling" | "transfer_failed";
    transfer: VoiceTransfer;
  }> {
    const prepared = await transaction(this.pool, async (db) => {
      const call = await callRow(db, callId, true);
      const actor = await requireActiveCall(db, call, this.now());
      if (call.status !== "in_progress") throw new BackendError("call_not_active", 409);
      const pending = call.pending_action;
      if (!pending || pending.id !== actionId || pending.kind !== "transfer")
        throw new BackendError("pending_action_missing", 409);
      const row = await transferRow(db, actionId, true);
      if (row.call_id !== callId || row.status !== "prepared")
        throw new BackendError("invalid_transition", 409);
      // Consume exactly once before any provider operation. Failures below commit the consumption.
      await db.query("UPDATE voice_calls SET pending_action=NULL,updated_at=$2 WHERE id=$1", [
        callId,
        this.now(),
      ]);
      let failure: BackendError | undefined;
      if (Date.parse(pending.expiresAt) <= this.now().getTime())
        failure = new BackendError("pending_action_expired", 409);
      // Authority and department can change after readback. Bind dispatch to the
      // saved patient context while checking the caller's current permissions.
      try {
        const scope = await directoryScope(db, actor, row.patient_id ?? undefined, this.now());
        if (scope.departmentId !== row.department_id) throw new BackendError("forbidden", 403);
      } catch (error) {
        if (!(error instanceof BackendError)) throw error;
        failure ??= new BackendError("transfer_authority_changed", 403);
      }
      const member = (
        await db.query<DirectoryRow>("SELECT * FROM care_team_directory WHERE id=$1 FOR SHARE", [
          row.member_id,
        ])
      ).rows[0];
      if (
        !member ||
        member.revision !== row.destination_revision ||
        member.phone_number !== row.destination_number ||
        member.department_id !== row.department_id
      )
        failure ??= new BackendError("destination_changed", 409);
      if (row.mode === "twilio" && !failure) {
        try {
          validateDestination(row.destination_number, this.options.ownNumber);
          if (!call.provider_sid || call.provider_sid !== row.parent_sid || !this.options.provider)
            throw new BackendError("transfer_unavailable", 503);
        } catch (error) {
          if (!(error instanceof BackendError)) throw error;
          failure = error;
        }
      }
      if (failure) {
        await db.query(
          "UPDATE voice_transfers SET status='cancelled',last_error=$2,updated_at=$3 WHERE id=$1",
          [row.id, failure.code, this.now()],
        );
        await event(
          db,
          callId,
          "transfer_cancelled",
          this.now(),
          { transferId: row.id, reason: failure.code },
          `transfer_cancelled:${row.id}`,
        );
        return failure;
      }
      await db.query("UPDATE voice_transfers SET status='dispatching',updated_at=$2 WHERE id=$1", [
        row.id,
        this.now(),
      ]);
      await db.query(
        "UPDATE voice_calls SET status='transferring',stream_token_hash=NULL,updated_at=$2 WHERE id=$1",
        [callId, this.now()],
      );
      await event(
        db,
        callId,
        "transfer_confirmed",
        this.now(),
        { transferId: row.id, mode: row.mode },
        `transfer_confirmed:${row.id}`,
      );
      return row;
    });
    if (prepared instanceof BackendError) throw prepared;
    let status: VoiceTransfer["status"] = "dialing",
      reason: string | null = null;
    if (prepared.mode === "twilio") {
      try {
        await this.options.provider!.transfer({
          parentSid: prepared.parent_sid!,
          transferId: prepared.id,
          destination: prepared.destination_number!,
          name: prepared.destination_name,
        });
      } catch (error) {
        const uncertain = !(error instanceof TwilioDispatchError) || error.outcome === "uncertain";
        status = uncertain ? "reconciling" : "failed";
        reason = uncertain ? "transfer_dispatch_outcome_unknown" : "transfer_dispatch_rejected";
      }
    }
    await transaction(this.pool, async (db) => {
      await callRow(db, callId, true);
      const row = await transferRow(db, prepared.id, true);
      // Signed Dial callback can arrive before the SDK acknowledges the update.
      if (row.status !== "dispatching") return;
      await db.query(
        "UPDATE voice_transfers SET status=$2,last_error=$3,updated_at=$4 WHERE id=$1",
        [row.id, status, reason, this.now()],
      );
      if (status === "failed")
        await db.query(
          "UPDATE voice_calls SET status='failed',last_error=$2,updated_at=$3 WHERE id=$1 AND status='transferring'",
          [callId, reason, this.now()],
        );
      await event(
        db,
        callId,
        "transfer_dispatch",
        this.now(),
        { transferId: row.id, status, mode: row.mode, uncertain: status === "reconciling" },
        `transfer_dispatch:${row.id}`,
      );
    });
    const transfer = publicTransfer(await transferRow(this.pool, prepared.id));
    return {
      status:
        transfer.status === "reconciling"
          ? "transfer_reconciling"
          : transfer.status === "failed"
            ? "transfer_failed"
            : "transfer_dispatched",
      transfer,
    };
  }
  async result(id: string, input: { parentSid: string; childSid?: string; status: string }) {
    const map: Record<string, VoiceTransfer["status"]> = {
      completed: "connected",
      "no-answer": "no-answer",
      busy: "busy",
      failed: "failed",
      canceled: "cancelled",
    };
    const status = map[input.status];
    if (!status) throw new BackendError("invalid_transfer_status", 400);
    return this.finish(id, status, input);
  }
  async simulateResult(
    actor: Principal,
    id: string,
    status: "connected" | "no-answer" | "busy" | "failed",
  ) {
    const row = await transferRow(this.pool, id);
    const call = await callRow(this.pool, row.call_id);
    await visible(this.pool, actor, call, this.now());
    if (call.actor_id !== actor.id || row.mode !== "simulated")
      throw new BackendError("forbidden", 403);
    return this.finish(id, status);
  }
  private async finish(
    id: string,
    status: VoiceTransfer["status"],
    provider?: { parentSid: string; childSid?: string },
  ) {
    const initial = await transferRow(this.pool, id);
    return transaction(this.pool, async (db) => {
      const call = await callRow(db, initial.call_id, true);
      const row = await transferRow(db, id, true);
      if (provider) {
        if (
          row.mode !== "twilio" ||
          row.parent_sid !== provider.parentSid ||
          call.provider_sid !== provider.parentSid ||
          (provider.childSid &&
            (!/^CA[0-9a-f]{32}$/i.test(provider.childSid) ||
              (row.child_sid && row.child_sid !== provider.childSid)))
        )
          throw new BackendError("provider_sid_mismatch", 403);
      } else if (row.mode !== "simulated") throw new BackendError("forbidden", 403);
      if (row.status === "prepared" || (row.status === "cancelled" && row.last_error))
        throw new BackendError("invalid_transition", 409);
      if (finalStatuses.has(row.status)) {
        if (row.status !== status) throw new BackendError("transfer_result_conflict", 409);
        return publicTransfer(row);
      }
      await db.query(
        "UPDATE voice_transfers SET status=$2,child_sid=COALESCE(child_sid,$3),updated_at=$4,last_error=NULL WHERE id=$1",
        [id, status, provider?.childSid ?? null, this.now()],
      );
      if (!terminalCalls.has(call.status))
        await db.query(
          "UPDATE voice_calls SET status='completed',pending_action=NULL,stream_token_hash=NULL,updated_at=$2 WHERE id=$1",
          [call.id, this.now()],
        );
      await event(
        db,
        call.id,
        "transfer_result",
        this.now(),
        { transferId: id, status, mode: row.mode },
        `transfer_result:${id}`,
      );
      return publicTransfer(await transferRow(db, id));
    });
  }
}
