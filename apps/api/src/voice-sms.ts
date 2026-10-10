import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { Task } from "@prc/contracts";
import { BackendError, readWorkflow, transaction, type Database } from "./domain.js";
import { MockScheduler } from "./scheduler.js";
import {
  assignedTask,
  callRow,
  event,
  mask,
  requireActiveCall,
  visible,
  type CallRow,
} from "./voice-store-support.js";
import type { Principal } from "./identity.js";
import { spokenInterval } from "./voice-readback.js";
import {
  applySmsStatus,
  reconcileSmsEvidence,
  saveEarlySmsEvidence,
} from "./voice-sms-evidence.js";
import {
  readSmsAppUrl,
  SmsDispatchError,
  SMS_SID,
  smsProviderStatus,
  type SmsProvider,
} from "./twilio-sms.js";

export type SmsTemplate = "portal_link" | "request_status" | "appointment_summary";
export type SmsStatus =
  | "prepared"
  | "dispatching"
  | "accepted"
  | "sent"
  | "delivered"
  | "failed"
  | "unknown"
  | "simulated"
  | "cancelled";
export type SmsInput = { template: SmsTemplate; toolCallId: string; appointmentId?: string };
export type SmsPendingAction = {
  id: string;
  kind: "sms";
  input: { smsId: string };
  description: string;
  expiresAt: string;
};
type SmsRow = {
  id: string;
  call_id: string;
  tool_call_id: string;
  template: SmsTemplate | "emergency_verification";
  appointment_id: string | null;
  actor_id: string | null;
  mode: "simulated" | "twilio";
  recipient_number: string | null;
  body: string;
  content_fingerprint: string;
  status: SmsStatus;
  provider_sid: string | null;
  provider_error_code: string | null;
  last_error: string | null;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
  confirmed_at: Date | null;
};
export type VoiceSmsMessage = ReturnType<typeof publicSms>;
function publicSms(row: SmsRow) {
  return {
    id: row.id,
    callId: row.call_id,
    template: row.template,
    mode: row.mode,
    status: row.status,
    body: row.body,
    maskedRecipient: row.recipient_number ? mask(row.recipient_number) : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    lastError: row.last_error,
  };
}
function parseInput(raw: unknown): SmsInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new BackendError("invalid_input", 400);
  const input = raw as Record<string, unknown>;
  if (
    Object.keys(input).some((key) => !["template", "toolCallId", "appointmentId"].includes(key)) ||
    !["portal_link", "request_status", "appointment_summary"].includes(String(input.template)) ||
    typeof input.toolCallId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(input.toolCallId) ||
    (input.appointmentId !== undefined &&
      (typeof input.appointmentId !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(input.appointmentId))) ||
    (input.template === "appointment_summary"
      ? !input.appointmentId
      : input.appointmentId !== undefined)
  )
    throw new BackendError("invalid_input", 400);
  return input as SmsInput;
}
function activeCall(call: CallRow) {
  if (!["awaiting_verification", "in_progress"].includes(call.status))
    throw new BackendError("call_not_active", 409);
}
function destination(call: CallRow & { caller_number?: string | null }) {
  return call.direction === "outbound" ? call.recipient_number : (call.caller_number ?? null);
}
function pendingFor(row: SmsRow): SmsPendingAction {
  const recipient = row.recipient_number
    ? `to your phone ending ${row.recipient_number.slice(-4)}`
    : "in this simulation";
  // The immutable SMS body remains available in the tool result and monitor.
  // Spoken confirmation identifies its purpose and appointment facts, not its URL or footer.
  const summary = row.body
    .replace(/^Health Coordinator demo: /, "")
    .replace(/ https:\/\/\S+\/patient\. Reply STOP to opt out\.$/, "")
    .replace(/ This text does not confirm an appointment change\.$/, "")
    .replace(/ This is the current booking, not a proposed change\.$/, "")
    .replace(/^Your fictional appointment request is /, "Your request is ")
    .replace(/^Your current appointment in this fictional demo: /, "");
  const description =
    row.template === "portal_link"
      ? `Send a link to your patient portal ${recipient}.`
      : row.template === "request_status"
        ? `Text this request update ${recipient}: ${summary}`
        : `Text your current appointment ${recipient}: ${summary}`;
  return {
    id: row.id,
    kind: "sms",
    input: { smsId: row.id },
    expiresAt: row.expires_at.toISOString(),
    description: `${row.mode === "simulated" ? "Simulated text only. " : ""}${description}`,
  };
}
async function smsRow(db: Database, id: string, lock = false) {
  const row = (
    await db.query<SmsRow>(`SELECT * FROM voice_sms WHERE id=$1${lock ? " FOR UPDATE" : ""}`, [id])
  ).rows[0];
  if (!row) throw new BackendError("not_found", 404);
  return row;
}
const stateLabels: Record<Task["state"], string> = {
  awaiting_verification: "awaiting verification",
  awaiting_proposal: "awaiting a proposal",
  awaiting_staff_approval: "awaiting staff approval",
  awaiting_patient_confirmation: "awaiting your confirmation",
  ready_to_execute: "approved and waiting for the booking update",
  executing: "booking update in progress",
  reconciling: "booking update outcome being checked",
  completed: "completed",
  withdrawn: "withdrawn",
  staff_takeover: "with the care team",
};

export class VoiceSms {
  readonly now: () => Date;
  readonly appUrl: string | undefined;
  readonly scheduler: MockScheduler;
  constructor(
    readonly pool: Pool,
    readonly options: { now?: () => Date; provider?: SmsProvider; appUrl?: string } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.appUrl =
      options.appUrl === undefined
        ? readSmsAppUrl()
        : readSmsAppUrl({ SMS_APP_URL: options.appUrl });
    this.scheduler = new MockScheduler(pool, { now: this.now });
  }
  private async content(db: Database, call: CallRow, input: SmsInput) {
    activeCall(call);
    let text = "Open your fictional patient portal";
    let snapshot = "portal";
    if (input.template !== "portal_link") {
      const actor = await requireActiveCall(db, call, this.now());
      if (actor.role !== "patient") throw new BackendError("forbidden", 403);
      if (input.template === "request_status") {
        if (!call.task_id) throw new BackendError("request_context_required", 409);
        const task = await assignedTask(db, actor, call.task_id, this.now());
        text = `Your fictional appointment request is ${stateLabels[task.state]}.`;
        if (task.state === "completed") {
          const workflow = await readWorkflow(db, task.id);
          const receipt = (
            await db.query(
              "SELECT result FROM booking_operations WHERE id=$1 AND task_id=$2 AND status='confirmed'",
              [workflow.operationId, task.id],
            )
          ).rows[0]?.result;
          if (receipt?.status !== "confirmed" || !receipt.confirmationRef)
            throw new BackendError("booking_evidence_missing", 409);
          text += " The scheduler confirmed the appointment change.";
        } else text += " This text does not confirm an appointment change.";
        snapshot = JSON.stringify({ taskId: task.id, revision: task.revision, state: task.state });
      } else {
        const booking = await this.scheduler.getBooking(input.appointmentId!, db);
        if (!booking || booking.patientId !== actor.patientId)
          throw new BackendError("not_found", 404);
        text = `Your current appointment in this fictional demo: ${spokenInterval(booking.startsAt, booking.endsAt, "America/Halifax")}. This is the current booking, not a proposed change.`;
        snapshot = JSON.stringify(booking);
      }
    }
    if (!this.appUrl) throw new BackendError("sms_portal_unconfigured", 503);
    const body = `Health Coordinator demo: ${text} ${this.appUrl}/patient. Reply STOP to opt out.`;
    if (body.length > 1000) throw new BackendError("sms_content_invalid", 409);
    return {
      body,
      fingerprint: createHash("sha256")
        .update(snapshot + "\n" + body)
        .digest("hex"),
    };
  }
  async prepare(callId: string, raw: unknown) {
    const input = parseInput(raw);
    return transaction(this.pool, async (db) => {
      const call = await callRow(db, callId, true);
      const existing = (
        await db.query<SmsRow>("SELECT * FROM voice_sms WHERE call_id=$1 AND tool_call_id=$2", [
          callId,
          input.toolCallId,
        ])
      ).rows[0];
      if (
        existing &&
        (existing.template !== input.template ||
          existing.appointment_id !== (input.appointmentId ?? null))
      )
        throw new BackendError("sms_tool_conflict", 409);
      const content = await this.content(db, call, input);
      if (existing)
        return {
          status:
            existing.status === "prepared"
              ? ("awaiting_explicit_confirmation" as const)
              : existing.status,
          pendingAction: existing.status === "prepared" ? pendingFor(existing) : null,
          sms: publicSms(existing),
        };
      if (call.pending_action && Date.parse(call.pending_action.expiresAt) > this.now().getTime())
        throw new BackendError("pending_action_exists", 409);
      const to = destination(call);
      if (
        call.mode === "twilio" &&
        (!to || !mask(to) || !call.provider_sid || !/^CA[0-9a-f]{32}$/i.test(call.provider_sid))
      )
        throw new BackendError("sms_caller_number_unavailable", 409);
      if (call.mode === "twilio" && !this.options.provider)
        throw new BackendError("sms_unavailable", 503);
      await db.query(
        "UPDATE voice_sms SET status='cancelled',last_error='action_expired',updated_at=$2 WHERE call_id=$1 AND status='prepared'",
        [callId, this.now()],
      );
      const id = randomUUID();
      const expiresAt = new Date(this.now().getTime() + 300_000);
      await db.query(
        `INSERT INTO voice_sms(id,call_id,tool_call_id,template,appointment_id,actor_id,mode,recipient_number,body,content_fingerprint,status,expires_at,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'prepared',$11,$12,$12)`,
        [
          id,
          callId,
          input.toolCallId,
          input.template,
          input.appointmentId ?? null,
          call.actor_id,
          call.mode,
          to,
          content.body,
          content.fingerprint,
          expiresAt,
          this.now(),
        ],
      );
      const row = await smsRow(db, id);
      const pendingAction = pendingFor(row);
      await db.query("UPDATE voice_calls SET pending_action=$2,updated_at=$3 WHERE id=$1", [
        callId,
        pendingAction,
        this.now(),
      ]);
      await event(
        db,
        callId,
        "sms_prepared",
        this.now(),
        { actionId: id, mode: call.mode },
        `sms_prepared:${id}`,
      );
      return {
        status: "awaiting_explicit_confirmation" as const,
        pendingAction,
        sms: publicSms(row),
      };
    });
  }
  async confirm(callId: string, id: string): Promise<{ status: SmsStatus; sms: VoiceSmsMessage }> {
    const prepared = await transaction(this.pool, async (db) => {
      const call = await callRow(db, callId, true);
      const row = await smsRow(db, id, true);
      if (row.template === "emergency_verification")
        throw new BackendError("verification_sms_not_pending_action", 409);
      if (row.call_id !== callId) throw new BackendError("not_found", 404);
      if (row.status !== "prepared") return { send: false, row };
      if (
        !call.pending_action ||
        call.pending_action.kind !== "sms" ||
        call.pending_action.id !== id
      )
        throw new BackendError("pending_action_missing", 409);
      await db.query("UPDATE voice_calls SET pending_action=NULL,updated_at=$2 WHERE id=$1", [
        callId,
        this.now(),
      ]);
      try {
        activeCall(call);
        if (row.expires_at <= this.now()) throw new BackendError("pending_action_expired", 409);
        if (row.template !== "portal_link" && row.actor_id !== call.actor_id)
          throw new BackendError("voice_unverified", 401);
        if (destination(call) !== row.recipient_number)
          throw new BackendError("sms_destination_changed", 409);
        const current = await this.content(db, call, {
          template: row.template,
          toolCallId: row.tool_call_id,
          ...(row.appointment_id ? { appointmentId: row.appointment_id } : {}),
        });
        if (current.fingerprint !== row.content_fingerprint)
          throw new BackendError("sms_content_changed", 409);
        if (row.mode === "twilio" && !this.options.provider)
          throw new BackendError("sms_unavailable", 503);
      } catch (error) {
        if (!(error instanceof BackendError)) throw error;
        await db.query(
          "UPDATE voice_sms SET status='cancelled',last_error=$2,updated_at=$3 WHERE id=$1",
          [id, error.code, this.now()],
        );
        await event(
          db,
          callId,
          "sms_cancelled",
          this.now(),
          { actionId: id, reason: error.code },
          `sms_cancelled:${id}`,
        );
        return error;
      }
      await db.query(
        "UPDATE voice_sms SET status='dispatching',confirmed_at=$2,updated_at=$2 WHERE id=$1",
        [id, this.now()],
      );
      await event(
        db,
        callId,
        "sms_confirmed",
        this.now(),
        { actionId: id, mode: row.mode },
        `sms_confirmed:${id}`,
      );
      return { send: true, row };
    });
    if (prepared instanceof BackendError) throw prepared;
    if (!prepared.send) return { status: prepared.row.status, sms: publicSms(prepared.row) };
    let status: SmsStatus = "simulated",
      sid: string | null = null,
      errorCode: string | null = null,
      reason: string | null = null;
    if (prepared.row.mode === "twilio") {
      try {
        const ack = await this.options.provider!.send({
          smsId: id,
          to: prepared.row.recipient_number!,
          body: prepared.row.body,
        });
        if (!SMS_SID.test(ack.sid) || !Object.hasOwn(smsProviderStatus, ack.status))
          throw new SmsDispatchError("uncertain");
        sid = ack.sid;
        status = smsProviderStatus[ack.status]!;
        if (status === "failed") reason = "sms_provider_failed";
      } catch (error) {
        const uncertain = !(error instanceof SmsDispatchError) || error.outcome === "uncertain";
        status = uncertain ? "unknown" : "failed";
        errorCode = error instanceof SmsDispatchError ? (error.providerCode ?? null) : null;
        reason = uncertain
          ? "sms_dispatch_outcome_unknown"
          : errorCode === "21610"
            ? "sms_recipient_opted_out"
            : "sms_dispatch_rejected";
      }
    }
    await transaction(this.pool, async (db) => {
      await callRow(db, callId, true);
      const row = await smsRow(db, id, true);
      if (row.status !== "dispatching" && row.status !== "unknown") return;
      await db.query(
        "UPDATE voice_sms SET status=$2,provider_sid=$3,provider_error_code=$4,last_error=$5,updated_at=$6 WHERE id=$1",
        [id, status, sid, errorCode, reason, this.now()],
      );
      await event(
        db,
        callId,
        "sms_dispatch",
        this.now(),
        { actionId: id, status, mode: row.mode, uncertain: status === "unknown" },
        `sms_dispatch:${id}`,
      );
      if (sid) await reconcileSmsEvidence(db, { ...row, status }, sid, this.now());
    });
    const sms = publicSms(await smsRow(this.pool, id));
    return { status: sms.status, sms };
  }
  async cancel(callId: string, id: string) {
    return transaction(this.pool, async (db) => {
      const call = await callRow(db, callId, true);
      const row = await smsRow(db, id, true);
      if (row.call_id !== callId) throw new BackendError("not_found", 404);
      if (row.status !== "prepared") return publicSms(row);
      await db.query(
        "UPDATE voice_sms SET status='cancelled',last_error='caller_cancelled',updated_at=$2 WHERE id=$1",
        [id, this.now()],
      );
      if (call.pending_action?.id === id)
        await db.query("UPDATE voice_calls SET pending_action=NULL,updated_at=$2 WHERE id=$1", [
          callId,
          this.now(),
        ]);
      await event(
        db,
        callId,
        "sms_cancelled",
        this.now(),
        { actionId: id, reason: "caller_cancelled" },
        `sms_cancelled:${id}`,
      );
      return publicSms(await smsRow(db, id));
    });
  }
  /** Only the signature-validated route may invoke this. Never adopt a callback SID. */
  async result(id: string, input: { messageSid: string; status: string; errorCode?: string }) {
    if (!Object.hasOwn(smsProviderStatus, input.status))
      throw new BackendError("invalid_sms_status", 400);
    const initial = await smsRow(this.pool, id);
    return transaction(this.pool, async (db) => {
      await callRow(db, initial.call_id, true);
      const row = await smsRow(db, id, true);
      const next = smsProviderStatus[input.status]!;
      if (
        row.mode === "twilio" &&
        !row.provider_sid &&
        row.confirmed_at &&
        ["dispatching", "unknown"].includes(row.status) &&
        SMS_SID.test(input.messageSid)
      ) {
        await saveEarlySmsEvidence(db, id, input.messageSid, next, input.errorCode, this.now());
        return publicSms(row);
      }
      if (
        row.mode !== "twilio" ||
        !row.provider_sid ||
        !SMS_SID.test(input.messageSid) ||
        row.provider_sid !== input.messageSid
      )
        throw new BackendError("provider_sid_mismatch", 403);
      if (["prepared", "cancelled", "simulated"].includes(row.status))
        throw new BackendError("invalid_transition", 409);
      await applySmsStatus(db, row, next, input.errorCode, this.now());
      return publicSms(await smsRow(db, id));
    });
  }
  async list(actor: Principal, callId: string) {
    const call = await callRow(this.pool, callId);
    await visible(this.pool, actor, call, this.now());
    return (
      await this.pool.query<SmsRow>(
        "SELECT * FROM voice_sms WHERE call_id=$1 ORDER BY created_at,id",
        [callId],
      )
    ).rows.map(publicSms);
  }
  async reconcileStale() {
    const cutoff = new Date(this.now().getTime() - 60_000);
    const stale = (
      await this.pool.query<SmsRow>(
        "SELECT * FROM voice_sms WHERE status='dispatching' AND updated_at<=$1 LIMIT 100",
        [cutoff],
      )
    ).rows;
    for (const item of stale)
      await transaction(this.pool, async (db) => {
        await callRow(db, item.call_id, true);
        const row = await smsRow(db, item.id, true);
        if (row.status !== "dispatching" || row.updated_at > cutoff) return;
        await db.query(
          "UPDATE voice_sms SET status='unknown',last_error='sms_dispatch_outcome_unknown',updated_at=$2 WHERE id=$1",
          [row.id, this.now()],
        );
        await event(
          db,
          row.call_id,
          "sms_dispatch_unknown",
          this.now(),
          { actionId: row.id, status: "unknown", uncertain: true },
          `sms_dispatch_unknown:${row.id}`,
        );
      });
  }
}
