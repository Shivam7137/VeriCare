import type { Pool } from "pg";
import { transaction } from "./domain.js";

// Existing fixture rows are intentionally preserved, including bookings moved by a demo.
export async function seedScheduler(pool: Pool, now = new Date()) {
  const firstSlot = new Date(now);
  const daysUntilThursday = (4 - firstSlot.getUTCDay() + 7) % 7 || 7;
  firstSlot.setUTCDate(firstSlot.getUTCDate() + daysUntilThursday);
  firstSlot.setUTCHours(13, 30, 0, 0);
  const slotIds = [
    "synthetic-slot-original",
    "synthetic-slot-002",
    "synthetic-slot-003",
    "synthetic-slot-original-002",
  ];
  await transaction(pool, async (client) => {
    for (const patientId of ["synthetic-patient-001", "synthetic-patient-002"]) {
      await client.query(
        "INSERT INTO patients (id, department_id) VALUES ($1, 'demo-department') ON CONFLICT DO NOTHING",
        [patientId],
      );
    }
    for (const [index, slotId] of slotIds.entries()) {
      const startsAt = new Date(firstSlot.getTime() + index * 60 * 60 * 1000);
      const endsAt = new Date(startsAt.getTime() + 30 * 60 * 1000);
      await client.query(
        `INSERT INTO scheduler_slots (id, department_id, starts_at, ends_at)
         VALUES ($1, 'demo-department', $2, $3) ON CONFLICT DO NOTHING`,
        [slotId, startsAt, endsAt],
      );
    }
    for (const [appointmentId, patientId, slotId] of [
      ["synthetic-appointment-001", "synthetic-patient-001", "synthetic-slot-original"],
      ["synthetic-appointment-002", "synthetic-patient-002", "synthetic-slot-original-002"],
    ]) {
      await client.query(
        `INSERT INTO scheduler_bookings (id, patient_id, department_id, slot_id)
         VALUES ($1, $2, 'demo-department', $3) ON CONFLICT DO NOTHING`,
        [appointmentId, patientId, slotId],
      );
    }
  });
}
