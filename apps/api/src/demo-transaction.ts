import type { Pool, PoolClient } from "pg";

// Fixture-only adapter: sequential domain commands retain their transaction boundaries
// as savepoints inside one atomic population. Workers cannot see half-built scenarios.
// Do not use this for concurrent work, external providers, or ordinary API requests.
export async function demoTransaction<T>(pool: Pool, work: (scoped: Pool) => Promise<T>) {
  const client = await pool.connect();
  let depth = 0;
  const query = async (sql: string, values?: unknown[]) => {
    if (sql === "BEGIN") return client.query(`SAVEPOINT demo_command_${++depth}`);
    if (sql === "COMMIT") return client.query(`RELEASE SAVEPOINT demo_command_${depth--}`);
    if (sql === "ROLLBACK") {
      const savepoint = `demo_command_${depth--}`;
      await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      return client.query(`RELEASE SAVEPOINT ${savepoint}`);
    }
    return client.query(sql, values);
  };
  const scopedClient = { query, release() {} } as unknown as PoolClient;
  const scoped = { query, connect: async () => scopedClient } as unknown as Pool;
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('rich-demo:' || current_schema(), 0))",
    );
    const result = await work(scoped);
    if (depth !== 0) throw new Error("Unbalanced demo transaction");
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
