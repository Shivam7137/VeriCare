import type { TestContext } from "node:test";
import { migrate } from "../../src/migrations.js";
import { isolatedDatabase } from "./database.js";
import { seedIdentity } from "../../src/identity-fixtures.js";
import { seedScheduler } from "../../src/scheduler-fixtures.js";
import { getPrincipal } from "../../src/identity.js";
import { MockScheduler } from "../../src/scheduler.js";
import { WorkflowService } from "../../src/workflow.js";
import { BookingExecutor } from "../../src/executor.js";

export async function workflowFixture(t: TestContext) {
  const database = await isolatedDatabase(t);
  const pool = database.open();
  await migrate(pool);
  await seedIdentity(pool);
  let clock = new Date("2030-01-07T12:00:00.000Z");
  await seedScheduler(pool, clock);
  const scheduler = new MockScheduler(pool, { now: () => clock });
  const service = new WorkflowService(pool, { scheduler, now: () => clock });
  const executor = new BookingExecutor(pool, { scheduler, now: () => clock });
  const patient = await getPrincipal(pool, "synthetic-patient-001");
  const staff = await getPrincipal(pool, "synthetic-staff-001");
  const representative = await getPrincipal(pool, "synthetic-representative-001");
  const slot = (await scheduler.getSlot("synthetic-slot-002"))!;
  const input = {
    patientId: "synthetic-patient-001",
    appointmentId: "synthetic-appointment-001",
    summary: "Reschedule the fictional appointment.",
    availability: {
      startsAt: slot.startsAt,
      endsAt: new Date(Date.parse(slot.endsAt) + 3_600_000).toISOString(),
      timeZone: "America/Halifax",
    },
    callbackWindow: {
      startsAt: new Date(clock.getTime() - 60_000).toISOString(),
      endsAt: new Date(clock.getTime() + 3_600_000).toISOString(),
      timeZone: "America/Halifax",
    },
  };
  return {
    database,
    pool,
    scheduler,
    service,
    executor,
    patient,
    staff,
    representative,
    input,
    now: () => clock,
    setNow(value: Date) {
      clock = value;
    },
    async proposed() {
      let task = await service.create(patient, input);
      task = await service.verify(patient, task.id, { expectedRevision: task.revision });
      task = await service.propose(staff, task.id, {
        expectedRevision: task.revision,
        slotId: slot.id,
        expiresAt: new Date(clock.getTime() + 7_200_000).toISOString(),
      });
      return task;
    },
  };
}
