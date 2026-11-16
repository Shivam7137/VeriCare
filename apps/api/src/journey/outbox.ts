import { randomUUID } from "node:crypto";
import type { Database } from "../domain.js";
import { recordMessage } from "./records.js";

/**
 * Records a message and, when the recipient has opted in to texts, queues it for the
 * text-message sender. Queuing happens in the caller's transaction; sending happens after.
 */
export async function deliver(
  db: Database,
  input: {
    encounterId: string;
    audience: "patient" | "contact";
    contactId?: string;
    kind: string;
    body: string;
    at: Date;
    /** False for a reply that already travels another way (a web response, a TwiML reply). */
    text?: boolean;
    channel?: "web" | "sms" | "voice";
  },
) {
  await recordMessage(db, { ...input, direction: "out" });
  if (input.text === false) return;
  const to = input.contactId
    ? await db.query<{ phone: string | null }>(
        `SELECT phone FROM ed_contacts
         WHERE id = $1 AND withdrawn_at IS NULL AND sms_opt_in_at IS NOT NULL`,
        [input.contactId],
      )
    : await db.query<{ phone: string | null }>(
        "SELECT phone FROM ed_encounters WHERE id = $1 AND sms_opt_in_at IS NOT NULL",
        [input.encounterId],
      );
  const phone = to.rows[0]?.phone;
  if (phone)
    await queueSms(db, input.encounterId, input.contactId ?? null, phone, input.body, input.at);
}

export async function queueSms(
  db: Database,
  encounterId: string,
  contactId: string | null,
  to: string,
  body: string,
  now: Date,
) {
  await db.query(
    `INSERT INTO ed_sms (id, encounter_id, contact_id, to_number, body, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$6)`,
    [randomUUID(), encounterId, contactId, to, body.slice(0, 1000), now],
  );
}
