import type { Pool } from "pg";
import { field, hl7Time, parseHl7, segment } from "../opor/hl7.js";
import { decideDisclosure } from "./guardian.js";
import { hashLink } from "./intake.js";
import { HANDOFF_REPLY, duration, rangeSentence, statusSentence, stepLabels } from "./messages.js";
import { feedStatus, type Contact, type Encounter } from "./records.js";
import { recalibrationBySite } from "./recalibration.js";
import type { Stage } from "./stage-model.js";
import { wideningBySite } from "./widening.js";

// Read-only views beyond the Desk: the family page, the accuracy ledger and mission control.

const encounterColumns = `e.id, e.site, e.department_id AS "departmentId", e.visit_number AS "visitNumber",
  e.patient_id AS "patientId", e.display_name AS "displayName", e.facts, e.state, e.published,
  e.agent, e.updated_at AS "updatedAt"`;

/** The contact a family link belongs to, or null. A withdrawn contact's link stops working at once. */
export async function contactByLink(pool: Pool, token: string) {
  if (!/^[A-Za-z0-9_-]{32}$/.test(token)) return null;
  const result = await pool.query<
    Encounter & {
      contactId: string;
      name: string;
      relationship: string;
      phone: string;
      scopes: Contact["scopes"];
    }
  >(
    `SELECT ${encounterColumns}, c.id AS "contactId", c.name, c.relationship, c.phone, c.scopes
     FROM ed_contacts c JOIN ed_encounters e ON e.id = c.encounter_id
     WHERE c.link_hash = $1 AND c.withdrawn_at IS NULL`,
    [hashLink(token)],
  );
  const row = result.rows[0];
  if (!row) return null;
  const { contactId, name, relationship, phone, scopes, ...encounter } = row;
  return {
    encounter: encounter as Encounter,
    contact: { id: contactId, name, relationship, phone, scopes },
  };
}

/**
 * What an approved contact sees on their private page: the step in the third person, and the
 * wait range only if the patient shared estimates. A bad link, a withdrawn contact and a
 * silenced visit all look the same from outside.
 */
export async function familyView(pool: Pool, token: string, now: Date) {
  const found = await contactByLink(pool, token);
  const closed = { mode: "handoff" as const, message: HANDOFF_REPLY };
  if (!found) return closed;
  const { encounter, contact } = found;
  const feed = await feedStatus(pool, encounter.site);
  const decision = decideDisclosure({
    audience: "contact",
    // Holding the link stands in for the one-time code: it was sent only to the number the
    // patient entered. The phone line still asks for a code.
    verified: true,
    consentScopes: contact.scopes,
    state: encounter.state,
    feedLastMessageAt: feed?.lastMessageAt ?? null,
    now,
    request: "estimate",
  });
  if (decision.outcome !== "allow") return closed;
  const { state } = encounter;
  const firstName = encounter.displayName.split(" ")[0] ?? "";
  const published = decision.estimate ? encounter.published : null;
  const messages = await pool.query(
    `SELECT id, direction, kind, body, created_at AS "at" FROM ed_messages
     WHERE encounter_id = $1 AND contact_id = $2 ORDER BY seq`,
    [encounter.id, contact.id],
  );
  return {
    mode: "live" as const,
    patientFirstName: firstName,
    contactFirstName: contact.name.split(" ")[0] ?? "",
    steps: stepLabels,
    friendlyStep: state.friendlyStep,
    step: state.step,
    sentence: statusSentence(state, "contact", firstName),
    ended: state.ended,
    range: published
      ? {
          headline: `Within about ${duration(published.highMinutes)}`,
          sentence: rangeSentence(published.lowMinutes, published.highMinutes, "contact"),
          updatedAt: published.at,
        }
      : null,
    sharesEstimates: contact.scopes.includes("estimates"),
    lastUpdatedAt: encounter.updatedAt.toISOString(),
    messages: messages.rows.map((row) => ({ ...row, at: row.at.toISOString() })),
  };
}

const round = (value: number | null) => (value === null ? null : Math.round(Number(value)));

/** Predicted against actual for every step, so staff can see how far to trust the ranges. */
export async function accuracyView(pool: Pool, departmentId: string, site: string) {
  const scored = `s.actual_minutes IS NOT NULL AND (NOT s.censored OR s.actual_minutes > s.high_minutes)`;
  const stages = await pool.query(
    `SELECT s.stage,
            count(*)::int AS total,
            count(*) FILTER (WHERE s.actual_minutes BETWEEN s.low_minutes AND s.high_minutes
                             AND NOT s.censored)::int AS inside,
            count(*) FILTER (WHERE s.actual_minutes > s.high_minutes)::int AS over,
            count(*) FILTER (WHERE s.actual_minutes < s.low_minutes AND NOT s.censored)::int AS under,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(s.actual_minutes - s.typical_minutes))
              FILTER (WHERE NOT s.censored) AS "medianError",
            avg(s.high_minutes - s.low_minutes) AS "meanWidth",
            count(DISTINCT s.encounter_id)::int AS visits
     FROM ed_stage_estimates s JOIN ed_encounters c ON c.id = s.encounter_id
     WHERE c.department_id = $1 AND ${scored}
     GROUP BY s.stage`,
    [departmentId],
  );
  const open = await pool.query<{ stage: string; n: number }>(
    `SELECT s.stage, count(*)::int AS n
     FROM ed_stage_estimates s JOIN ed_encounters c ON c.id = s.encounter_id
     WHERE c.department_id = $1 AND s.actual_minutes IS NULL GROUP BY s.stage`,
    [departmentId],
  );
  // One point per visit and step: the first estimate made, which is the hardest one.
  const points = await pool.query(
    `SELECT * FROM (
       SELECT DISTINCT ON (s.encounter_id, s.stage)
              s.stage, c.display_name AS "patientName", s.computed_at AS "computedAt",
              s.low_minutes AS low, s.typical_minutes AS typical, s.high_minutes AS high,
              s.actual_minutes AS actual, s.censored
       FROM ed_stage_estimates s JOIN ed_encounters c ON c.id = s.encounter_id
       WHERE c.department_id = $1 AND ${scored}
       ORDER BY s.encounter_id, s.stage, s.computed_at) first
     ORDER BY "computedAt" DESC LIMIT 200`,
    [departmentId],
  );
  const published = await pool.query<{
    total: number;
    inside: number;
    over: number;
    abstained: number;
    told: number;
  }>(
    `SELECT count(*) FILTER (WHERE e.abstain IS NULL AND e.actual_minutes IS NOT NULL)::int AS total,
            count(*) FILTER (WHERE e.abstain IS NULL
              AND e.actual_minutes BETWEEN e.low_minutes AND e.high_minutes)::int AS inside,
            count(*) FILTER (WHERE e.abstain IS NULL AND e.actual_minutes > e.high_minutes)::int AS over,
            count(*) FILTER (WHERE e.abstain IS NOT NULL)::int AS abstained,
            count(*)::int AS told
     FROM ed_estimates e JOIN ed_encounters c ON c.id = e.encounter_id
     WHERE c.department_id = $1 AND e.published`,
    [departmentId],
  );
  const model = await pool.query<{ version: string }>(
    `SELECT model_version AS version FROM ed_stage_estimates ORDER BY id DESC LIMIT 1`,
  );
  const widening = await wideningBySite(pool, site);
  const local = await recalibrationBySite(pool, site);
  const waiting = new Map(open.rows.map((row) => [row.stage, row.n]));
  return {
    model: model.rows[0]?.version ?? null,
    target: 80,
    stages: stages.rows.map((row) => ({
      stage: row.stage as string,
      total: row.total as number,
      inside: row.inside as number,
      over: row.over as number,
      under: row.under as number,
      visits: row.visits as number,
      medianErrorMinutes: round(row.medianError),
      meanWidthMinutes: round(row.meanWidth),
      awaitingOutcome: waiting.get(row.stage) ?? 0,
      widening: widening.get(row.stage) ?? 1,
      localScale: local.get(row.stage as Stage) ?? 1,
    })),
    points: points.rows.map((row) => ({
      stage: row.stage as string,
      patientName: row.patientName as string,
      computedAt: (row.computedAt as Date).toISOString(),
      low: round(row.low)!,
      typical: round(row.typical)!,
      high: round(row.high)!,
      actual: round(row.actual)!,
      censored: row.censored as boolean,
    })),
    published: published.rows[0] ?? { total: 0, inside: 0, over: 0, abstained: 0, told: 0 },
  };
}

const maskNumber = (value: string) =>
  `${"•".repeat(Math.max(0, value.length - 4))}${value.slice(-4)}`;

/** One HL7 message as a line on the feed panel: its type, the visit it is about, and its text. */
function feedLine(raw: string) {
  try {
    const message = parseHl7(raw);
    const type = field(segment(message, "MSH"), 9).replace("^", " ");
    const name = field(segment(message, "PID"), 5).split("^").reverse().join(" ").trim();
    // When it happened in the department (MSH-7), which is what the clock on screen shows.
    const sentAt = hl7Time(field(segment(message, "MSH"), 7), "-0400");
    // Orders and results: which order, so one patient's lab, scan and consult at the same
    // minute read as three different messages, not one message three times.
    const obr = segment(message, "OBR");
    const orderId = field(obr, 2) || null;
    const section = field(obr, 24);
    return {
      type,
      name: name.toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase()),
      sentAt,
      orderId,
      detail: section ? (SECTIONS[section] ?? section) : null,
    };
  } catch {
    return { type: "unreadable", name: "", sentAt: null, orderId: null, detail: null };
  }
}

const SECTIONS: Record<string, string> = {
  LAB: "lab",
  XR: "X-ray",
  CT: "CT",
  US: "ultrasound",
  MR: "MRI",
  RAD: "imaging",
  CON: "consult",
};

/** A result names its order's section, found from the order message when the result lacks it. */
function withSections<T extends { orderId: string | null; detail: string | null }>(
  lines: T[],
): T[] {
  const known = new Map<string, string>();
  for (const line of lines) if (line.orderId && line.detail) known.set(line.orderId, line.detail);
  return lines.map((line) =>
    line.detail || !line.orderId
      ? line
      : { ...line, detail: known.get(line.orderId) ?? `order ${line.orderId}` },
  );
}

/** Mission control: the hospital feed, the agent's decisions and what people received, side by side. */
export async function missionView(pool: Pool, departmentId: string, site: string, now: Date) {
  const feed = await feedStatus(pool, site);
  const messages = await pool.query<{
    controlId: string;
    receivedAt: Date;
    outcome: string;
    raw: string;
  }>(
    `SELECT control_id AS "controlId", received_at AS "receivedAt", outcome, raw
     FROM opor_messages WHERE site = $1 ORDER BY received_at DESC, control_id DESC LIMIT 30`,
    [site],
  );
  const runs = await pool.query(
    `SELECT r.id, r.wake, r.planner, r.model, r.fallback_reason AS "fallbackReason", r.plan,
            r.latency_ms AS "latencyMs", r.created_at AS "at", c.display_name AS "patientName"
     FROM ed_agent_runs r JOIN ed_encounters c ON c.id = r.encounter_id
     WHERE c.department_id = $1 ORDER BY r.seq DESC LIMIT 30`,
    [departmentId],
  );
  const thread = await pool.query(
    `SELECT m.id, m.audience, m.direction, m.channel, m.kind, m.body, m.created_at AS "at",
            c.display_name AS "patientName", k.relationship
     FROM ed_messages m JOIN ed_encounters c ON c.id = m.encounter_id
     LEFT JOIN ed_contacts k ON k.id = m.contact_id
     WHERE c.department_id = $1 ORDER BY m.seq DESC LIMIT 30`,
    [departmentId],
  );
  const texts = await pool.query(
    `SELECT s.id, s.to_number AS "to", s.body, s.status, s.created_at AS "at"
     FROM ed_sms s JOIN ed_encounters c ON c.id = s.encounter_id
     WHERE c.department_id = $1 ORDER BY s.seq DESC LIMIT 12`,
    [departmentId],
  );
  const totals = await pool.query<{
    runs: number;
    modelRuns: number;
    denied: number;
    held: number;
    messages: number;
    tasks: number;
    open: number;
  }>(
    `SELECT
       (SELECT count(*)::int FROM ed_agent_runs r JOIN ed_encounters c ON c.id = r.encounter_id
         WHERE c.department_id = $1) AS runs,
       (SELECT count(*)::int FROM ed_agent_runs r JOIN ed_encounters c ON c.id = r.encounter_id
         WHERE c.department_id = $1 AND r.planner = 'model') AS "modelRuns",
       (SELECT count(*)::int FROM ed_agent_runs r JOIN ed_encounters c ON c.id = r.encounter_id,
          jsonb_array_elements(r.plan) step
         WHERE c.department_id = $1 AND step->>'verdict' = 'denied') AS denied,
       (SELECT count(*)::int FROM ed_agent_runs r JOIN ed_encounters c ON c.id = r.encounter_id,
          jsonb_array_elements(r.plan) step
         WHERE c.department_id = $1 AND step->>'tool' = 'do_nothing') AS held,
       (SELECT count(*)::int FROM ed_messages m JOIN ed_encounters c ON c.id = m.encounter_id
         WHERE c.department_id = $1 AND m.direction = 'out') AS messages,
       (SELECT count(*)::int FROM ed_staff_tasks t JOIN ed_encounters c ON c.id = t.encounter_id
         WHERE c.department_id = $1) AS tasks,
       (SELECT count(*)::int FROM ed_encounters c
         WHERE c.department_id = $1 AND NOT (c.state->>'ended')::boolean) AS open`,
    [departmentId],
  );
  return {
    feed: feed
      ? {
          lastMessageAt: feed.lastMessageAt.toISOString(),
          feedTime: feed.feedTime.toISOString(),
          stale: now.getTime() - feed.lastMessageAt.getTime() > 15 * 60_000,
        }
      : null,
    hl7: withSections(
      messages.rows.map((row) => ({
        id: row.controlId,
        at: row.receivedAt.toISOString(),
        outcome: row.outcome,
        ...feedLine(row.raw),
        raw: row.raw.replaceAll("\r", "\n"),
      })),
    ),
    runs: runs.rows.map((row) => ({ ...row, at: (row.at as Date).toISOString() })),
    thread: thread.rows.map((row) => ({ ...row, at: (row.at as Date).toISOString() })),
    texts: texts.rows.map((row) => ({
      ...row,
      to: maskNumber(row.to as string),
      at: (row.at as Date).toISOString(),
    })),
    totals: totals.rows[0]!,
  };
}
