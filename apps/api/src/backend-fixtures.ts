import type { Pool } from "pg";
import { seed } from "./fixtures.js";
import { seedIdentity } from "./identity-fixtures.js";
import { seedScheduler } from "./scheduler-fixtures.js";
import { MockScheduler } from "./scheduler.js";
import type { WorkflowRecord } from "./domain.js";

export async function seedBackend(pool: Pool, now = new Date()) {
  await seedIdentity(pool);
  await seedScheduler(pool, now);
  await seed(pool);
  const scheduler = new MockScheduler(pool, { now: () => now });
  const slot = (await scheduler.getSlot("synthetic-slot-002"))!;
  const workflow: WorkflowRecord = {
    appointmentId: "synthetic-appointment-001",
    availability: {
      startsAt: slot.startsAt,
      endsAt: new Date(Date.parse(slot.endsAt) + 3_600_000).toISOString(),
      timeZone: "America/Halifax",
    },
    callbackWindow: {
      startsAt: now.toISOString(),
      endsAt: new Date(now.getTime() + 3_600_000).toISOString(),
      timeZone: "America/Halifax",
    },
    requireStaffApproval: true,
  };
  await pool.query(
    "INSERT INTO workflow_tasks (task_id,payload) VALUES ('T001',$1) ON CONFLICT DO NOTHING",
    [workflow],
  );
}
