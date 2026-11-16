import { randomUUID } from "node:crypto";
import type { StaffTaskKind } from "@prc/contracts";
import type { Database } from "../domain.js";
import { audit, type Encounter } from "./records.js";

// Safety floors. These run before, and regardless of, any language model:
// a message that sounds like someone getting sicker always reaches a nurse.
export const worseWords =
  /\b(worse|worst|chest pain|can'?t breathe|cannot breathe|short of breath|trouble breathing|faint(ed|ing)?|passing out|passed out|bleeding|dizzy|numb|confus(ed|ion)|severe|unbearable|suicid\w*|kill myself|collaps\w*)\b/i;
export const leavingWords =
  /\b(leaving|leave|going home|go home|walk(ing)? out|can'?t wait|give up|giving up)\b/i;
export const interpreterWords =
  /\b(interpreter|translat\w*|fran[cç]ais|french|arabic|mandarin|language)\b/i;
export const statusWords = /^\s*(status|update|how long|where am i)\b/i;

/** Adds to the Desk queue. Returns false when an open task of that kind already covers it. */
export async function openTask(
  db: Database,
  encounter: Pick<Encounter, "id">,
  kind: StaffTaskKind,
  priority: 1 | 2 | 3,
  summary: string,
  now: Date,
  contactId: string | null = null,
) {
  // One open task of a kind per visit is enough: repeat messages add to it, not to the queue.
  const existing = await db.query(
    "SELECT id FROM ed_staff_tasks WHERE encounter_id = $1 AND kind = $2 AND state = 'open'",
    [encounter.id, kind],
  );
  if (existing.rows[0]) return false;
  await db.query(
    `INSERT INTO ed_staff_tasks (id, encounter_id, kind, priority, summary, created_at, contact_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [randomUUID(), encounter.id, kind, priority, summary.slice(0, 240), now, contactId],
  );
  await audit(db, {
    at: now,
    actor: "visit-agent",
    action: `task_${kind}`,
    encounterId: encounter.id,
    detail: { priority },
  });
  return true;
}

export const waitedText = (encounter: Encounter, feedTime: Date | undefined) => {
  const from = encounter.state.triagedAt ?? encounter.state.arrivedAt;
  if (!from || !feedTime) return "";
  const minutes = Math.max(0, Math.round((feedTime.getTime() - Date.parse(from)) / 60_000));
  return ` Waited ${Math.floor(minutes / 60)} h ${minutes % 60} min.`;
};
export const triageText = (encounter: Encounter) =>
  encounter.state.ctas ? ` Triage level ${encounter.state.ctas}.` : "";
