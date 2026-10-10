import { createPool } from "./db.js";
import { seedBackend } from "./backend-fixtures.js";

const pool = createPool();
try {
  await seedBackend(pool);
  console.log(
    "Synthetic identity, scheduler and T001 fixtures are present; existing records were preserved.",
  );
} finally {
  await pool.end();
}
