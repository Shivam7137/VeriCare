import type { Pool } from "pg";
import { transaction } from "./domain.js";

// Fictional identities only. Re-running this must not re-enable identities or replace consent.
export async function seedIdentity(pool: Pool): Promise<void> {
  await transaction(pool, async (db) => {
    await db.query(`INSERT INTO patients (id, department_id) VALUES
      ('synthetic-patient-001', 'demo-department'),
      ('synthetic-patient-002', 'demo-department'),
      ('synthetic-patient-other', 'other-department')
      ON CONFLICT (id) DO NOTHING`);
    await db.query(`INSERT INTO principals (id, role, patient_id, department_id, verified) VALUES
      ('synthetic-patient-001', 'patient', 'synthetic-patient-001', NULL, true),
      ('synthetic-representative-001', 'patient', 'synthetic-patient-002', NULL, true),
      ('synthetic-patient-other', 'patient', 'synthetic-patient-other', NULL, true),
      ('synthetic-staff-001', 'staff', NULL, 'demo-department', true),
      ('synthetic-staff-other', 'staff', NULL, 'other-department', true),
      ('synthetic-operator-001', 'operator', NULL, 'demo-department', true)
      ON CONFLICT (id) DO NOTHING`);
  });
}
