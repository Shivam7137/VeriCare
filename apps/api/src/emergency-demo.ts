import type { Pool } from "pg";
import { demoPatients } from "./demo-catalog.js";
import { transaction } from "./domain.js";

const birthdays = [
  "1990-04-12",
  "1985-09-23",
  "1994-02-17",
  "1978-11-06",
  "1988-07-21",
  "1992-03-09",
  "1965-06-14",
  "1982-12-03",
  "1997-08-25",
  "1973-01-30",
];
const facilities = [
  "Halifax Infirmary",
  "Dartmouth General Hospital",
  "Cobequid Community Health Centre",
];

/** Contact details come only from private configuration; all patient records are fictional. */
export async function seedEmergencyDemo(pool: Pool, env: NodeJS.ProcessEnv = process.env) {
  const name = env.DEMO_EMERGENCY_CONTACT_NAME?.trim();
  const relationship = env.DEMO_EMERGENCY_CONTACT_RELATIONSHIP?.trim();
  const phone = env.DEMO_EMERGENCY_CONTACT_PHONE?.trim();
  if (
    !name ||
    name.length > 150 ||
    !relationship ||
    relationship.length > 80 ||
    !phone ||
    !/^\+[1-9]\d{7,14}$/.test(phone)
  )
    throw new Error(
      "Set DEMO_EMERGENCY_CONTACT_NAME, DEMO_EMERGENCY_CONTACT_RELATIONSHIP and DEMO_EMERGENCY_CONTACT_PHONE in the private .env file.",
    );
  return transaction(pool, async (db) => {
    let populated = 0;
    for (const [index, patient] of demoPatients.entries()) {
      // Do not create, rename or reassign existing patient identities here.
      const inserted = await db.query(
        `INSERT INTO emergency_patient_records
        (patient_id,date_of_birth,contact_name,contact_relationship,contact_number,facility,department,area,visitor_instructions)
        SELECT id,$2::date,$3,$4,$5,$6,'Emergency Department',$7,'Check in at the emergency reception desk.'
        FROM patients WHERE id=$1 AND department_id='demo-department'
        ON CONFLICT(patient_id) DO UPDATE SET contact_name=EXCLUDED.contact_name,
        contact_relationship=EXCLUDED.contact_relationship,contact_number=EXCLUDED.contact_number`,
        [
          patient.id,
          birthdays[index],
          name,
          relationship,
          phone,
          facilities[index % facilities.length],
          `Assessment area ${String.fromCharCode(66 + (index % 3))}`,
        ],
      );
      populated += inserted.rowCount ?? 0;
    }
    return { populated };
  });
}
