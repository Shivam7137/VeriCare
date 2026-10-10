import { createPool } from "./db.js";
import { seed } from "./fixtures.js";

const pool = createPool();
try {
  await seed(pool);
  console.log("Synthetic T001 and its initial event are present; existing records were preserved.");
} finally {
  await pool.end();
}
