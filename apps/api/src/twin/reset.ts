import { createPool } from "../db.js";

// Clears the fictional emergency visits so the demo scenario can be played again.
// TRUNCATE is deliberate: the event log and ledger refuse row-level deletes.
const pool = createPool();
await pool.query(
  `TRUNCATE ed_audit, ed_staff_tasks, ed_messages, ed_estimates, ed_stage_estimates, ed_contacts,
   ed_events, ed_agent_wakes, ed_agent_runs, ed_sms, ed_sms_inbound, opor_messages, opor_feed,
   ed_encounters RESTART IDENTITY CASCADE`,
);
await pool.end();
console.log("Emergency visit demo data cleared.");
