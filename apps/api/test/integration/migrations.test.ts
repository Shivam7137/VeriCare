import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { migrate } from "../../src/migrations.js";
import { seed } from "../../src/fixtures.js";
import { isolatedDatabase } from "./database.js";

test("migration upgrades a foundation database without changing saved tasks or events", async (t) => {
  const database = await isolatedDatabase(t);
  const pool = database.open();
  await pool.query(
    await readFile(new URL("../../migrations/001_foundation.sql", import.meta.url), "utf8"),
  );
  await pool.query("CREATE TABLE schema_migrations (name text PRIMARY KEY)");
  await pool.query("INSERT INTO schema_migrations VALUES ('001_foundation.sql')");
  await seed(pool);
  const tasks = (await pool.query("SELECT * FROM tasks")).rows;
  const events = (await pool.query("SELECT * FROM task_events")).rows;

  await migrate(pool);
  await migrate(pool);

  const applied = (await pool.query("SELECT name FROM schema_migrations ORDER BY name")).rows;
  assert.deepEqual(
    applied.map((row) => row.name),
    [
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
      "016_knowledge_base.sql",
    ],
  );
  assert.deepEqual((await pool.query("SELECT * FROM tasks")).rows, tasks);
  // Saved events keep every original value; migration 015 only adds an insertion order.
  const upgraded = (await pool.query("SELECT * FROM task_events")).rows;
  assert.deepEqual(
    upgraded.map(({ seq: _seq, ...row }) => row),
    events,
  );
  assert.equal(
    upgraded.every((row) => /^\d+$/.test(row.seq)),
    true,
  );
  assert.equal((await pool.query("SELECT * FROM proposal_drafts")).rowCount, 0);
  const directory = await pool.query("SELECT id,phone_number FROM care_team_directory");
  assert.equal(directory.rowCount, 4);
  assert.equal(
    directory.rows.every((row) => row.phone_number === null),
    true,
  );
  assert.equal((await pool.query("SELECT * FROM voice_transfers")).rowCount, 0);
  assert.equal((await pool.query("SELECT * FROM voice_sms_status_evidence")).rowCount, 0);
});

test("SMS evidence migration preserves calls and outbox records already saved through migration 009", async (t) => {
  const database = await isolatedDatabase(t);
  const pool = database.open();
  const migrations = new URL("../../migrations/", import.meta.url);
  await pool.query("CREATE TABLE schema_migrations (name text PRIMARY KEY)");
  for (const name of (await readdir(migrations))
    .filter((name) => name.endsWith(".sql") && name < "010_")
    .sort()) {
    await pool.query(await readFile(new URL(name, migrations), "utf8"));
    await pool.query("INSERT INTO schema_migrations VALUES ($1)", [name]);
  }
  await pool.query(
    "INSERT INTO voice_calls(id,mode,direction,status,created_at,updated_at) VALUES ('saved-call','simulated','inbound','in_progress',now(),now())",
  );
  await pool.query(`INSERT INTO voice_sms(id,call_id,tool_call_id,template,mode,body,content_fingerprint,status,expires_at,created_at,updated_at)
    VALUES ('saved-sms','saved-call','saved-tool','portal_link','simulated','Saved preview','saved-fingerprint','prepared',now()+interval '5 minutes',now(),now())`);
  const calls = (await pool.query("SELECT * FROM voice_calls")).rows;
  const messages = (await pool.query("SELECT * FROM voice_sms")).rows;
  await migrate(pool);
  await migrate(pool);
  assert.deepEqual((await pool.query("SELECT * FROM voice_calls")).rows, calls);
  assert.deepEqual((await pool.query("SELECT * FROM voice_sms")).rows, messages);
  assert.equal((await pool.query("SELECT * FROM voice_sms_status_evidence")).rowCount, 0);
});
