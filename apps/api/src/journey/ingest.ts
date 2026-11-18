import { randomUUID } from "node:crypto";
import type { Ctas, EdEvent, VisitState } from "@prc/contracts";
import type { Pool } from "pg";
import type { Database } from "../domain.js";
import { field, parseHl7, segment, component } from "../opor/hl7.js";
import { halifaxTwinSite, mapHl7, type SiteConfig } from "../opor/hl7v2-mapper.js";
import {
  estimateWait,
  explainChange,
  publishDecision,
  rangeFromModel,
  type EstimateResult,
  type QueuePatient,
  type QueueSnapshot,
} from "./estimate.js";
import { wakeAgent } from "../agents/settle.js";
import type { Candidate } from "../agents/wake.js";
import { decideDisclosure } from "./guardian.js";
import {
  BUSY_SENTENCE,
  CHECK_IN_ASK,
  SMS_INVITE,
  rangeSentence,
  reasonSentence,
  statusSentence,
} from "./messages.js";
import { queueSms } from "./outbox.js";
import {
  activeContacts,
  appendEvents,
  audit,
  encounterByVisit,
  openEncounters,
  projectState,
  type Encounter,
  type PublishedRange,
  journeyTransaction,
} from "./records.js";
import { recordStageEstimates, siteStages, type SiteStages } from "./stage-estimates.js";

const MIN = 60_000;

export type JourneyOptions = {
  now?: () => Date;
  siteId?: string;
  site?: SiteConfig;
  departmentId?: string;
  /**
   * True when a language model plans the Visit Agent's wakes after the transaction commits.
   * False (the default) settles each wake at once with the rules planner.
   */
  defer?: boolean;
  /** The caller recomputes estimates itself, once per batch (the demo control bar does). */
  deferEstimates?: boolean;
};

export type IngestOutcome = "accepted" | "duplicate" | "ignored";

/** Takes one HL7 v2 message from the OPOR feed and applies everything that follows from it. */
export async function ingestHl7(
  pool: Pool,
  raw: string,
  options: JourneyOptions = {},
): Promise<IngestOutcome> {
  const now = (options.now ?? (() => new Date()))();
  const siteId = options.siteId ?? "qeii-hi";
  const site = options.site ?? halifaxTwinSite;
  const message = parseHl7(raw);
  const controlId = field(segment(message, "MSH"), 10);
  const visitNumber = component(field(segment(message, "PV1"), 19), 1);
  if (!controlId || !visitNumber) throw new Error("hl7_missing_identifiers");

  return journeyTransaction(pool, async (db) => {
    const fresh = await db.query(
      `INSERT INTO opor_messages (site, control_id, received_at, outcome, raw)
       VALUES ($1,$2,$3,'accepted',$4) ON CONFLICT DO NOTHING RETURNING control_id`,
      [siteId, controlId, now, raw],
    );
    // A resent message was already applied. Acknowledge it again and change nothing.
    if (fresh.rowCount === 0) return "duplicate";
    // Serialise per visit so two first messages cannot both create the encounter.
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${siteId}:${visitNumber}`]);
    let encounter = await encounterByVisit(db, siteId, visitNumber);
    const mapped = mapHl7(raw, site, encounter?.facts ?? null);
    if (mapped.kind === "ignored") {
      await db.query("UPDATE opor_messages SET outcome = $3 WHERE site = $1 AND control_id = $2", [
        siteId,
        controlId,
        `ignored:${mapped.why}`,
      ]);
      return "ignored";
    }
    await db.query(
      `INSERT INTO opor_feed (site, last_message_at, feed_time) VALUES ($1,$2,$3)
       ON CONFLICT (site) DO UPDATE SET last_message_at = $2,
       feed_time = GREATEST(opor_feed.feed_time, EXCLUDED.feed_time)`,
      [siteId, now, mapped.occurredAt],
    );
    const before: VisitState | null = encounter?.state ?? null;
    if (!encounter) {
      const id = randomUUID();
      await db.query(
        `INSERT INTO ed_encounters (id, site, department_id, visit_number, mrn, patient_id,
           display_name, date_of_birth, phone, facts, state, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'{}',$11,$11)`,
        [
          id,
          siteId,
          options.departmentId ?? "demo-department",
          visitNumber,
          mapped.mrn,
          await knownPatient(db, mapped.patient.name, mapped.patient.dateOfBirth),
          titleCase(mapped.patient.name) || "Patient",
          mapped.patient.dateOfBirth,
          mapped.patient.phone,
          mapped.facts,
          now,
        ],
      );
      encounter = { id } as Encounter;
      // The number came from registration. One text asks permission; nothing else is sent before YES.
      if (mapped.patient.phone) await queueSms(db, id, null, mapped.patient.phone, SMS_INVITE, now);
    } else {
      await db.query("UPDATE ed_encounters SET facts = $2 WHERE id = $1", [
        encounter.id,
        mapped.facts,
      ]);
    }
    await appendEvents(db, encounter.id, mapped.events, now);
    const state = await projectState(db, encounter.id, now);
    await audit(db, {
      at: now,
      actor: "opor-feed",
      action: "feed_message",
      encounterId: encounter.id,
      detail: { controlId, events: mapped.events.map((event) => event.kind) },
    });
    const current = (await encounterByVisit(db, siteId, visitNumber))!;
    const defer = options.defer ?? false;
    await react(db, current, before, state, mapped.events, now, defer);
    if (!options.deferEstimates) await refreshEstimates(db, siteId, now, defer);
    return "accepted";
  });
}

/**
 * Keeps time moving when the feed is quiet. A live feed's clock runs at wall-clock speed
 * between messages, so the department clock is advanced by the time since the last one and
 * estimates, overrun alerts and check-ins are recomputed. A stale feed is left alone.
 */
export async function tickFeed(pool: Pool, options: JourneyOptions = {}) {
  const now = (options.now ?? (() => new Date()))();
  const siteId = options.siteId ?? "qeii-hi";
  return journeyTransaction(pool, async (db) => {
    const feed = await db.query<{ lastMessageAt: Date; tickedAt: Date | null }>(
      `SELECT last_message_at AS "lastMessageAt", ticked_at AS "tickedAt"
       FROM opor_feed WHERE site = $1 FOR UPDATE`,
      [siteId],
    );
    const row = feed.rows[0];
    if (!row || now.getTime() - row.lastMessageAt.getTime() > 15 * MIN) return false;
    const since =
      now.getTime() - Math.max(row.lastMessageAt.getTime(), row.tickedAt?.getTime() ?? 0);
    if (since <= 0) return false;
    await db.query(
      `UPDATE opor_feed SET feed_time = feed_time + ($2 || ' milliseconds')::interval, ticked_at = $3
       WHERE site = $1`,
      [siteId, String(since), now],
    );
    await refreshEstimates(db, siteId, now, options.defer ?? false);
    return true;
  });
}

/**
 * Wakes the Visit Agent when a visit changes step. Code decides here who may be told and
 * writes each sentence; the agent (a model, or the rules path) chooses which to send.
 */
export async function react(
  db: Database,
  encounter: Encounter,
  before: VisitState | null,
  state: VisitState,
  events: readonly EdEvent[],
  now: Date,
  defer = false,
) {
  if (events.some((event) => event.kind === "provider_assigned") && state.providerAt) {
    // Close the loop on accuracy: how long the wait really was after each estimate.
    await db.query(
      `UPDATE ed_estimates SET actual_minutes =
         GREATEST(0, ROUND(EXTRACT(EPOCH FROM ($2::timestamptz - computed_at)) / 60))
       WHERE encounter_id = $1 AND actual_minutes IS NULL`,
      [encounter.id, state.providerAt],
    );
  }
  const silenced = state.sensitivity.length > 0 || state.unmapped;
  const wasSilenced = before ? before.sensitivity.length > 0 || before.unmapped : false;
  if (silenced && !wasSilenced)
    await audit(db, {
      at: now,
      actor: "guardian",
      action: "visit_silenced",
      encounterId: encounter.id,
    });
  const stepChanged =
    !before || before.step !== state.step || before.friendlyStep !== state.friendlyStep;
  if (!stepChanged) return;

  const firstName = encounter.displayName.split(" ")[0] ?? "Patient";
  const own = decideDisclosure({
    audience: "patient",
    verified: true,
    consentScopes: null,
    state,
    feedLastMessageAt: now,
    now,
    request: "status",
  });
  await audit(db, {
    at: now,
    actor: "guardian",
    action: `step_update_${own.outcome}`,
    encounterId: encounter.id,
    detail: {
      audience: "patient",
      step: state.step,
      ...("reason" in own ? { reason: own.reason } : {}),
    },
  });
  // A silenced visit sends nothing. Silence and a transfer must look the same from outside.
  if (own.outcome !== "allow") return;
  const candidates: Candidate[] = [
    {
      id: "patient",
      tool: "notify",
      audience: "patient",
      kind: "step",
      body: statusSentence(state, "patient", firstName),
      requires: "status",
      step: state.step,
      // The patient always hears their own step change.
      floor: true,
    },
  ];
  for (const contact of await activeContacts(db, encounter.id)) {
    if (!contact.scopes.includes("alerts")) continue;
    const decision = decideDisclosure({
      audience: "contact",
      verified: true,
      consentScopes: contact.scopes,
      state,
      feedLastMessageAt: now,
      now,
      request: "status",
    });
    await audit(db, {
      at: now,
      actor: "guardian",
      action: `step_update_${decision.outcome}`,
      encounterId: encounter.id,
      detail: { audience: "contact", contactId: contact.id, step: state.step },
    });
    if (decision.outcome === "allow")
      candidates.push({
        id: `contact:${contact.id}`,
        tool: "notify",
        audience: "contact",
        contactId: contact.id,
        kind: "step",
        body: statusSentence(state, "contact", firstName),
        requires: "status",
        step: state.step,
        proactive: true,
      });
  }
  await wakeAgent(db, { ...encounter, state }, "step_change", { candidates }, now, defer);
}

/** Recomputes the wait range for everyone still waiting and tells people only when it matters. */
export async function refreshEstimates(db: Database, siteId: string, now: Date, defer = false) {
  const feed = await db.query<{ feedTime: Date }>(
    `SELECT feed_time AS "feedTime" FROM opor_feed WHERE site = $1`,
    [siteId],
  );
  if (!feed.rows[0]) return;
  // Estimates run on the feed's own clock so a replayed or accelerated feed stays consistent.
  const feedNow = feed.rows[0].feedTime.getTime();
  const encounters = await openEncounters(db, siteId);
  const waiting: (QueuePatient & { encounter: Encounter })[] = encounters
    .filter((item) => item.state.step === "waiting" && item.state.ctas && item.state.triagedAt)
    .map((item) => ({
      id: item.id,
      ctas: item.state.ctas as Ctas,
      triagedAt: Date.parse(item.state.triagedAt!),
      stream: item.state.stream,
      encounter: item,
    }));
  const recent = await db.query<{ kind: string; at: Date; ctas: Ctas | null; stream: string }>(
    `SELECT e.kind, e.occurred_at AS at, (e.detail->>'ctas')::int AS ctas, c.state->>'stream' AS stream
     FROM ed_events e JOIN ed_encounters c ON c.id = e.encounter_id
     WHERE c.site = $1 AND e.kind IN ('provider_assigned','triaged') AND e.occurred_at >= $2`,
    [siteId, new Date(feedNow - 60 * MIN)],
  );
  const stream = (value: string) => (value === "rapid_assessment" ? value : "main");
  const snapshot: QueueSnapshot = {
    now: feedNow,
    waiting,
    starts: recent.rows
      .filter((row) => row.kind === "provider_assigned")
      .map((row) => ({ at: row.at.getTime(), stream: stream(row.stream) })),
    arrivals: recent.rows
      .filter((row) => row.kind === "triaged" && row.ctas)
      .map((row) => ({ at: row.at.getTime(), ctas: row.ctas!, stream: stream(row.stream) })),
  };

  // The trained model estimates every step for every open visit. Without a bundled model
  // the wait range falls back to the queue formula and the other steps get no estimate.
  const stages = await siteStages(db, siteId, feedNow);
  if (stages) await recordStageEstimates(db, stages);

  for (const patient of waiting) {
    const { encounter } = patient;
    const decision = decideDisclosure({
      audience: "patient",
      verified: true,
      consentScopes: null,
      state: encounter.state,
      feedLastMessageAt: now,
      now,
      request: "estimate",
    });
    if (decision.outcome !== "allow" || !decision.estimate) continue;
    const result = modelWait(stages, patient.id) ?? estimateWait(patient, snapshot);
    const previous = encounter.published;
    if (result.kind === "abstain") {
      // Say it is too busy to estimate once, when that replaces a range people were given.
      if (previous && (result.why === "too_wide" || result.why === "saturated")) {
        await logEstimate(db, encounter.id, feedNow, null, result.why, true);
        await db.query("UPDATE ed_encounters SET published = NULL WHERE id = $1", [encounter.id]);
        await tellRange(db, encounter, BUSY_SENTENCE, () => BUSY_SENTENCE, now, "busy", defer);
      }
      continue;
    }
    const publish = publishDecision(previous, result.highMinutes, feedNow);
    const reason = explainChange(previous?.basis ?? null, result.basis);
    if (!publish.publish) {
      if (previous)
        await db.query("UPDATE ed_encounters SET published = $2 WHERE id = $1", [
          encounter.id,
          { ...previous, ...publish.next },
        ]);
      continue;
    }
    const next: PublishedRange = {
      ...publish.next,
      lowMinutes: result.lowMinutes,
      highMinutes: result.highMinutes,
      reason,
      basis: result.basis,
      at: new Date(feedNow).toISOString(),
    };
    await db.query("UPDATE ed_encounters SET published = $2 WHERE id = $1", [encounter.id, next]);
    await logEstimate(db, encounter.id, feedNow, result, reason, true);
    const why = publish.kind === "first" ? null : reasonSentence(reason);
    const lead =
      publish.kind === "overrun"
        ? "This is taking longer than we said, and we've asked the triage nurse to check on you. "
        : publish.kind === "first"
          ? ""
          : "Your estimate has changed. ";
    await tellRange(
      db,
      encounter,
      `${lead}${rangeSentence(result.lowMinutes, result.highMinutes, "patient")}${why ? ` ${why}` : ""}`,
      () =>
        `${rangeSentence(result.lowMinutes, result.highMinutes, "contact")}${why ? ` ${why}` : ""}`,
      now,
      publish.kind,
      defer,
    );
    if (publish.kind === "overrun")
      await db.query(
        `INSERT INTO ed_staff_tasks (id, encounter_id, kind, priority, summary, created_at)
         VALUES ($1,$2,'recheck',2,$3,$4)`,
        [
          randomUUID(),
          encounter.id,
          "Waited past the estimated time. Please check on this patient.",
          now,
        ],
      );
  }
  await checkIns(db, encounters, feedNow, now, defer);
}

/** Minutes between "how are you feeling?" questions while waiting, by triage level. */
const CHECK_IN_EVERY: Record<number, number> = { 1: 15, 2: 15, 3: 30, 4: 45, 5: 60 };

/**
 * Timer-driven check-ins. The clock is the feed's, so an accelerated or replayed feed asks
 * at the right moments. The agent may put a question off, but not past twice the interval.
 */
export async function checkIns(
  db: Database,
  encounters: readonly Encounter[],
  feedNow: number,
  now: Date,
  defer = false,
) {
  const waiting = encounters.filter(
    (item) => item.state.step === "waiting" && item.state.ctas && item.state.triagedAt,
  );
  if (waiting.length === 0) return;
  const pending = await db.query<{ encounterId: string }>(
    `SELECT encounter_id AS "encounterId" FROM ed_agent_wakes
     WHERE reason = 'check_in_due' AND settled_at IS NULL AND encounter_id = ANY($1)`,
    [waiting.map((item) => item.id)],
  );
  const queued = new Set(pending.rows.map((row) => row.encounterId));
  for (const encounter of waiting) {
    if (queued.has(encounter.id)) continue;
    const every = CHECK_IN_EVERY[encounter.state.ctas!]! * MIN;
    const memory = (
      await db.query<{ agent: Encounter["agent"] }>(
        "SELECT agent FROM ed_encounters WHERE id = $1",
        [encounter.id],
      )
    ).rows[0]!.agent;
    const since = feedNow - (memory.lastCheckInAskAt ?? Date.parse(encounter.state.triagedAt!));
    if (since < every) continue;
    const overdue = since >= 2 * every;
    if (memory.nextCheckInAt && feedNow < memory.nextCheckInAt && !overdue) continue;
    const decision = decideDisclosure({
      audience: "patient",
      verified: true,
      consentScopes: null,
      state: encounter.state,
      feedLastMessageAt: now,
      now,
      request: "status",
    });
    if (decision.outcome !== "allow") continue;
    await wakeAgent(
      db,
      encounter,
      "check_in_due",
      {
        candidates: [
          {
            id: "check_in",
            tool: "ask_check_in",
            audience: "patient",
            kind: "check_in_ask",
            body: CHECK_IN_ASK,
            requires: "status",
            step: "waiting",
            floor: overdue,
          },
        ],
        note: overdue ? "overdue" : "due",
      },
      now,
      defer,
    );
  }
}

/** The wait range from the trained model, in the shape the formula path returns. */
function modelWait(stages: SiteStages | null, encounterId: string): EstimateResult | null {
  const estimate = stages?.estimates.get(encounterId)?.find((item) => item.stage === "provider");
  const features = stages?.snapshot.byVisit.get(encounterId);
  if (!estimate || !features) return null;
  const raz = features.raz === 1;
  return rangeFromModel(estimate.lowMinutes, estimate.highMinutes, {
    ahead: (features.ahead_urgent ?? 0) + (features.ahead_same ?? 0),
    pacePerHour: (raz ? features.starts_60_raz : features.starts_60_main) ?? 0,
    moreUrgentPerHour: features.urgent_arrivals_stream_60 ?? 0,
    pointMinutes: estimate.typicalMinutes,
  });
}

async function tellRange(
  db: Database,
  encounter: Encounter,
  patientBody: string,
  contactBody: () => string,
  now: Date,
  kind: string,
  defer: boolean,
) {
  // A first range, a wait that has run over and "too busy to estimate" always reach the
  // patient. Whether an ordinary change is worth a message is the agent's call.
  const floor = kind === "first" || kind === "overrun" || kind === "busy";
  const limited = kind === "worse" || kind === "better";
  const candidates: Candidate[] = [
    {
      id: "patient",
      tool: "notify",
      audience: "patient",
      kind: "range",
      body: patientBody,
      requires: "estimate",
      floor,
      limited,
    },
  ];
  for (const contact of await activeContacts(db, encounter.id)) {
    const decision = decideDisclosure({
      audience: "contact",
      verified: true,
      consentScopes: contact.scopes,
      state: encounter.state,
      feedLastMessageAt: now,
      now,
      request: "estimate",
    });
    if (decision.outcome !== "allow" || !decision.estimate || !contact.scopes.includes("alerts"))
      continue;
    candidates.push({
      id: `contact:${contact.id}`,
      tool: "notify",
      audience: "contact",
      contactId: contact.id,
      kind: "range",
      body: contactBody(),
      requires: "estimate",
      proactive: true,
      limited,
      floor: kind === "overrun",
    });
  }
  await wakeAgent(db, encounter, "estimate_shift", { candidates, note: kind }, now, defer);
}

async function logEstimate(
  db: Database,
  encounterId: string,
  feedNow: number,
  result: { lowMinutes: number; highMinutes: number; basis: object } | null,
  note: string,
  published: boolean,
) {
  await db.query(
    `INSERT INTO ed_estimates (encounter_id, computed_at, low_minutes, high_minutes, abstain, reason, basis, published)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      encounterId,
      new Date(feedNow),
      result?.lowMinutes ?? null,
      result?.highMinutes ?? null,
      result ? null : note,
      result ? note : null,
      result?.basis ?? {},
      published,
    ],
  );
}

/** Links the visit to a portal identity only on an exact, unambiguous name and birthday match. */
async function knownPatient(db: Database, name: string, dateOfBirth: string | null) {
  if (!name || !dateOfBirth) return null;
  const result = await db.query<{ id: string }>(
    `SELECT p.id FROM patients p JOIN emergency_patient_records e ON e.patient_id = p.id
     WHERE lower(p.display_name) = lower($1) AND e.date_of_birth = $2::date LIMIT 2`,
    [name, dateOfBirth],
  );
  return result.rows.length === 1 ? result.rows[0]!.id : null;
}

const titleCase = (value: string) =>
  value
    .toLowerCase()
    .replace(
      /(^|[\s'-])([a-z])/g,
      (_match, lead: string, letter: string) => lead + letter.toUpperCase(),
    );
