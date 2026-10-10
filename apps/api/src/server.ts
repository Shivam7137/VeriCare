import { buildApp } from "./app.js";
import { createPool } from "./db.js";

const pool = createPool();
const host = process.env.API_HOST ?? "127.0.0.1";
const demoEnabled = process.env.ENABLE_SYNTHETIC_DEMO === "true";
if (demoEnabled && !["127.0.0.1", "localhost", "::1"].includes(host)) {
  throw new Error("Synthetic demo endpoints must bind to loopback until identity is implemented.");
}
const app = buildApp(pool, demoEnabled);
await app.listen({ host, port: Number(process.env.API_PORT ?? 4100) });
console.log(`Foundation API listening on ${host}:${process.env.API_PORT ?? 4100}`);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await app.close();
    await pool.end();
  });
}
