import { randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import {
  emergencyCodeInputSchema,
  emergencyContactInputSchema,
  emergencyPatientInputSchema,
} from "@prc/contracts";
import { BackendError, transaction, type Database } from "./domain.js";
import { callRow, event, hash, mask, requireActiveSession } from "./voice-store-support.js";
import type { SmsProvider } from "./twilio-sms.js";
import { dispatchEmergencySms } from "./emergency-sms.js";

type PatientRecord = {
  patient_id: string;
  display_name: string;
  date_of_birth: string;
  contact_name: string;
  contact_relationship: string;
  contact_number: string | null;
  facility: string;
  department: string;
  area: string;
  visitor_instructions: string;
  location_shareable: boolean;
};
type Session = {
  patient_id: string | null;
  lookup_attempts: number;
  verification_failures: number;
  verified_until: Date | null;
  contact_fingerprint: string | null;
};
type Challenge = {
  sms_id: string;
  patient_id: string;
  code_hash: string;
  contact_fingerprint: string;
  expires_at: Date;
  consumed_at: Date | null;
  invalidated_at: Date | null;
  created_at: Date;
  status: string;
  recipient_number: string | null;
};
const normalize = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();
const digitWords: Record<string, string> = {
  zero: "0",
  oh: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
};
const fingerprint = (patient: PatientRecord) =>
  hash(
    JSON.stringify([
      patient.patient_id,
      patient.display_name,
      patient.date_of_birth,
      normalize(patient.contact_name),
      normalize(patient.contact_relationship),
      patient.contact_number,
      patient.location_shareable,
    ]),
  );
const locked = () => ({
  status: "verification_locked",
  message:
    "The code could not be verified after five attempts. Please contact the hospital reception team for help.",
});
const needPatient = () => ({
  status: "patient_details_required",
  message: "Ask for the patient's full name and date of birth before looking up a location.",
});
const needContact = () => ({
  status: "contact_verification_required",
  message:
    "Ask the caller's full name and relationship, then send a code to the registered contact. Do not ask for a staff or portal code.",
});

export class EmergencyLookup {
  readonly now: () => Date;
  constructor(
    readonly pool: Pool,
    readonly options: { now?: () => Date; provider?: SmsProvider } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }
  private async active(db: Database, callId: string) {
    const call = await callRow(db, callId, true);
    await requireActiveSession(db, call, this.now());
    if (!call.department_id) throw new BackendError("emergency_department_required", 409);
    return call;
  }
  private async session(db: Database, callId: string) {
    return (
      await db.query<Session>("SELECT * FROM voice_emergency_sessions WHERE call_id=$1", [callId])
    ).rows[0];
  }
  private async patient(db: Database, patientId: string, departmentId: string) {
    return (
      await db.query<PatientRecord>(
        `SELECT r.*,r.date_of_birth::text,p.display_name FROM emergency_patient_records r
       JOIN patients p ON p.id=r.patient_id WHERE r.patient_id=$1 AND p.department_id=$2`,
        [patientId, departmentId],
      )
    ).rows[0];
  }
  private async challenge(db: Database, callId: string, smsId?: string) {
    return (
      await db.query<Challenge>(
        `SELECT c.*,s.status,s.recipient_number FROM voice_emergency_codes c JOIN voice_sms s ON s.id=c.sms_id
       WHERE c.call_id=$1 ${smsId ? "AND c.sms_id=$2" : ""} ORDER BY c.created_at DESC,c.sms_id DESC LIMIT 1`,
        smsId ? [callId, smsId] : [callId],
      )
    ).rows[0];
  }
  private async clearVerification(db: Database, callId: string, clearPatient = false) {
    await db.query(
      `UPDATE voice_emergency_sessions SET verified_until=NULL,contact_fingerprint=NULL,
       patient_id=CASE WHEN $3 THEN NULL ELSE patient_id END,updated_at=$2 WHERE call_id=$1`,
      [callId, this.now(), clearPatient],
    );
    await db.query(
      "UPDATE voice_emergency_codes SET invalidated_at=$2 WHERE call_id=$1 AND invalidated_at IS NULL",
      [callId, this.now()],
    );
  }
  private codeResult(challenge: Challenge) {
    if (challenge.status === "failed")
      return {
        status: "code_send_failed",
        message:
          "The verification text could not be sent. Do not claim it was delivered. Offer a requested resend or help from hospital reception.",
      };
    if (challenge.invalidated_at || challenge.expires_at <= this.now())
      return {
        status: "code_expired",
        message: "That code has expired. Ask whether the caller wants a new verification text.",
      };
    return {
      status: "authorization_required",
      scope: "emergency_contact",
      method: "speech_or_keypad",
      digits: 8,
      smsStatus: challenge.status,
      maskedRecipient: challenge.recipient_number ? mask(challenge.recipient_number) : null,
      message:
        challenge.status === "unknown"
          ? "The text's sending status is uncertain. If a code arrives, read its eight digits aloud one at a time or enter them on the keypad. Do not send again automatically."
          : `The verification text is ${challenge.status === "delivered" ? "delivered" : "queued"} to the registered phone ending ${challenge.recipient_number?.slice(-4)}. Ask the caller to read the eight digits aloud one at a time or use the keypad. Do not ask for a portal or staff code.`,
    };
  }
  async identify(callId: string, raw: unknown) {
    const input = emergencyPatientInputSchema.parse(raw);
    return transaction(this.pool, async (db) => {
      const call = await this.active(db, callId);
      const prior = await this.session(db, callId);
      if (prior && prior.lookup_attempts >= 10) {
        await this.clearVerification(db, callId, true);
        return {
          status: "patient_lookup_limit",
          message:
            "I could not match the patient details. Please contact hospital reception for help.",
        };
      }
      const rows = (
        await db.query<{ patient_id: string }>(
          `SELECT r.patient_id FROM emergency_patient_records r JOIN patients p ON p.id=r.patient_id
         WHERE p.department_id=$1 AND lower(regexp_replace(btrim(p.display_name),'[[:space:]]+',' ','g'))=$2
         AND r.date_of_birth=$3::date LIMIT 2`,
          [call.department_id, normalize(input.patientName), input.dateOfBirth],
        )
      ).rows;
      const patientId = rows.length === 1 ? rows[0]!.patient_id : null;
      const changed = !patientId || patientId !== prior?.patient_id;
      await db.query(
        `INSERT INTO voice_emergency_sessions(call_id,patient_id,lookup_attempts,updated_at) VALUES ($1,$2,1,$3)
        ON CONFLICT(call_id) DO UPDATE SET patient_id=$2,lookup_attempts=voice_emergency_sessions.lookup_attempts+1,
        verified_until=CASE WHEN $4 THEN NULL ELSE voice_emergency_sessions.verified_until END,
        contact_fingerprint=CASE WHEN $4 THEN NULL ELSE voice_emergency_sessions.contact_fingerprint END,updated_at=$3`,
        [callId, patientId, this.now(), changed],
      );
      if (changed)
        await db.query(
          "UPDATE voice_emergency_codes SET invalidated_at=$2 WHERE call_id=$1 AND invalidated_at IS NULL",
          [callId, this.now()],
        );
      await event(db, callId, "emergency_patient_match", this.now(), {
        status: patientId ? "matched" : "not_matched",
      });
      return patientId
        ? {
            status: "patient_matched",
            message:
              "The name and date of birth match a demo record. Now ask the caller's full name and relationship. Do not disclose the patient's location or registered contact details yet.",
          }
        : {
            status: "patient_not_matched",
            message:
              "I couldn't match those details. Please check the patient's full name and date of birth. Do not guess or suggest other patients.",
          };
    });
  }
  async sendCode(callId: string, toolCallId: string, raw: unknown) {
    const input = emergencyContactInputSchema.parse(raw);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(toolCallId)) throw new BackendError("invalid_input", 400);
    const prepared = await transaction(this.pool, async (db) => {
      const call = await this.active(db, callId),
        session = await this.session(db, callId);
      if (!session?.patient_id) return { result: needPatient() };
      if (session.verification_failures >= 5) return { result: locked() };
      const patient = await this.patient(db, session.patient_id, call.department_id!);
      if (!patient) return { result: needPatient() };
      if (
        normalize(input.contactName) !== normalize(patient.contact_name) ||
        normalize(input.relationship) !== normalize(patient.contact_relationship)
      ) {
        await this.clearVerification(db, callId);
        return {
          result: {
            status: "contact_not_matched",
            message:
              "Those contact details don't match the registered emergency contact. Please check your full name and relationship. Do not reveal the registered details.",
          },
        };
      }
      if (!patient.contact_number || !this.options.provider || call.mode !== "twilio")
        return {
          result: {
            status: "code_unavailable",
            message:
              "Verification texts are not configured for this call. Do not claim a code was sent.",
          },
        };
      const contactFingerprint = fingerprint(patient);
      if (
        session.verified_until &&
        session.verified_until > this.now() &&
        session.contact_fingerprint === contactFingerprint
      )
        return {
          result: {
            status: "verified",
            role: "emergency_contact",
            message:
              "This contact is already verified for this patient. Call get_emergency_patient_location.",
          },
        };
      const replay = (
        await db.query<{ id: string }>(
          "SELECT id FROM voice_sms WHERE call_id=$1 AND tool_call_id=$2",
          [callId, toolCallId],
        )
      ).rows[0];
      if (replay) {
        const challenge = await this.challenge(db, callId, replay.id);
        if (
          !challenge ||
          challenge.patient_id !== patient.patient_id ||
          challenge.contact_fingerprint !== contactFingerprint
        )
          throw new BackendError("sms_tool_conflict", 409);
        return { result: this.codeResult(challenge) };
      }
      const existing = await this.challenge(db, callId);
      if (
        existing &&
        !input.resend &&
        !existing.invalidated_at &&
        existing.contact_fingerprint === contactFingerprint
      )
        return { result: this.codeResult(existing) };
      // Serialize sends to the registered destination across calls without exposing it.
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [patient.contact_number]);
      const recent = (
        await db.query<{ created_at: Date }>(
          "SELECT created_at FROM voice_sms WHERE template='emergency_verification' AND recipient_number=$1 AND created_at>$2 ORDER BY created_at DESC",
          [patient.contact_number, new Date(this.now().getTime() - 900_000)],
        )
      ).rows;
      if (recent[0] && this.now().getTime() - recent[0].created_at.getTime() < 60_000)
        return {
          result: {
            status: "code_resend_wait",
            message:
              "Please allow a minute before requesting another code. Use the most recent text if it arrives.",
          },
        };
      const count = (
        await db.query(
          "SELECT count(*)::int AS total FROM voice_emergency_codes WHERE call_id=$1",
          [callId],
        )
      ).rows[0].total;
      if (count >= 3 || recent.length >= 5)
        return {
          result: {
            status: "code_send_limit",
            message:
              "The verification text limit has been reached. Please contact hospital reception for help.",
          },
        };
      const smsId = randomUUID(),
        code = randomInt(100_000_000).toString().padStart(8, "0");
      const expires = new Date(this.now().getTime() + 300_000);
      await db.query(
        "UPDATE voice_emergency_codes SET invalidated_at=$2 WHERE call_id=$1 AND invalidated_at IS NULL",
        [callId, this.now()],
      );
      await db.query(
        "UPDATE voice_emergency_sessions SET verified_until=NULL,contact_fingerprint=NULL,updated_at=$2 WHERE call_id=$1",
        [callId, this.now()],
      );
      await db.query(
        `INSERT INTO voice_sms(id,call_id,tool_call_id,template,mode,recipient_number,body,content_fingerprint,status,expires_at,created_at,updated_at,confirmed_at)
        VALUES ($1,$2,$3,'emergency_verification','twilio',$4,'careBridge demo: one-time verification code [redacted].',$5,'dispatching',$6,$7,$7,$7)`,
        [
          smsId,
          callId,
          toolCallId,
          patient.contact_number,
          contactFingerprint,
          expires,
          this.now(),
        ],
      );
      await db.query(
        `INSERT INTO voice_emergency_codes(sms_id,call_id,patient_id,code_hash,contact_fingerprint,expires_at,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          smsId,
          callId,
          patient.patient_id,
          hash(`${smsId}:${code}`),
          contactFingerprint,
          expires,
          this.now(),
        ],
      );
      await event(
        db,
        callId,
        "emergency_code_requested",
        this.now(),
        { actionId: smsId },
        `emergency_code:${smsId}`,
      );
      return {
        send: {
          smsId,
          callId,
          to: patient.contact_number,
          body: `careBridge demo: your verification code is ${code}. It expires in 5 minutes. Read the digits aloud or enter them on the keypad during your current call. Reply STOP to opt out.`,
        },
      };
    });
    if (prepared.result) return prepared.result;
    await dispatchEmergencySms(this.pool, this.options.provider!, prepared.send!, this.now);
    return this.codeResult((await this.challenge(this.pool, callId, prepared.send!.smsId))!);
  }
  async verifySpokenCode(callId: string, raw: unknown) {
    const input = emergencyCodeInputSchema.parse(raw);
    const parts = input.code
      .toLowerCase()
      .split(/[\s,.-]+/)
      .filter(Boolean);
    const digits = parts.map((part) => (/^\d+$/.test(part) ? part : digitWords[part]));
    const code = digits.join("");
    if (digits.some((digit) => digit === undefined) || !/^\d{8}$/.test(code))
      return {
        status: "spoken_code_unclear",
        message:
          "I need all eight digits. Ask the caller to repeat the latest SMS code slowly, one digit at a time, or use the keypad. Never guess missing digits or try alternatives.",
      };
    // Spoken SMS codes use only the emergency scope, never the portal-code fallback.
    return (await this.verifyCode(callId, code)) ?? needPatient();
  }
  async verifyCode(callId: string, code: string) {
    return transaction(this.pool, async (db) => {
      // Read verification state only after obtaining the shared call lock.
      await callRow(db, callId, true);
      const session = await this.session(db, callId);
      if (!session) return null;
      const call = await this.active(db, callId);
      if (!session.patient_id) return needPatient();
      if (session.verification_failures >= 5) return locked();
      const challenge = await this.challenge(db, callId);
      if (!challenge || challenge.invalidated_at || challenge.consumed_at)
        return {
          status: "verification_failed",
          message:
            "There is no unused code for this patient on this call. Ask for a new verification text if needed.",
        };
      if (challenge.expires_at <= this.now())
        return {
          status: "code_expired",
          message: "That code expired. Ask whether the caller wants a new verification text.",
        };
      const patient = await this.patient(db, session.patient_id, call.department_id!);
      const valid =
        /^\d{8}$/.test(code) &&
        patient &&
        challenge.patient_id === patient.patient_id &&
        challenge.contact_fingerprint === fingerprint(patient) &&
        challenge.status !== "failed" &&
        timingSafeEqual(
          Buffer.from(challenge.code_hash, "hex"),
          Buffer.from(hash(`${challenge.sms_id}:${code}`), "hex"),
        );
      if (!valid) {
        await db.query(
          "UPDATE voice_emergency_sessions SET verification_failures=verification_failures+1,updated_at=$2 WHERE call_id=$1",
          [callId, this.now()],
        );
        await event(db, callId, "emergency_code_rejected", this.now(), {
          attempts: session.verification_failures + 1,
        });
        return session.verification_failures >= 4
          ? locked()
          : {
              status: "verification_failed",
              message:
                "That code didn't match. Ask the caller to repeat all eight digits from the latest text, one at a time, or use the keypad. Never guess or try alternative codes. Press star to clear partial keypad digits.",
            };
      }
      await db.query("UPDATE voice_emergency_codes SET consumed_at=$2 WHERE sms_id=$1", [
        challenge.sms_id,
        this.now(),
      ]);
      await db.query(
        "UPDATE voice_emergency_sessions SET verified_until=$2,contact_fingerprint=$3,updated_at=$4 WHERE call_id=$1",
        [
          callId,
          new Date(this.now().getTime() + 900_000),
          challenge.contact_fingerprint,
          this.now(),
        ],
      );
      await event(db, callId, "emergency_contact_verified", this.now(), {
        actionId: challenge.sms_id,
      });
      return {
        status: "verified",
        role: "emergency_contact",
        message:
          "Emergency contact verified for this patient only. Call get_emergency_patient_location now; do not ask for a staff or portal code.",
      };
    });
  }
  async location(callId: string) {
    return transaction(this.pool, async (db) => {
      const call = await this.active(db, callId),
        session = await this.session(db, callId);
      if (!session?.patient_id) return needPatient();
      const patient = await this.patient(db, session.patient_id, call.department_id!);
      if (
        !patient ||
        !session.verified_until ||
        session.verified_until <= this.now() ||
        session.contact_fingerprint !== fingerprint(patient)
      ) {
        const challenge = await this.challenge(db, callId);
        if (
          patient &&
          challenge &&
          !challenge.invalidated_at &&
          !challenge.consumed_at &&
          challenge.patient_id === patient.patient_id &&
          challenge.contact_fingerprint === fingerprint(patient) &&
          session.verification_failures < 5
        )
          return this.codeResult(challenge);
        return needContact();
      }
      if (!patient.location_shareable)
        return {
          status: "location_unavailable",
          message:
            "The record does not permit a location update. Please contact hospital reception for help.",
        };
      await event(db, callId, "emergency_location_shared", this.now(), { status: "authorized" });
      return {
        status: "location_available",
        synthetic: true,
        patientName: patient.display_name,
        location: {
          facility: patient.facility,
          department: patient.department,
          area: patient.area,
          visitorInstructions: patient.visitor_instructions,
        },
        message:
          "Share the recorded demo location clearly and briefly. Do not infer the patient's condition, diagnosis or treatment.",
      };
    });
  }
}
