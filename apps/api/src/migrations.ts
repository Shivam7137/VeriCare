import { readFile } from "node:fs/promises";
import type { Pool } from "pg";

export async function migrate(pool: Pool) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(731701)");
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY)");
    for (const name of [
      "001_foundation.sql",
      "002_proposal_drafts.sql",
      "003_backend.sql",
      "004_voice.sql",
      "005_demo_profiles.sql",
      "006_voice_forwarding.sql",
      "007_voice_monitor.sql",
      "008_voice_sms.sql",
      "009_voice_guest.sql",
      "010_voice_sms_status_evidence.sql",
      "011_emergency_contact.sql",
      "012_ed_journey.sql",
      "013_stage_estimates.sql",
      "014_visit_agent.sql",
      "015_task_event_order.sql",
    ]) {
      const existing = await client.query("SELECT name FROM schema_migrations WHERE name = $1", [
        name,
      ]);
      if (existing.rowCount === 0) {
        const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
