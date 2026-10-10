import { createHash, randomUUID } from "node:crypto";
import type { Task } from "@prc/contracts";
import { BackendError, lockTask, readWorkflow, type Database } from "./domain.js";
import { getPrincipal, requirePatientAccess, type Principal } from "./identity.js";

export type PendingVoiceAction = {
  id: string;
  kind: "create_request" | "callback" | "confirm" | "withdraw";
  input: Record<string, unknown>;
  description: string;
  expiresAt: string;
};
export type VoiceCall = {
  id: string;
  taskId: string | null;
  actorId: string | null;
  mode: "simulated" | "twilio";
  direction: "inbound" | "outbound";
  status:
    | "awaiting_verification"
    | "queued"
    | "dialing"
    | "ringing"
    | "in_progress"
    | "completed"
    | "failed"
    | "cancelled"
    | "reconciling"
    | "handoff";
  createdAt: string;
  updatedAt: string;
  dueAt: string | null;
  maskedNumber: string | null;
  lastError: string | null;
  pendingAction: PendingVoiceAction | null;
  providerSid: string | null;
  events?: { id: string; kind: string; detail: Record<string, unknown>; occurredAt: string }[];
};

export type CallRow = {
  id: string;
  task_id: string | null;
  actor_id: string | null;
  mode: VoiceCall["mode"];
  direction: VoiceCall["direction"];
  status: VoiceCall["status"];
  created_at: Date;
  updated_at: Date;
  due_at: Date | null;
  recipient_number: string | null;
  masked_number: string | null;
  last_error: string | null;
  pending_action: PendingVoiceAction | null;
  provider_sid: string | null;
  verified_at: Date | null;
  verification_failures: number;
  stream_token_hash: string | null;
  stream_expires_at: Date | null;
  stream_claimed_at: Date | null;
};

export const terminalCalls = new Set<VoiceCall["status"]>([
  "completed",
  "failed",
  "cancelled",
  "handoff",
]);

export function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function publicCall(row: CallRow): VoiceCall {
  return {
    id: row.id,
    taskId: row.task_id,
    actorId: row.actor_id,
    mode: row.mode,
    direction: row.direction,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    dueAt: row.due_at?.toISOString() ?? null,
    maskedNumber: row.masked_number,
    lastError: row.last_error,
    pendingAction: row.pending_action,
    providerSid: row.provider_sid,
  };
}

export function mask(number: string) {
  return /^\+[1-9]\d{7,14}$/.test(number) ? `***${number.slice(-4)}` : null;
}

export function safeReason(reason: string) {
  return /^[a-zA-Z][a-zA-Z0-9_.:-]{0,119}$/.test(reason) ? reason : "voice_error";
}

export async function callRow(db: Database, id: string, lock = false): Promise<CallRow> {
  const result = await db.query<CallRow>(
    `SELECT * FROM voice_calls WHERE id=$1${lock ? " FOR UPDATE" : ""}`,
    [id],
  );
  if (!result.rows[0]) throw new BackendError("not_found", 404);
  return result.rows[0];
}

export async function currentPatient(db: Database, id: string) {
  const actor = await getPrincipal(db, id);
  if (!actor.active || !actor.verified || actor.role !== "patient")
    throw new BackendError("unauthorized", 401);
  return actor;
}

export async function assignedTask(db: Database, actor: Principal, id: string, now: Date) {
  const task = await lockTask(db, id);
  await requirePatientAccess(db, actor, task.patientId, now);
  if (task.requesterId !== actor.id) throw new BackendError("forbidden", 403);
  return task;
}

export async function mutableTask(db: Database, task: Task) {
  const workflow = await readWorkflow(db, task.id);
  if (
    ![
      "awaiting_verification",
      "awaiting_proposal",
      "awaiting_staff_approval",
      "awaiting_patient_confirmation",
      "ready_to_execute",
    ].includes(task.state) ||
    workflow.takeoverRequested ||
    workflow.withdrawalRequested
  )
    throw new BackendError("request_stopped", 409);
  return workflow;
}

export async function boundActor(db: Database, row: CallRow, now: Date) {
  if (!row.actor_id || !row.verified_at) throw new BackendError("voice_unverified", 401);
  const actor = await currentPatient(db, row.actor_id);
  if (row.task_id) await assignedTask(db, actor, row.task_id, now);
  return actor;
}

export async function requireActiveCall(db: Database, row: CallRow, now: Date) {
  const actor = await boundActor(db, row, now);
  if (terminalCalls.has(row.status)) throw new BackendError("call_ended", 409);
  return actor;
}

export async function requireOpen(db: Database, row: CallRow, now: Date) {
  const actor = await requireActiveCall(db, row, now);
  if (row.task_id) await mutableTask(db, await assignedTask(db, actor, row.task_id, now));
  return actor;
}

export async function visible(db: Database, actor: Principal, row: CallRow, now: Date) {
  const current = await getPrincipal(db, actor.id);
  if (!current.active || !current.verified) throw new BackendError("unauthorized", 401);
  if (current.role === "patient") {
    if (row.actor_id !== current.id) throw new BackendError("not_found", 404);
    if (row.task_id) await assignedTask(db, current, row.task_id, now);
  } else {
    const patient = row.task_id
      ? (await db.query("SELECT payload->>'patientId' AS id FROM tasks WHERE id=$1", [row.task_id]))
          .rows[0]
      : (await db.query("SELECT patient_id AS id FROM principals WHERE id=$1", [row.actor_id]))
          .rows[0];
    if (!patient?.id) throw new BackendError("not_found", 404);
    await requirePatientAccess(db, current, patient.id, now);
  }
}

// Only operational metadata belongs in the audit trail; no audio, transcripts or secrets.
export async function event(
  db: Database,
  id: string,
  kind: string,
  now: Date,
  detail: Record<string, unknown> = {},
  dedupeKey?: string,
) {
  const safeDetail = Object.fromEntries(
    Object.entries(detail).filter(
      ([key, value]) =>
        /^(actionId|taskId|kind|tool|reason|status|action|attempts|uncertain)$/.test(key) &&
        (typeof value === "boolean" ||
          typeof value === "number" ||
          (typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value))),
    ),
  );
  await db.query(
    `INSERT INTO voice_events (id,call_id,kind,detail,dedupe_key,occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (call_id,dedupe_key) DO NOTHING`,
    [randomUUID(), id, safeReason(kind), safeDetail, dedupeKey ?? null, now],
  );
}
