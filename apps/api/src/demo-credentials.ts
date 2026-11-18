import { access, writeFile } from "node:fs/promises";
import { createPool } from "./db.js";
import { createSession } from "./identity.js";
import { migrate } from "./migrations.js";
import { seedBackend } from "./backend-fixtures.js";

const file = new URL("../../../.env.sessions.json", import.meta.url);
// A hosted demo restarts rarely, so it may ask for longer sessions (1 to 1000 hours).
const requestedHours = Number(process.env.DEMO_SESSION_HOURS);
const hours =
  Number.isInteger(requestedHours) && requestedHours >= 1 && requestedHours <= 1000
    ? requestedHours
    : 24;
let exists = false;
try {
  await access(file);
  exists = true;
} catch {}
if (exists) {
  console.log(
    "Kept existing .env.sessions.json. Sessions expire after 24 hours; move that local file aside before provisioning fresh sessions.",
  );
} else {
  const pool = createPool();
  try {
    await migrate(pool);
    await seedBackend(pool);
    const sessions: Record<string, { token: string; sessionId: string; expiresAt: string }> = {};
    for (const actorId of [
      "synthetic-patient-001",
      "synthetic-representative-001",
      "synthetic-staff-001",
      "synthetic-operator-001",
    ]) {
      sessions[actorId] = await createSession(
        pool,
        actorId,
        new Date(Date.now() + hours * 3_600_000),
      );
    }
    await writeFile(file, JSON.stringify(sessions, null, 2) + "\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    console.log(
      "Created ignored .env.sessions.json with local synthetic sessions (mode 0600). Token values are not logged.",
    );
  } finally {
    await pool.end();
  }
}
