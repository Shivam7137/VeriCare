import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { BackendError } from "../../domain.js";
import { visitMessage, type Agent } from "../intake.js";
import { deliver } from "../outbox.js";
import { audit, journeyTransaction } from "../records.js";
import { MAYA_VISIT } from "./seed.js";

// "Be Maya's emergency contact": a judge types their own phone number into the demo bar and
// becomes one of Maya's emergency contacts, exactly as if she had added them in her app. They
// get a welcome text and every update a real contact would get, and can text back a question
// about her, which the Visit Agent answers within what Maya agreed to share. No extra web page:
// the whole contact experience is the text thread. Typing the number and pressing the button
// is their own opt-in, so they need not reply YES. The number lives only in the fictional demo
// tables, which every reset wipes.

const MAX_JUDGES = 25;
const E164 = /^\+[1-9]\d{7,14}$/;
const SCOPES = ["status", "alerts", "estimates"];
/** Without "estimates": steps only. The Guardian then holds every wait range back. */
const STEPS_ONLY = ["status", "alerts"];

/** Accepts what people type ("902 555-0134", "1 (902) 555 0134", "+44 20…") as E.164. */
export function normalizePhone(input: string): string | null {
  const trimmed = input.trim();
  const digits = trimmed.replace(/\D/g, "");
  let phone: string;
  if (trimmed.startsWith("+")) phone = `+${digits}`;
  else if (digits.length === 10) phone = `+1${digits}`;
  else if (digits.length === 11 && digits.startsWith("1")) phone = `+${digits}`;
  else return null;
  return E164.test(phone) ? phone : null;
}

/** The last four digits, for showing on screen. */
export const maskPhone = (phone: string) => `••• ${phone.slice(-4)}`;

export async function addJudgeContact(
  pool: Pool,
  input: { name: string; phone: string; estimates?: boolean },
  now: Date,
): Promise<{ note: string; contact: { id: string; phone: string } }> {
  const scopes = input.estimates === false ? STEPS_ONLY : SCOPES;
  const phone = normalizePhone(input.phone);
  if (!phone) throw new BackendError("invalid_phone", 400);
  const name = input.name.trim().slice(0, 80) || "Demo judge";
  return journeyTransaction(pool, async (db) => {
    const visit = await db.query<{ id: string; name: string }>(
      `SELECT id, display_name AS name FROM ed_encounters
       WHERE visit_number LIKE $1 AND NOT (state->>'ended')::boolean
       ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [`${MAYA_VISIT}%`],
    );
    const encounter = visit.rows[0];
    if (!encounter) throw new BackendError("featured_gone", 409);
    // The same number again replaces the old entry and starts a fresh thread.
    await db.query(
      `UPDATE ed_contacts SET withdrawn_at = $3
       WHERE encounter_id = $1 AND phone = $2 AND withdrawn_at IS NULL`,
      [encounter.id, phone, now],
    );
    const count = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM ed_contacts WHERE encounter_id = $1 AND withdrawn_at IS NULL",
      [encounter.id],
    );
    if ((count.rows[0]?.n ?? 0) >= MAX_JUDGES) throw new BackendError("contact_limit", 409);

    const id = randomUUID();
    await db.query(
      `INSERT INTO ed_contacts (id, encounter_id, name, relationship, phone, scopes, created_at,
                                sms_opt_in_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`,
      [id, encounter.id, name, "Emergency contact (demo)", phone, scopes, now],
    );
    await audit(db, {
      at: now,
      actor: "patient",
      action: "consent_given",
      encounterId: encounter.id,
      detail: { contactId: id, scopes, demo: true },
    });
    const first = encounter.name.split(" ")[0] ?? "The patient";
    // Recorded and texted like every other message to a contact, so mission control shows it.
    await deliver(db, {
      encounterId: encounter.id,
      audience: "contact",
      contactId: id,
      kind: "welcome",
      body: `VeriCare demo: you are now ${first}'s emergency contact. We'll text you when her visit moves on${scopes.includes("estimates") ? " or her wait changes" : ""}. Text back any question about her. Reply STOP to end.`,
      at: now,
      channel: "sms",
    });
    return {
      note: `You're ${first}'s emergency contact. Texts go to ${maskPhone(phone)}.`,
      contact: { id, phone: maskPhone(phone) },
    };
  });
}

/**
 * The judge texts a question as the contact. It takes the same path as a real inbound text
 * (the Visit Agent, held to Maya's consent), and the answer appears in their thread.
 */
export async function askAsContact(
  pool: Pool,
  input: { contactId: string; text: string },
  now: Date,
  agent: Agent,
): Promise<string> {
  const found = await pool.query<{ encounterId: string }>(
    `SELECT encounter_id AS "encounterId" FROM ed_contacts WHERE id = $1 AND withdrawn_at IS NULL`,
    [input.contactId],
  );
  const encounterId = found.rows[0]?.encounterId;
  if (!encounterId) throw new BackendError("not_found", 404);
  await visitMessage(
    pool,
    { encounterId, contactId: input.contactId },
    input.text,
    "sms",
    now,
    agent,
  );
  return "Your text was answered.";
}

export type JudgePhone = {
  active: boolean;
  /** The visit this contact follows, so the bar can move it along. */
  patientId: string;
  phone: string;
  /** Whether texts really leave the server: the newest text's delivery status, or null. */
  delivery: string | null;
  /** The thread with this contact, newest first. */
  messages: { at: string; body: string; direction: "in" | "out" }[];
};

/** One judge's text thread. Null once the contact is gone (a reset). */
export async function judgePhone(pool: Pool, contactId: string): Promise<JudgePhone | null> {
  const contact = await pool.query<{ phone: string; withdrawn: boolean; patientId: string }>(
    `SELECT phone, withdrawn_at IS NOT NULL AS withdrawn, encounter_id AS "patientId"
     FROM ed_contacts WHERE id = $1`,
    [contactId],
  );
  const row = contact.rows[0];
  if (!row) return null;
  const [messages, sms] = await Promise.all([
    pool.query<{ at: Date; body: string; direction: "in" | "out" }>(
      `SELECT created_at AS at, body, direction FROM ed_messages WHERE contact_id = $1
       ORDER BY seq DESC LIMIT 12`,
      [contactId],
    ),
    pool.query<{ status: string }>(
      "SELECT status FROM ed_sms WHERE contact_id = $1 ORDER BY seq DESC LIMIT 1",
      [contactId],
    ),
  ]);
  return {
    active: !row.withdrawn,
    patientId: row.patientId,
    phone: maskPhone(row.phone),
    delivery: sms.rows[0]?.status ?? null,
    messages: messages.rows.map((message) => ({
      at: new Date(message.at).toISOString(),
      body: message.body,
      direction: message.direction,
    })),
  };
}
