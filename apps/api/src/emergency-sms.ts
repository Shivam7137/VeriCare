import type { Pool } from "pg";
import { transaction } from "./domain.js";
import { callRow, event } from "./voice-store-support.js";
import { reconcileSmsEvidence } from "./voice-sms-evidence.js";
import { SMS_SID, SmsDispatchError, smsProviderStatus, type SmsProvider } from "./twilio-sms.js";

/** The OTP body exists only in memory and the provider request, never stored message previews. */
export async function dispatchEmergencySms(
  pool: Pool,
  provider: SmsProvider,
  input: { smsId: string; callId: string; to: string; body: string },
  now: () => Date,
) {
  let status = "unknown",
    sid: string | null = null,
    reason: string | null = null;
  let errorCode: string | null = null;
  try {
    const ack = await provider.send(input);
    if (!SMS_SID.test(ack.sid) || !Object.hasOwn(smsProviderStatus, ack.status))
      throw new SmsDispatchError("uncertain");
    sid = ack.sid;
    status = smsProviderStatus[ack.status]!;
    if (status === "failed") reason = "sms_provider_failed";
  } catch (error) {
    const uncertain = !(error instanceof SmsDispatchError) || error.outcome === "uncertain";
    status = uncertain ? "unknown" : "failed";
    errorCode = error instanceof SmsDispatchError ? (error.providerCode ?? null) : null;
    reason = uncertain ? "sms_dispatch_outcome_unknown" : "sms_dispatch_rejected";
  }
  await transaction(pool, async (db) => {
    await callRow(db, input.callId, true);
    const row = (
      await db.query("SELECT id,call_id,status FROM voice_sms WHERE id=$1 FOR UPDATE", [
        input.smsId,
      ])
    ).rows[0]!;
    if (!["dispatching", "unknown"].includes(row.status)) return;
    await db.query(
      "UPDATE voice_sms SET status=$2,provider_sid=$3,last_error=$4,provider_error_code=$5,updated_at=$6 WHERE id=$1",
      [input.smsId, status, sid, reason, errorCode, now()],
    );
    await event(db, input.callId, "emergency_code_sms", now(), {
      actionId: input.smsId,
      status,
      uncertain: status === "unknown",
    });
    if (sid) await reconcileSmsEvidence(db, { ...row, status }, sid, now());
  });
}
