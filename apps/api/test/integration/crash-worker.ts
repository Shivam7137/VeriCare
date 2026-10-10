import { createPool } from "../../src/db.js";
import { MockScheduler } from "../../src/scheduler.js";
import { BookingExecutor } from "../../src/executor.js";

const pool = createPool();
const now = () => new Date(process.env.TEST_NOW!);
const scheduler = new MockScheduler(pool, {
  now,
  afterCommit: async () => {
    process.exit(73);
  },
});
await new BookingExecutor(pool, { scheduler, now }).execute(process.env.TEST_TASK_ID!);
await pool.end();
throw new Error("Crash hook was not reached");
