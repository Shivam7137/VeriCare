import pg from "pg";

export function createPool() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required. Run npm run setup.");
  return new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 10000,
  });
}
