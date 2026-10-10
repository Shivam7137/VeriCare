import type { Database } from "./domain.js";
import { event } from "./voice-store-support.js";

type DeliveryStatus = "accepted" | "sent" | "delivered" | "failed";
type SmsState = { id: string; call_id: string; status: string };
const rank: Record<string, number> = {
  dispatching: 0,
  unknown: 0,
  accepted: 1,
  sent: 2,
  delivered: 3,
  failed: 3,
};
const safeCode = (value?: string | null) => (value && /^\d{4,6}$/.test(value) ? value : null);

/** Caller holds the call and SMS row locks. Storage cannot grow beyond 16 events per message. */
export async function saveEarlySmsEvidence(
  db: Database,
  id: string,
  sid: string,
  status: DeliveryStatus,
  errorCode: string | undefined,
  now: Date,
) {
  await db.query(
    `INSERT INTO voice_sms_status_evidence(sms_id,message_sid,status,error_code,received_at)
     SELECT $1,$2,$3,$4,$5 WHERE (SELECT count(*) FROM voice_sms_status_evidence WHERE sms_id=$1)<16
     ON CONFLICT(sms_id,message_sid,status) DO NOTHING`,
    [id, sid, status, safeCode(errorCode), now],
  );
}

/** Shared monotonic transition for callbacks received before or after acknowledgement. */
export async function applySmsStatus(
  db: Database,
  row: SmsState,
  next: DeliveryStatus,
  rawCode: string | null | undefined,
  now: Date,
): Promise<string> {
  if (["delivered", "failed"].includes(row.status) || (rank[next] ?? 0) < (rank[row.status] ?? 0))
    return row.status;
  const errorCode = safeCode(rawCode);
  const reason =
    next === "failed"
      ? errorCode === "21610"
        ? "sms_recipient_opted_out"
        : "sms_provider_failed"
      : null;
  await db.query(
    "UPDATE voice_sms SET status=$2,provider_error_code=$3,last_error=$4,updated_at=$5 WHERE id=$1",
    [row.id, next, errorCode, reason, now],
  );
  await event(
    db,
    row.call_id,
    "sms_status",
    now,
    { actionId: row.id, status: next },
    `sms_status:${row.id}:${next}`,
  );
  return next;
}

/** Runs inside the same transaction that stores the REST-acknowledged SID. */
export async function reconcileSmsEvidence(
  db: Database,
  row: SmsState,
  acknowledgedSid: string,
  now: Date,
) {
  const evidence = (
    await db.query<{ status: DeliveryStatus; error_code: string | null }>(
      "SELECT status,error_code FROM voice_sms_status_evidence WHERE sms_id=$1 AND message_sid=$2 ORDER BY id",
      [row.id, acknowledgedSid],
    )
  ).rows;
  let state = row;
  for (const item of evidence)
    state = {
      ...state,
      status: await applySmsStatus(db, state, item.status, item.error_code, now),
    };
  // Discard unrelated SIDs as well; they never changed the public status or SID.
  await db.query("DELETE FROM voice_sms_status_evidence WHERE sms_id=$1", [row.id]);
}
