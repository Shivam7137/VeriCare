import { createPool } from "./db.js";
import { migrate } from "./migrations.js";
import { populateDemo } from "./demo-population.js";

const args = process.argv.slice(2);
if (args.length && !(args.length === 2 && args[0] === "--batch"))
  throw new Error("Usage: npm run demo:populate [-- --batch NAME]");
const pool = createPool();
try {
  await migrate(pool);
  const result = await populateDemo(pool, { batch: args[1] });
  console.log(
    `Fictional clinic batch ${result.batch}: ${result.created} requests added; ${result.preserved} existing scenarios preserved.`,
  );
  console.log(
    "Includes 10 named patients, 4 care-team members, 26 appointments, 90 slots and 32 simulated calls per new batch. No provider APIs are used.",
  );
} finally {
  await pool.end();
}
