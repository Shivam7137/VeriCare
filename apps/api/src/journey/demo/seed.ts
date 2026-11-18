import type { Pool } from "pg";
import { buildDemoScenario } from "../../twin/scenario.js";

// How the demo department opens: the same fictional shift as the OPOR Twin's scenario, split
// into what has already happened, what the featured visits will do later, and Maya's arrival.
// After that the director plays the department itself.

const MIN = 60_000;
export const MAYA_VISIT = "FIN5500001";
/** Visits that follow their own script (the featured edge cases) are left alone. */
export const SCRIPTED_PREFIX = "FIN57";
export const isScripted = (visit: string) => visit.startsWith(SCRIPTED_PREFIX);

/** Clears the fictional emergency visits. TRUNCATE is deliberate: the log and ledger refuse deletes. */
export async function wipeDepartment(pool: Pool) {
  await pool.query(
    `TRUNCATE ed_audit, ed_staff_tasks, ed_messages, ed_estimates, ed_stage_estimates, ed_contacts,
     ed_events, ed_agent_wakes, ed_agent_runs, ed_sms, ed_sms_inbound, opor_messages, opor_feed,
     ed_encounters RESTART IDENTITY CASCADE`,
  );
}

/**
 * The messages that open a fresh shift at `epoch`. `now` are sent at once: the people seen in
 * the last hour, the queue Maya joins, and Maya herself arriving. `later` are the featured
 * visits' own scripted steps, to be sent when the department clock reaches them.
 */
export function openingMessages(epoch: number): {
  now: string[];
  later: { at: number; raw: string[] }[];
} {
  const visitOf = (raw: string) => /(FIN\d+)\^\^\^/.exec(raw)?.[1] ?? "";
  const now: string[] = [];
  const later: { at: number; raw: string[] }[] = [];
  for (const message of buildDemoScenario(new Date(epoch), undefined, { featured: true })) {
    const visit = visitOf(message.raw);
    if (message.atMinute < 0) now.push(message.raw);
    else if (isScripted(visit))
      later.push({ at: epoch + message.atMinute * MIN, raw: [message.raw] });
    else if (visit === MAYA_VISIT && message.atMinute === 0) now.push(message.raw);
  }
  return { now, later: later.sort((a, b) => a.at - b.at) };
}
