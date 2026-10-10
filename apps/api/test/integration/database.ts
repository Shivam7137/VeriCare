import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import pg from "pg";
import { createPool } from "../../src/db.js";

// Each test owns a fresh schema, never the developer's task records.
export async function isolatedDatabase(t: TestContext) {
  const admin = createPool();
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  const pools = new Set<pg.Pool>();
  t.after(async () => {
    try {
      await Promise.all([...pools].map((pool) => pool.end()));
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await admin.end();
    }
  });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  // pg gives URL parameters precedence over Pool options. Override search_path
  // in the URL itself, retaining other startup settings such as timeouts.
  const connection = new URL(process.env.DATABASE_URL!);
  const existingOptions = connection.searchParams.get("options") ?? "";
  connection.searchParams.set("options", `${existingOptions} -c search_path=${schema}`.trim());
  return {
    open() {
      const pool = new pg.Pool({
        connectionString: connection.toString(),
        max: 5,
        connectionTimeoutMillis: 3000,
      });
      pools.add(pool);
      return pool;
    },
    async close(pool: pg.Pool) {
      await pool.end();
      pools.delete(pool);
    },
  };
}
