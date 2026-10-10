import type { Pool } from "pg";
import { seededTask } from "@prc/contracts";

export async function seed(pool: Pool) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO tasks (id, payload) VALUES ($1, $2) ON CONFLICT DO NOTHING", [
      seededTask.id,
      seededTask,
    ]);
    await client.query(
      `INSERT INTO task_events (id, task_id, actor_id, action, occurred_at, evidence_ref)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
      [
        "E001",
        "T001",
        "fixture-seeder",
        "synthetic_task_seeded",
        seededTask.createdAt,
        "fixture:T001",
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
