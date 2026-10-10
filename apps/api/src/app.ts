import Fastify from "fastify";
import { taskSchema } from "@prc/contracts";
import type { Pool } from "pg";

export function buildApp(pool: Pick<Pool, "query">, demoEnabled = false) {
  const app = Fastify({ logger: false });
  app.get("/health", async () => ({ status: "ok", service: "prc-api", stage: "foundation" }));
  app.get("/ready", async (_request, reply) => {
    try {
      await pool.query("SELECT 1 FROM tasks LIMIT 1");
      return { status: "ready" };
    } catch {
      return reply
        .code(503)
        .send({ status: "not_ready", reason: "database_or_schema_unavailable" });
    }
  });
  if (demoEnabled) {
    // Hard-coded synthetic fixture only; general patient lookup awaits the identity package.
    app.get("/demo/tasks/T001", async (_request, reply) => {
      try {
        const result = await pool.query("SELECT payload FROM tasks WHERE id = $1", ["T001"]);
        if (!result.rows[0]) return reply.code(404).send({ error: "Run npm run db:seed first." });
        return taskSchema.parse(result.rows[0].payload);
      } catch {
        return reply.code(503).send({ error: "Synthetic task storage is unavailable." });
      }
    });
  }
  return app;
}
