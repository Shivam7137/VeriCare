import { createPool } from "./db.js";
import { migrate } from "./migrations.js";

const pool = createPool();
try {
  await migrate(pool);
  console.log("Database migrations applied.");
} finally {
  await pool.end();
}
