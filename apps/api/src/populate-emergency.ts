import { createPool } from "./db.js";
import { migrate } from "./migrations.js";
import { seedEmergencyDemo } from "./emergency-demo.js";

const pool = createPool();
try {
  await migrate(pool);
  const result = await seedEmergencyDemo(pool);
  console.log(
    `Configured ${result.populated} fictional patient-location records with the private emergency contact. No SMS was sent.`,
  );
} finally {
  await pool.end();
}
