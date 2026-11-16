import type { EdEventKind, VisitState } from "@prc/contracts";
import type { Pool } from "pg";
import { BackendError } from "../domain.js";
import { stepLabels } from "./messages.js";
import { activeContacts, encounterById, feedStatus } from "./records.js";
import { ageAt, siteStages } from "./stage-estimates.js";

// One visit in full, for staff: who, where they are in each step, every event the hospital
// record sent, the estimates, who has been told what, and what the Visit Agent decided.
// Department-scoped like the Desk. There is still nothing clinical to show: the feed carries
// steps and order kinds, never reasons for visit or results.

const MIN = 60_000;

const sections: Record<string, string> = {
  lab: "Bloodwork",
  xray: "X-ray",
  ct: "CT scan",
  ultrasound: "Ultrasound",
  mri: "MRI",
  imaging: "Imaging",
  other: "Test",
};
const flagNames: Record<string, string> = {
  confidential: "Confidential",
  vip: "Protected (VIP)",
  security: "Security alert",
  deceased: "Deceased",
  critical: "Critical",
};

type Row = {
  kind: EdEventKind;
  at: Date;
  source: string;
  detail: {
    ctas?: number;
    area?: string;
    stream?: string;
    orderId?: string;
    orderType?: string;
    modality?: string;
    flag?: string;
    trigger?: string;
  };
};

/** A plain sentence for each event, the way a charge nurse would say it. */
export function eventLabel(row: Row, orders: Map<string, string>): string {
  const { detail } = row;
  const order = detail.orderId ? (orders.get(detail.orderId) ?? "Test") : "Test";
  switch (row.kind) {
    case "arrived":
      return detail.stream === "rapid_assessment"
        ? "Arrived, rapid assessment stream"
        : "Arrived and registered";
    case "triaged":
      return `Triaged, level ${detail.ctas}`;
    case "location_changed":
      return detail.area ? `Moved to ${detail.area}` : "Moved";
    case "provider_assigned":
      return "Seen by a clinician";
    case "order_placed":
      return `${order} ordered`;
    case "result_available":
      return `${order} result back`;
    case "order_cancelled":
      return `${order} cancelled`;
    case "consult_requested":
      return "Specialist consult requested";
    case "admit_decision":
      return "Decision to admit";
    case "bed_requested":
      return "Inpatient bed requested";
    case "moved_to_unit":
      return detail.area ? `Moved to unit ${detail.area}` : "Moved to an inpatient unit";
    case "discharged":
      return "Discharged";
    case "left_without_being_seen":
      return "Left before being seen";
    case "cancelled":
      return "Registration cancelled";
    case "flag_set":
      return `${flagNames[detail.flag ?? ""] ?? "Flag"} set`;
    case "flag_cleared":
      return `${flagNames[detail.flag ?? ""] ?? "Flag"} cleared`;
    case "unmapped":
      return `Message needs review (${detail.trigger ?? "unknown"})`;
  }
}

/** The five steps people see, with when each began. A step that was skipped stays empty. */
export function stepTimes(state: VisitState, rows: readonly Row[]) {
  const first = (kinds: EdEventKind[], after: string | null = null) =>
    rows
      .find((row) => kinds.includes(row.kind) && (!after || row.at.getTime() >= Date.parse(after)))
      ?.at.toISOString() ?? null;
  // Tests that start in the waiting room belong to the wait, not to step four. The step is
  // dated from the first test after the patient was seen, so the list never runs backwards.
  const tests = state.providerAt ? first(["order_placed"], state.providerAt) : null;
  const starts = [
    state.arrivedAt,
    state.triagedAt,
    state.providerAt,
    tests,
    first(["admit_decision", "discharged", "left_without_being_seen", "moved_to_unit"]),
  ];
  return stepLabels.map((label, index) => {
    const number = index + 1;
    return {
      label,
      at: starts[index] ?? null,
      state:
        state.ended || number < state.friendlyStep
          ? "done"
          : number === state.friendlyStep
            ? "now"
            : "next",
    };
  });
}

export async function encounterDetail(
  pool: Pool,
  departmentId: string,
  encounterId: string,
  now: Date,
) {
  const encounter = await encounterById(pool, encounterId);
  if (!encounter || encounter.departmentId !== departmentId)
    throw new BackendError("not_found", 404);
  const { state } = encounter;
  const feed = await feedStatus(pool, encounter.site);
  const feedNow = feed?.feedTime.getTime() ?? now.getTime();

  const [events, born, published, tasks, messages, runs] = await Promise.all([
    pool.query<Row>(
      `SELECT kind, occurred_at AS "at", source, detail FROM ed_events
       WHERE encounter_id = $1 ORDER BY occurred_at, seq`,
      [encounter.id],
    ),
    pool.query<{ dateOfBirth: string | null }>(
      `SELECT date_of_birth::text AS "dateOfBirth" FROM ed_encounters WHERE id = $1`,
      [encounter.id],
    ),
    pool.query(
      `SELECT computed_at AS "at", low_minutes AS low, high_minutes AS high, abstain,
              reason, actual_minutes AS actual
       FROM ed_estimates WHERE encounter_id = $1 AND published ORDER BY computed_at`,
      [encounter.id],
    ),
    pool.query(
      `SELECT id, kind, priority, summary, state, created_at AS "createdAt", closed_at AS "closedAt"
       FROM ed_staff_tasks WHERE encounter_id = $1 ORDER BY created_at`,
      [encounter.id],
    ),
    pool.query(
      `SELECT m.id, m.audience, m.direction, m.channel, m.kind, m.body, m.created_at AS "at",
              k.relationship
       FROM ed_messages m LEFT JOIN ed_contacts k ON k.id = m.contact_id
       WHERE m.encounter_id = $1 ORDER BY m.seq DESC LIMIT 30`,
      [encounter.id],
    ),
    pool.query(
      `SELECT id, wake, planner, model, fallback_reason AS "fallbackReason", plan,
              latency_ms AS "latencyMs", created_at AS "at"
       FROM ed_agent_runs WHERE encounter_id = $1 ORDER BY seq DESC LIMIT 15`,
      [encounter.id],
    ),
  ]);

  // Name each order once, so its result and cancellation read the same way.
  const orders = new Map<string, string>();
  for (const row of events.rows)
    if (row.kind === "order_placed" && row.detail.orderId)
      orders.set(
        row.detail.orderId,
        sections[row.detail.modality ?? row.detail.orderType ?? "other"] ?? "Test",
      );

  const stages = !state.ended && feed ? await siteStages(pool, encounter.site, feedNow) : null;
  const iso = (value: Date | null) => (value ? value.toISOString() : null);
  const since = (value: string | null) =>
    value ? Math.max(0, Math.round((feedNow - Date.parse(value)) / MIN)) : null;

  return {
    id: encounter.id,
    name: encounter.displayName,
    visitNumber: encounter.visitNumber,
    age: ageAt(born.rows[0]?.dateOfBirth ?? null, feedNow),
    step: state.step,
    friendlyStep: state.friendlyStep,
    ctas: state.ctas,
    stream: state.stream,
    area: state.area,
    flags: state.sensitivity,
    unmapped: state.unmapped,
    ended: state.ended,
    testsInProgress: state.testsInProgress,
    consultRequested: state.consultRequested,
    bedRequested: state.bedRequested,
    minutesInDepartment: state.ended
      ? state.arrivedAt && state.endedAt
        ? Math.round((Date.parse(state.endedAt) - Date.parse(state.arrivedAt)) / MIN)
        : null
      : since(state.arrivedAt),
    minutesWaiting: state.step === "waiting" ? since(state.triagedAt) : null,
    steps: stepTimes(state, events.rows),
    // When tests began before the patient was seen, which the step list leaves out.
    testsStartedWaiting:
      events.rows
        .find(
          (row) =>
            row.kind === "order_placed" &&
            (!state.providerAt || row.at.getTime() < Date.parse(state.providerAt)),
        )
        ?.at.toISOString() ?? null,
    timeline: events.rows.map((row) => ({
      at: row.at.toISOString(),
      kind: row.kind,
      source: row.source,
      label: eventLabel(row, orders),
    })),
    estimates: (stages?.estimates.get(encounter.id) ?? []).map((item) => ({
      stage: item.stage,
      lowMinutes: Math.max(0, Math.floor(item.lowMinutes / 5) * 5),
      typicalMinutes: Math.round(item.typicalMinutes / 5) * 5,
      highMinutes: Math.ceil(item.highMinutes / 5) * 5,
    })),
    published: published.rows.map((row) => ({
      at: (row.at as Date).toISOString(),
      low: row.low as number | null,
      high: row.high as number | null,
      abstain: row.abstain as string | null,
      reason: row.reason as string | null,
      actual: row.actual as number | null,
    })),
    contacts: (await activeContacts(pool, encounter.id)).map((contact) => ({
      id: contact.id,
      name: contact.name,
      relationship: contact.relationship,
      scopes: contact.scopes,
      texts: contact.smsOptInAt !== null,
    })),
    tasks: tasks.rows.map((row) => ({
      ...row,
      createdAt: (row.createdAt as Date).toISOString(),
      closedAt: iso(row.closedAt as Date | null),
    })),
    messages: messages.rows.map((row) => ({ ...row, at: (row.at as Date).toISOString() })),
    runs: runs.rows.map((row) => ({ ...row, at: (row.at as Date).toISOString() })),
  };
}
