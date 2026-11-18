import type { Pool } from "pg";
import { BackendError } from "../domain.js";
import { decideDisclosure, mayShareOutlook, type GuardianInput } from "./guardian.js";
import {
  HANDOFF_REPLY,
  duration,
  STALE_REPLY,
  WORSE_LINE,
  outlookLabel,
  outlookSentence,
  rangeSentence,
  reasonSentence,
  statusSentence,
  stepLabels,
} from "./messages.js";
import type { RangeReason } from "./estimate.js";
import {
  activeContacts,
  feedStatus,
  latestEncounterForPatient,
  openEncounters,
} from "./records.js";
import { siteStages, stageAccuracy, type SiteStages } from "./stage-estimates.js";
import { displayRange, type StageEstimate } from "./stage-model.js";

const MIN = 60_000;

/** What the patient's own page shows. Built after the Guardian's decision, never before. */
export async function patientVisitView(pool: Pool, patientId: string, now: Date) {
  const encounter = await latestEncounterForPatient(pool, patientId);
  if (!encounter) return { mode: "none" as const };
  const feed = await feedStatus(pool, encounter.site);
  const guard: GuardianInput = {
    audience: "patient",
    verified: true,
    consentScopes: null,
    state: encounter.state,
    feedLastMessageAt: feed?.lastMessageAt ?? null,
    now,
    request: "estimate",
  };
  const decision = decideDisclosure(guard);
  if (decision.outcome !== "allow")
    return {
      mode: "handoff" as const,
      message:
        "reason" in decision && decision.reason === "feed_stale" ? STALE_REPLY : HANDOFF_REPLY,
      worseLine: WORSE_LINE,
    };

  const { state } = encounter;
  const firstName = encounter.displayName.split(" ")[0] ?? "";
  const published = decision.estimate ? encounter.published : null;
  const messages = await pool.query(
    `SELECT id, direction, kind, body, created_at AS "at" FROM ed_messages
     WHERE encounter_id = $1 AND audience = 'patient' ORDER BY seq`,
    [encounter.id],
  );
  const lastCheckIn = await pool.query<{ at: Date }>(
    `SELECT max(created_at) AS at FROM ed_messages
     WHERE encounter_id = $1 AND audience = 'patient' AND kind = 'check_in'`,
    [encounter.id],
  );
  const sinceTriage =
    state.triagedAt && feed ? (feed.feedTime.getTime() - Date.parse(state.triagedAt)) / MIN : 0;
  const quietFor = lastCheckIn.rows[0]?.at
    ? (now.getTime() - lastCheckIn.rows[0].at.getTime()) / MIN
    : Infinity;
  const stages =
    feed && mayShareOutlook(guard)
      ? await siteStages(pool, encounter.site, feed.feedTime.getTime())
      : null;
  return {
    mode: "live" as const,
    firstName,
    steps: stepLabels,
    friendlyStep: state.friendlyStep,
    step: state.step,
    sentence: statusSentence(state, "patient", firstName),
    badges: {
      testsInProgress: state.testsInProgress,
      resultsReady: state.resultsReady,
      consultRequested: state.consultRequested,
      bedRequested: state.bedRequested,
    },
    range: published
      ? {
          lowMinutes: published.lowMinutes,
          highMinutes: published.highMinutes,
          headline: `Within about ${duration(published.highMinutes)}`,
          sentence: rangeSentence(published.lowMinutes, published.highMinutes, "patient"),
          reason: reasonSentence(published.reason as RangeReason),
          updatedAt: published.at,
        }
      : null,
    // Typical times for the steps still ahead. The wait to be seen is the range above.
    outlook: patientOutlook(stages, encounter.id, state.step === "waiting"),
    ended: state.ended,
    canLeave: state.step === "waiting" || state.step === "arrived",
    // Ask how the patient is feeling once they have waited a while, at most every half hour.
    checkInDue: state.step === "waiting" && sinceTriage >= 30 && quietFor >= 30,
    worseLine: WORSE_LINE,
    lastUpdatedAt: encounter.updatedAt.toISOString(),
    messages: messages.rows.map((row) => ({ ...row, at: row.at.toISOString() })),
    contacts: (await activeContacts(pool, encounter.id)).map((contact) => ({
      id: contact.id,
      name: contact.name,
      relationship: contact.relationship,
      phoneEnding: contact.phone.slice(-4),
      scopes: contact.scopes,
    })),
  };
}

/** Later steps a patient may be told about. A range too wide to be information is left out. */
const OUTLOOK_WIDEST: Record<"triage" | "results" | "decision", number> = {
  triage: 120,
  results: 360,
  decision: 720,
};

function patientOutlook(stages: SiteStages | null, encounterId: string, waiting: boolean) {
  const out = [];
  for (const estimate of stages?.estimates.get(encounterId) ?? []) {
    const { stage } = estimate;
    if (stage !== "triage" && stage !== "results" && stage !== "decision") continue;
    const range = displayRange(estimate, OUTLOOK_WIDEST[stage]);
    if (!range) continue;
    out.push({
      stage,
      label: outlookLabel(stage, waiting),
      ...range,
      headline: `Within about ${duration(range.highMinutes)}`,
      sentence: outlookSentence(stage, range.lowMinutes, range.highMinutes, "patient", waiting),
    });
  }
  return out;
}

/** Staff see every step, including the wait for a bed, as plain rounded minutes. */
const staffStages = (list: readonly StageEstimate[] | undefined) =>
  (list ?? []).map((estimate) => ({
    stage: estimate.stage,
    lowMinutes: Math.max(0, Math.floor(estimate.lowMinutes / 5) * 5),
    typicalMinutes: Math.round(estimate.typicalMinutes / 5) * 5,
    highMinutes: Math.ceil(estimate.highMinutes / 5) * 5,
  }));

/** The staff Desk: who is here, what needs a person, and how accurate the estimates have been. */
export async function deskView(pool: Pool, departmentId: string, site: string, now: Date) {
  const feed = await feedStatus(pool, site);
  const encounters = (await openEncounters(pool, site)).filter(
    (encounter) => encounter.departmentId === departmentId,
  );
  const tasks = await pool.query(
    `SELECT t.id, t.encounter_id AS "encounterId", t.kind, t.priority, t.summary,
            t.created_at AS "createdAt", c.display_name AS "patientName", c.state
     FROM ed_staff_tasks t JOIN ed_encounters c ON c.id = t.encounter_id
     WHERE t.state = 'open' AND c.department_id = $1 ORDER BY t.priority, t.created_at`,
    [departmentId],
  );
  const accuracy = await pool.query<{ total: number; inside: number; over: number }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE actual_minutes BETWEEN low_minutes AND high_minutes)::int AS inside,
            count(*) FILTER (WHERE actual_minutes > high_minutes)::int AS over
     FROM ed_estimates e JOIN ed_encounters c ON c.id = e.encounter_id
     WHERE c.department_id = $1 AND e.published AND e.abstain IS NULL AND e.actual_minutes IS NOT NULL`,
    [departmentId],
  );
  const ledger = await pool.query(
    `SELECT a.seq, a.at, a.actor, a.action, a.detail, c.display_name AS "patientName"
     FROM ed_audit a LEFT JOIN ed_encounters c ON c.id = a.encounter_id
     WHERE c.department_id = $1 OR a.encounter_id IS NULL ORDER BY a.seq DESC LIMIT 40`,
    [departmentId],
  );
  const runs = await pool.query(
    `SELECT r.id, r.wake, r.planner, r.model, r.fallback_reason AS "fallbackReason", r.plan,
            r.latency_ms AS "latencyMs", r.created_at AS "at", c.display_name AS "patientName"
     FROM ed_agent_runs r JOIN ed_encounters c ON c.id = r.encounter_id
     WHERE c.department_id = $1 ORDER BY r.seq DESC LIMIT 12`,
    [departmentId],
  );
  const feedTime = feed?.feedTime.getTime() ?? now.getTime();
  const stages = feed ? await siteStages(pool, site, feedTime) : null;
  return {
    feed: feed
      ? {
          lastMessageAt: feed.lastMessageAt.toISOString(),
          feedTime: feed.feedTime.toISOString(),
          stale: now.getTime() - feed.lastMessageAt.getTime() > 15 * MIN,
        }
      : null,
    patients: encounters.map((encounter) => ({
      id: encounter.id,
      name: encounter.displayName,
      step: encounter.state.step,
      ctas: encounter.state.ctas,
      stream: encounter.state.stream,
      area: encounter.state.area,
      flags: encounter.state.sensitivity,
      unmapped: encounter.state.unmapped,
      testsInProgress: encounter.state.testsInProgress,
      waitingMinutes:
        encounter.state.step === "waiting" && encounter.state.triagedAt
          ? Math.max(0, Math.round((feedTime - Date.parse(encounter.state.triagedAt)) / MIN))
          : null,
      minutesInDepartment: encounter.state.arrivedAt
        ? Math.max(0, Math.round((feedTime - Date.parse(encounter.state.arrivedAt)) / MIN))
        : null,
      // A range only means something while the patient is still waiting to be seen.
      // toldAt lets the Desk see when the time the patient was told has run out.
      range:
        encounter.published && encounter.state.step === "waiting"
          ? {
              lowMinutes: encounter.published.lowMinutes,
              highMinutes: encounter.published.highMinutes,
              toldAt: encounter.published.at,
            }
          : null,
      // Model estimates for every step still ahead. Staff only: includes the wait for a bed.
      stages: staffStages(stages?.estimates.get(encounter.id)),
    })),
    tasks: tasks.rows.map((task) => ({
      id: task.id,
      encounterId: task.encounterId,
      kind: task.kind,
      priority: task.priority,
      summary: task.summary,
      patientName: task.patientName,
      ctas: task.state.ctas,
      createdAt: task.createdAt.toISOString(),
    })),
    accuracy: accuracy.rows[0] ?? { total: 0, inside: 0, over: 0 },
    stageAccuracy: await stageAccuracy(pool, departmentId),
    model: stages ? { version: stages.model.version, trainedAt: stages.model.createdAt } : null,
    // What the Visit Agent decided most recently, and why, for anyone who wants to check it.
    agent: { runs: runs.rows.map((row) => ({ ...row, at: (row.at as Date).toISOString() })) },
    ledger: ledger.rows.map((row) => ({ ...row, at: row.at.toISOString() })),
  };
}

export function requireDepartment(departmentId: string | null): string {
  if (!departmentId) throw new BackendError("not_found", 404);
  return departmentId;
}
