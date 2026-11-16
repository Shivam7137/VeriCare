import { createHash, randomUUID } from "node:crypto";
import {
  edEventSchema,
  visitStateSchema,
  type ConsentScope,
  type EdEvent,
  type VisitState,
} from "@prc/contracts";
import type { Pool, PoolClient } from "pg";
import { transaction, type Database } from "../domain.js";
import type { VisitFacts } from "../opor/hl7v2-mapper.js";
import type { EstimateBasis, Published } from "./estimate.js";
import { deriveVisitState } from "./visit-state.js";

export type PublishedRange = Published & {
  lowMinutes: number;
  highMinutes: number;
  reason: string;
  basis: EstimateBasis;
  at: string;
};

export type Encounter = {
  id: string;
  site: string;
  departmentId: string;
  visitNumber: string;
  patientId: string | null;
  displayName: string;
  facts: VisitFacts;
  state: VisitState;
  published: PublishedRange | null;
  /** Timers and counters the Visit Agent keeps for this visit. Times are on the feed's clock. */
  agent: AgentMemory;
  updatedAt: Date;
};

export type AgentMemory = {
  lastCheckInAskAt?: number;
  nextCheckInAt?: number;
  /** Proactive range texts per audience ("patient" or a contact id). */
  range?: Record<string, { count: number; at: number }>;
};

export type Contact = {
  id: string;
  name: string;
  relationship: string;
  phone: string;
  scopes: ConsentScope[];
  smsOptInAt: Date | null;
};

const encounterColumns = `id, site, department_id AS "departmentId", visit_number AS "visitNumber",
  patient_id AS "patientId", display_name AS "displayName", facts, state, published, agent,
  updated_at AS "updatedAt"`;

export async function encounterById(db: Database, id: string, lock = false) {
  const result = await db.query<Encounter>(
    `SELECT ${encounterColumns} FROM ed_encounters WHERE id = $1 ${lock ? "FOR UPDATE" : ""}`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function encounterByVisit(db: Database, site: string, visitNumber: string) {
  const result = await db.query<Encounter>(
    `SELECT ${encounterColumns} FROM ed_encounters WHERE site = $1 AND visit_number = $2 FOR UPDATE`,
    [site, visitNumber],
  );
  return result.rows[0] ?? null;
}

/** The patient's most recent visit. Portal sessions only ever see their own. */
export async function latestEncounterForPatient(db: Database, patientId: string, lock = false) {
  const result = await db.query<Encounter>(
    `SELECT ${encounterColumns} FROM ed_encounters WHERE patient_id = $1
     ORDER BY created_at DESC LIMIT 1 ${lock ? "FOR UPDATE" : ""}`,
    [patientId],
  );
  return result.rows[0] ?? null;
}

export async function openEncounters(db: Database, site: string) {
  const result = await db.query<Encounter>(
    `SELECT ${encounterColumns} FROM ed_encounters
     WHERE site = $1 AND NOT (state->>'ended')::boolean ORDER BY created_at`,
    [site],
  );
  return result.rows;
}

export async function appendEvents(
  db: Database,
  encounterId: string,
  events: readonly EdEvent[],
  receivedAt: Date,
) {
  for (const event of events)
    await db.query(
      `INSERT INTO ed_events (encounter_id, kind, occurred_at, source, source_event_id, detail, received_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (encounter_id, source, source_event_id) DO NOTHING`,
      [
        encounterId,
        event.kind,
        event.occurredAt,
        event.source,
        event.sourceEventId,
        event.detail,
        receivedAt,
      ],
    );
}

/** Rebuilds the visit's state from its full event log and saves the projection. */
export async function projectState(db: Database, encounterId: string, now: Date) {
  const rows = await db.query(
    `SELECT kind, occurred_at AS "occurredAt", source, source_event_id AS "sourceEventId", detail
     FROM ed_events WHERE encounter_id = $1 ORDER BY seq`,
    [encounterId],
  );
  const events = rows.rows.map((row) =>
    edEventSchema.parse({ ...row, occurredAt: row.occurredAt.toISOString() }),
  );
  const state = visitStateSchema.parse(deriveVisitState(events));
  await db.query("UPDATE ed_encounters SET state = $2, updated_at = $3 WHERE id = $1", [
    encounterId,
    state,
    now,
  ]);
  return state;
}

export async function activeContacts(db: Database, encounterId: string) {
  const result = await db.query<Contact>(
    `SELECT id, name, relationship, phone, scopes, sms_opt_in_at AS "smsOptInAt" FROM ed_contacts
     WHERE encounter_id = $1 AND withdrawn_at IS NULL ORDER BY created_at`,
    [encounterId],
  );
  return result.rows;
}

export async function feedStatus(db: Database, site: string) {
  const result = await db.query<{ lastMessageAt: Date; feedTime: Date }>(
    `SELECT last_message_at AS "lastMessageAt", feed_time AS "feedTime" FROM opor_feed WHERE site = $1`,
    [site],
  );
  return result.rows[0] ?? null;
}

export async function recordMessage(
  db: Database,
  input: {
    encounterId: string;
    audience: "patient" | "contact";
    contactId?: string;
    direction: "out" | "in";
    kind: string;
    body: string;
    at: Date;
    channel?: "web" | "sms" | "voice";
  },
) {
  await db.query(
    `INSERT INTO ed_messages (id, encounter_id, audience, contact_id, direction, channel, kind, body, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      randomUUID(),
      input.encounterId,
      input.audience,
      input.contactId ?? null,
      input.direction,
      input.channel ?? "web",
      input.kind,
      input.body,
      input.at,
    ],
  );
}

export async function saveAgentMemory(db: Database, encounterId: string, memory: AgentMemory) {
  await db.query("UPDATE ed_encounters SET agent = $2 WHERE id = $1", [encounterId, memory]);
}

/** JSON with sorted keys, so a hash does not depend on how the database orders an object. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
}

export const LEDGER_LOCK = 731712;

/**
 * A transaction for any write to the emergency journey. It takes the ledger lock before
 * anything else, so every journey writer locks in the same order: ledger, then visit rows.
 * Without that, a feed message holding the ledger and waiting for a visit row could deadlock
 * with a Visit Agent plan holding the row and waiting for the ledger. One emergency
 * department's writes are short and few, so running them one at a time costs nothing that
 * matters; a provincial deployment would take this lock per site instead.
 */
export function journeyTransaction<T>(pool: Pool, work: (db: PoolClient) => Promise<T>) {
  return transaction(pool, async (db) => {
    await db.query("SELECT pg_advisory_xact_lock($1)", [LEDGER_LOCK]);
    return work(db);
  });
}

/** Appends to the tamper-evident ledger. Each hash covers the row before it. */
export async function audit(
  db: Database,
  input: {
    at: Date;
    actor: string;
    action: string;
    encounterId?: string | null;
    detail?: Record<string, unknown>;
  },
) {
  // One writer at a time, or two rows could chain from the same predecessor. Journey writes
  // already hold this lock from journeyTransaction; taking it again is a no-op.
  await db.query("SELECT pg_advisory_xact_lock($1)", [LEDGER_LOCK]);
  const last = await db.query<{ hash: string }>(
    "SELECT hash FROM ed_audit ORDER BY seq DESC LIMIT 1",
  );
  const prevHash = last.rows[0]?.hash ?? "genesis";
  const detail = input.detail ?? {};
  const hash = createHash("sha256")
    .update(
      canonicalJson([
        prevHash,
        input.at.toISOString(),
        input.actor,
        input.action,
        input.encounterId ?? null,
        detail,
      ]),
    )
    .digest("hex");
  await db.query(
    `INSERT INTO ed_audit (at, actor, action, encounter_id, detail, prev_hash, hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [input.at, input.actor, input.action, input.encounterId ?? null, detail, prevHash, hash],
  );
}
