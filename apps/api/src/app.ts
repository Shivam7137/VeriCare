import Fastify from "fastify";
import { proposalDraftSchema, taskEventSchema, taskSchema } from "@prc/contracts";
import type { Pool } from "pg";
import { registerVoiceRoutes } from "./voice-routes.js";
import { registerBackendRoutes } from "./backend-routes.js";

export function buildApp(pool: Pool, demoEnabled = false) {
  const app = Fastify({ logger: false });
  app.get("/health", async () => ({
    status: "ok",
    service: "prc-api",
    stage: "synthetic_backend",
  }));
  app.get("/ready", async (_request, reply) => {
    try {
      await pool.query(`SELECT
        (SELECT 1 FROM tasks LIMIT 1),
        (SELECT 1 FROM task_events LIMIT 1),
        (SELECT 1 FROM proposal_drafts LIMIT 1),
        (SELECT 1 FROM patients LIMIT 1),
        (SELECT 1 FROM principals LIMIT 1),
        (SELECT 1 FROM sessions LIMIT 1),
        (SELECT 1 FROM authority_grants LIMIT 1),
        (SELECT 1 FROM authority_requests LIMIT 1),
        (SELECT 1 FROM scheduler_slots LIMIT 1),
        (SELECT 1 FROM scheduler_bookings LIMIT 1),
        (SELECT 1 FROM scheduler_receipts LIMIT 1),
        (SELECT 1 FROM workflow_tasks LIMIT 1),
        (SELECT 1 FROM action_requests LIMIT 1),
        (SELECT 1 FROM booking_operations LIMIT 1),
        (SELECT 1 FROM communication_jobs LIMIT 1),
        (SELECT 1 FROM mock_deliveries LIMIT 1),
        (SELECT 1 FROM voice_calls LIMIT 1),
        (SELECT 1 FROM voice_access_codes LIMIT 1),
        (SELECT 1 FROM voice_events LIMIT 1),
        (SELECT 1 FROM voice_tool_results LIMIT 1)`);
      return { status: "ready" };
    } catch {
      return reply
        .code(503)
        .send({ status: "not_ready", reason: "database_or_schema_unavailable" });
    }
  });
  if (demoEnabled) {
    // Hard-coded, read-only fixture for the loopback development page.
    app.get("/demo/tasks/T001", async (_request, reply) => {
      try {
        const result = await pool.query("SELECT payload FROM tasks WHERE id = $1", ["T001"]);
        if (!result.rows[0]) return reply.code(404).send({ error: "Run npm run db:seed first." });
        return taskSchema.parse(result.rows[0].payload);
      } catch {
        return reply.code(503).send({ error: "Synthetic task storage is unavailable." });
      }
    });
    app.get("/demo/tasks/T001/proposals", async (_request, reply) => {
      try {
        const result = await pool.query(
          `SELECT p.payload FROM tasks t
           LEFT JOIN proposal_drafts p ON p.task_id = t.id
           WHERE t.id = $1 ORDER BY p.version`,
          ["T001"],
        );
        if (!result.rows[0]) return reply.code(404).send({ error: "Run npm run db:seed first." });
        return {
          taskId: "T001",
          proposals: result.rows
            .filter((row) => row.payload !== null)
            .map((row) => proposalDraftSchema.parse(row.payload)),
        };
      } catch {
        return reply.code(503).send({ error: "Synthetic task storage is unavailable." });
      }
    });
    app.get("/demo/tasks/T001/events", async (_request, reply) => {
      try {
        const result = await pool.query(
          `SELECT e.id, t.id AS "taskId", e.actor_id AS "actorId", e.action,
                  e.occurred_at AS "occurredAt", e.evidence_ref AS "evidenceRef"
           FROM tasks t LEFT JOIN task_events e ON e.task_id = t.id
           WHERE t.id = $1 ORDER BY e.occurred_at, e.id`,
          ["T001"],
        );
        if (!result.rows[0]) return reply.code(404).send({ error: "Run npm run db:seed first." });
        return {
          taskId: "T001",
          events: result.rows
            .filter((row) => row.id !== null)
            .map((row) =>
              taskEventSchema.parse({ ...row, occurredAt: row.occurredAt.toISOString() }),
            ),
        };
      } catch {
        return reply.code(503).send({ error: "Synthetic task storage is unavailable." });
      }
    });
  }
  registerBackendRoutes(app, pool);
  registerVoiceRoutes(app, pool);
  return app;
}
