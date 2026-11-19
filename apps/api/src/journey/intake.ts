import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ConsentScope, SensitivityFlag, StaffTaskKind } from "@prc/contracts";
import type { Pool } from "pg";
import { wakeAgent } from "../agents/settle.js";
import type { VisitAgent } from "../agents/visit-agent.js";
import type { Candidate, InboundMessage } from "../agents/wake.js";
import { BackendError, type Database } from "../domain.js";
import { decideDisclosure } from "./guardian.js";
import { react, refreshEstimates } from "./ingest.js";
import {
  CONTACT_WORSE_REPLY,
  HANDOFF_REPLY,
  LEAVING_REPLY,
  PICKED_UP,
  WORSE_REPLY,
  rangeSentence,
  statusSentence,
} from "./messages.js";
import { deliver, queueSms } from "./outbox.js";
import {
  activeContacts,
  appendEvents,
  audit,
  encounterById,
  feedStatus,
  latestEncounterForPatient,
  projectState,
  recordMessage,
  saveAgentMemory,
  type Contact,
  type Encounter,
  journeyTransaction,
} from "./records.js";
import {
  leavingWords,
  openTask,
  statusWords,
  triageText,
  waitedText,
  worseWords,
} from "./tasks.js";

/** The runner that plans deferred wakes. Null means the rules path settles everything inline. */
/** The Visit Agent as the routes use it. Its retriever, when given, also serves the staff tester. */
export type Agent =
  (Pick<VisitAgent, "defer" | "settle"> & Partial<Pick<VisitAgent, "retriever">>) | null;
type Channel = InboundMessage["channel"];
type Reply = { kind: string; reply: string };

async function ownVisit(db: Database, patientId: string): Promise<Encounter> {
  const encounter = await latestEncounterForPatient(db, patientId, true);
  if (!encounter || encounter.state.ended) throw new BackendError("no_active_visit", 404);
  return encounter;
}

async function openVisit(db: Database, encounterId: string): Promise<Encounter> {
  const encounter = await encounterById(db, encounterId, true);
  if (!encounter || encounter.state.ended) throw new BackendError("no_active_visit", 404);
  return encounter;
}

/** What this person may be told right now, as a prepared reply the agent can choose. */
async function statusCandidate(
  db: Database,
  encounter: Encounter,
  contact: Contact | null,
  now: Date,
  log: boolean,
): Promise<{ allowed: boolean; candidate: Candidate | null }> {
  const feed = await feedStatus(db, encounter.site);
  const audience = contact ? "contact" : "patient";
  const decision = decideDisclosure({
    audience,
    verified: true,
    consentScopes: contact?.scopes ?? null,
    state: encounter.state,
    feedLastMessageAt: feed?.lastMessageAt ?? null,
    now,
    request: "estimate",
  });
  if (log)
    await audit(db, {
      at: now,
      actor: "guardian",
      action: `status_request_${decision.outcome}`,
      encounterId: encounter.id,
      detail: { audience, ...(contact ? { contactId: contact.id } : {}) },
    });
  if (decision.outcome !== "allow") return { allowed: false, candidate: null };
  const firstName = encounter.displayName.split(" ")[0] ?? "";
  const range =
    decision.estimate && encounter.published
      ? ` ${rangeSentence(encounter.published.lowMinutes, encounter.published.highMinutes, audience)}`
      : "";
  return {
    allowed: true,
    candidate: {
      id: "status",
      tool: "notify",
      audience,
      contactId: contact?.id,
      kind: "status",
      body: `${statusSentence(encounter.state, audience, firstName)}${range}`,
      requires: "status",
      asReply: true,
    },
  };
}

/**
 * Anything a person writes to us. The safety floors run first, in code. Everything else
 * wakes the Visit Agent, which answers from the knowledge base, relays to staff, or hands off.
 */
async function inbound(
  pool: Pool,
  find: (db: Database) => Promise<{ encounter: Encounter; contact: Contact | null }>,
  text: string,
  channel: Channel,
  now: Date,
  agent: Agent,
): Promise<Reply> {
  const first = await journeyTransaction(pool, async (db) => {
    const { encounter, contact } = await find(db);
    const feed = await feedStatus(db, encounter.site);
    const audience = contact ? "contact" : "patient";
    await recordMessage(db, {
      encounterId: encounter.id,
      audience,
      contactId: contact?.id,
      direction: "in",
      kind: "text",
      body: text,
      at: now,
      channel,
    });
    const context = `${triageText(encounter)}${waitedText(encounter, feed?.feedTime)}`;
    const floor = async (kind: string, reply: string) => {
      await deliver(db, {
        encounterId: encounter.id,
        audience,
        contactId: contact?.id,
        kind: `reply_${kind}`,
        body: reply,
        at: now,
        text: false,
        channel,
      });
      return { kind, reply };
    };
    if (worseWords.test(text)) {
      await openTask(
        db,
        encounter,
        "recheck",
        1,
        contact
          ? `${contact.relationship} reports the patient may be getting worse: "${text}".${context}`
          : `Patient reports feeling worse: "${text}".${context}`,
        now,
        contact?.id ?? null,
      );
      return floor("worse", contact ? CONTACT_WORSE_REPLY : WORSE_REPLY);
    }
    if (!contact && leavingWords.test(text)) {
      const urgent = encounter.state.ctas !== null && encounter.state.ctas <= 3;
      await openTask(
        db,
        encounter,
        "leaving",
        urgent ? 1 : 2,
        `Patient is thinking of leaving.${context}`,
        now,
      );
      return floor("leaving", LEAVING_REPLY);
    }
    const status = await statusCandidate(db, encounter, contact, now, statusWords.test(text));
    // A contact on a visit that has gone quiet hears the standard handoff and nothing more.
    if (contact && !status.allowed) return floor("handoff", HANDOFF_REPLY);
    const woke = await wakeAgent(
      db,
      encounter,
      contact ? "contact_question" : "inbound_message",
      {
        candidates: status.candidate ? [status.candidate] : [],
        message: { from: audience, contactId: contact?.id, text, channel },
      },
      now,
      // The model never sees anything from a visit the Guardian has silenced.
      status.allowed && (agent?.defer ?? false),
    );
    return woke!.outcome
      ? { kind: woke!.outcome.kind ?? "handoff", reply: woke!.outcome.reply ?? HANDOFF_REPLY }
      : { wakeId: woke!.wakeId };
  });
  if (!("wakeId" in first)) return first;
  const outcome = await agent!.settle(first.wakeId);
  return { kind: outcome?.kind ?? "handoff", reply: outcome?.reply ?? HANDOFF_REPLY };
}

/** A free-text message from the patient's own page. */
export function patientMessage(
  pool: Pool,
  patientId: string,
  text: string,
  now: Date,
  agent: Agent = null,
) {
  return inbound(
    pool,
    async (db) => ({ encounter: await ownVisit(db, patientId), contact: null }),
    text,
    "web",
    now,
    agent,
  );
}

/** A message from the patient by text, or from an approved contact on any channel. */
export function visitMessage(
  pool: Pool,
  from: { encounterId: string; contactId?: string },
  text: string,
  channel: Channel,
  now: Date,
  agent: Agent = null,
) {
  return inbound(
    pool,
    async (db) => {
      const encounter = await openVisit(db, from.encounterId);
      if (!from.contactId) return { encounter, contact: null };
      const contact = (await activeContacts(db, encounter.id)).find(
        (item) => item.id === from.contactId,
      );
      if (!contact) throw new BackendError("not_found", 404);
      return { encounter, contact };
    },
    text,
    channel,
    now,
    agent,
  );
}

async function answerCheckIn(
  db: Database,
  encounter: Encounter,
  answer: "same" | "better" | "worse",
  channel: Channel,
  now: Date,
) {
  const feed = await feedStatus(db, encounter.site);
  await recordMessage(db, {
    encounterId: encounter.id,
    audience: "patient",
    direction: "in",
    kind: "check_in",
    body: `Feeling ${answer}`,
    at: now,
    channel,
  });
  if (answer === "worse")
    await openTask(
      db,
      encounter,
      "recheck",
      1,
      `Check-in: patient feels worse.${triageText(encounter)}${waitedText(encounter, feed?.feedTime)}`,
      now,
    );
  // An answer restarts the check-in clock, whether or not the agent had asked yet.
  if (feed)
    await saveAgentMemory(db, encounter.id, {
      ...encounter.agent,
      lastCheckInAskAt: feed.feedTime.getTime(),
      nextCheckInAt: undefined,
    });
  const reply =
    answer === "worse" ? WORSE_REPLY : "Thanks for letting us know. We'll keep you posted.";
  await deliver(db, {
    encounterId: encounter.id,
    audience: "patient",
    kind: `reply_check_in_${answer}`,
    body: reply,
    at: now,
    text: false,
    channel,
  });
  return { reply };
}

export async function checkIn(
  pool: Pool,
  patientId: string,
  answer: "same" | "better" | "worse",
  now: Date,
) {
  return journeyTransaction(pool, async (db) =>
    answerCheckIn(db, await ownVisit(db, patientId), answer, "web", now),
  );
}

/** A check-in answered by text message. */
export async function checkInByText(
  pool: Pool,
  encounterId: string,
  answer: "same" | "better" | "worse",
  now: Date,
) {
  return journeyTransaction(pool, async (db) =>
    answerCheckIn(db, await openVisit(db, encounterId), answer, "sms", now),
  );
}

export const hashLink = (token: string) => createHash("sha256").update(token).digest("hex");

/** Where the family page lives. Loopback unless a public demo origin is configured. */
export function familyUrl(token: string, env: NodeJS.ProcessEnv = process.env) {
  const origin =
    env.SMS_APP_URL?.trim() || env.PUBLIC_DEMO_ORIGIN?.trim() || "http://127.0.0.1:3100";
  return `${origin.replace(/\/$/, "")}/family/${token}`;
}

export async function addContact(
  pool: Pool,
  patientId: string,
  input: { name: string; relationship: string; phone: string; scopes: ConsentScope[] },
  now: Date,
) {
  try {
    return await insertContact(pool, patientId, input, now);
  } catch (error) {
    // Every refusal is on the ledger with its reason, so staff can see why live.
    if (error instanceof BackendError)
      await journeyTransaction(pool, async (db) => {
        const encounter = await latestEncounterForPatient(db, patientId);
        await audit(db, {
          at: now,
          actor: "patient",
          action: "contact_refused",
          encounterId: encounter?.id ?? null,
          detail: { reason: error.code },
        });
      }).catch(() => undefined);
    throw error;
  }
}

async function insertContact(
  pool: Pool,
  patientId: string,
  input: { name: string; relationship: string; phone: string; scopes: ConsentScope[] },
  now: Date,
) {
  return journeyTransaction(pool, async (db) => {
    const encounter = await ownVisit(db, patientId);
    const twice = await db.query(
      "SELECT 1 FROM ed_contacts WHERE encounter_id = $1 AND phone = $2 AND withdrawn_at IS NULL",
      [encounter.id, input.phone],
    );
    if (twice.rowCount) throw new BackendError("duplicate_contact", 409);
    const id = randomUUID();
    // The link is the contact's key to the family page. Only its hash is kept.
    const token = randomBytes(24).toString("base64url");
    await db.query(
      `INSERT INTO ed_contacts (id, encounter_id, name, relationship, phone, scopes, created_at, link_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        id,
        encounter.id,
        input.name,
        input.relationship,
        input.phone,
        input.scopes,
        now,
        hashLink(token),
      ],
    );
    await audit(db, {
      at: now,
      actor: "patient",
      action: "consent_given",
      encounterId: encounter.id,
      detail: { contactId: id, scopes: input.scopes },
    });
    const firstName = encounter.displayName.split(" ")[0] ?? "Someone";
    // One text tells them they were added and how to opt in. Nothing about the visit itself.
    await queueSms(
      db,
      encounter.id,
      id,
      input.phone,
      `VeriCare: ${firstName} added you to updates about an emergency visit. Reply YES to get texts, STOP to end. Your private page: ${familyUrl(token)}`,
      now,
    );
    return { id, link: `/family/${token}` };
  });
}

export async function withdrawContact(pool: Pool, patientId: string, contactId: string, now: Date) {
  return journeyTransaction(pool, async (db) => {
    const encounter = await latestEncounterForPatient(db, patientId, true);
    if (!encounter) throw new BackendError("not_found", 404);
    const result = await db.query(
      `UPDATE ed_contacts SET withdrawn_at = $3 WHERE id = $1 AND encounter_id = $2 AND withdrawn_at IS NULL`,
      [contactId, encounter.id, now],
    );
    if (result.rowCount === 0) throw new BackendError("not_found", 404);
    // Withdrawal takes effect at once: the next disclosure check sees no consent.
    await audit(db, {
      at: now,
      actor: "patient",
      action: "consent_withdrawn",
      encounterId: encounter.id,
      detail: { contactId },
    });
    return { withdrawn: true };
  });
}

async function staffEncounter(db: Database, encounterId: string, departmentId: string) {
  const encounter = await encounterById(db, encounterId, true);
  if (!encounter || encounter.departmentId !== departmentId)
    throw new BackendError("not_found", 404);
  return encounter;
}

/** Staff set or clear a sensitivity flag. It is recorded as an event like any other. */
export async function staffSetFlag(
  pool: Pool,
  staff: { id: string; departmentId: string },
  encounterId: string,
  flag: SensitivityFlag,
  active: boolean,
  now: Date,
  agent: Agent = null,
) {
  const defer = agent?.defer ?? false;
  return journeyTransaction(pool, async (db) => {
    const encounter = await staffEncounter(db, encounterId, staff.departmentId);
    if (encounter.state.sensitivity.includes(flag) === active)
      return { flags: encounter.state.sensitivity };
    const event = {
      kind: active ? ("flag_set" as const) : ("flag_cleared" as const),
      occurredAt: now.toISOString(),
      source: "staff" as const,
      sourceEventId: randomUUID(),
      detail: { flag },
    };
    await appendEvents(db, encounter.id, [event], now);
    const state = await projectState(db, encounter.id, now);
    await audit(db, {
      at: now,
      actor: staff.id,
      action: active ? "flag_set" : "flag_cleared",
      encounterId: encounter.id,
      detail: { flag },
    });
    await react(db, { ...encounter, state }, encounter.state, state, [event], now, defer);
    if (active) {
      await db.query("UPDATE ed_encounters SET published = NULL WHERE id = $1", [encounter.id]);
      // Silence covers what is already on its way: queued texts and unplanned wakes.
      await db.query(
        `UPDATE ed_sms SET status = 'blocked', last_error = 'visit_silenced', updated_at = $2
         WHERE encounter_id = $1 AND status = 'queued'`,
        [encounter.id, now],
      );
      await db.query(
        "UPDATE ed_agent_wakes SET settled_at = $2 WHERE encounter_id = $1 AND settled_at IS NULL",
        [encounter.id, now],
      );
    } else await refreshEstimates(db, encounter.site, now, defer);
    return { flags: state.sensitivity };
  });
}

export async function staffCloseTask(
  pool: Pool,
  staff: { id: string; departmentId: string },
  taskId: string,
  outcome: "done" | "not_needed",
  now: Date,
) {
  return journeyTransaction(pool, async (db) => {
    const task = await db.query<{
      encounterId: string;
      kind: StaffTaskKind;
      contactId: string | null;
    }>(
      `SELECT encounter_id AS "encounterId", kind, contact_id AS "contactId" FROM ed_staff_tasks
       WHERE id = $1 AND state = 'open' FOR UPDATE`,
      [taskId],
    );
    if (!task.rows[0]) throw new BackendError("not_found", 404);
    const { kind, contactId } = task.rows[0];
    const encounter = await staffEncounter(db, task.rows[0].encounterId, staff.departmentId);
    await db.query(
      "UPDATE ed_staff_tasks SET state = $2, closed_at = $3, closed_by = $4 WHERE id = $1",
      [taskId, outcome, now, staff.id],
    );
    await audit(db, {
      at: now,
      actor: staff.id,
      action: `task_closed_${outcome}`,
      encounterId: encounter.id,
      detail: { kind },
    });
    // Close the loop with whoever asked, without saying anything clinical.
    if (
      outcome === "done" &&
      kind === "question" &&
      !encounter.state.ended &&
      encounter.state.sensitivity.length === 0
    ) {
      const stillApproved =
        !contactId ||
        (await activeContacts(db, encounter.id)).some((item) => item.id === contactId);
      if (stillApproved)
        await deliver(db, {
          encounterId: encounter.id,
          audience: contactId ? "contact" : "patient",
          contactId: contactId ?? undefined,
          kind: "task_picked_up",
          body: PICKED_UP,
          at: now,
        });
    }
    return { closed: true };
  });
}
