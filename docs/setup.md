# Local development

Use Node.js 24, npm and Docker Desktop with the Linux engine running. The repository uses npm workspaces and a committed lockfile. No OpenAI, Twilio or hospital credentials are needed.

```sh
git clone https://github.com/Shivam7137/patient-request-coordination.git
cd patient-request-coordination
npm ci
npm run setup
npm run db:up
npm run db:migrate
npm run db:seed
npm run demo:populate
npm run demo:credentials
npm run dev
```

`setup` creates `.env` only if missing. Ordered migrations are tracked in `schema_migrations` and applied transactionally under an advisory lock. Migration 002 adds immutable proposal drafts; migration 003 adds identity, consent, scheduler, decisions, operations and communication storage; migration 004 adds voice storage; migration 005 adds optional fictional profile names. Seeds preserve existing rows, moved bookings and task history. `demo:populate` adds the [rich clinic dataset](demo-data.md) with future dates. Rerunning the same daily batch preserves existing scenarios; use `-- --batch NAME` for another fresh batch without clearing saved records. The smaller `db:seed` fixture remains available for a minimal setup.

`demo:credentials` provisions 24-hour sessions for `synthetic-patient-001`, `synthetic-representative-001`, `synthetic-staff-001` and `synthetic-operator-001`. Tokens go to ignored `.env.sessions.json` with mode 0600; only their hashes are stored in PostgreSQL. The script preserves an existing file. To renew expired credentials, move that local file to a secure ignored location, rerun the command, and delete the old local copy when no longer needed. No token, role selection or login endpoint is exposed over HTTP.

The app is at http://127.0.0.1:3100; the API is at http://127.0.0.1:4100. `dev` starts API, web and worker. `GET /health` checks the process and `GET /ready` checks every application table. Optional `/demo/tasks/T001`, `/demo/tasks/T001/proposals` and `/demo/tasks/T001/events` are read-only fixture routes controlled by `ENABLE_SYNTHETIC_DEMO`; they require a loopback API bind. An unavailable database produces a truthful unavailable web state.

All general backend routes require `Authorization: Bearer <local-session-token>`. See [contracts](contracts.md) for the complete journey and payloads. Do not paste tokens into source, logs or chat. This read-only smoke request loads its token from disk without printing it:

```sh
node --input-type=module <<'JS'
import { readFile } from 'node:fs/promises';
const sessions = JSON.parse(await readFile('.env.sessions.json', 'utf8'));
const response = await fetch('http://127.0.0.1:4100/me', {
  headers: { authorization: `Bearer ${sessions['synthetic-patient-001'].token}` },
});
if (!response.ok) throw new Error(`Unexpected status ${response.status}`);
console.log(await response.json());
JS
```

Run the worker separately with `npm run worker`, or one recovery pass with `npm run worker:once`. `WORKER_INTERVAL_MS` defaults to 1000 and accepts 100–60000. The worker delivers due fake jobs, expires pending windows, executes ready tasks and reconciles unfinished operations. No external messages or calls are sent. `/operator/queue` reports scoped pending work and failed/uncertain outcomes. More than one worker can safely run against the same database.

## Basic frontend walkthrough

With `npm run dev` running, use the local web app on port 3100:

1. Choose **Patient**, select **New request**, choose an available appointment, and enter a callback window. All inputs and displayed times are UTC. For an immediate demo, keep the callback window open now.
2. Create the request, then select **Verify my request**.
3. Switch to **Staff**, choose the matching proposal time, select **Propose appointment**, then **Approve proposal**.
4. Switch back to **Patient**. The page polls for the worker's simulated callback; once delivered, select **Confirm appointment**.
5. Wait for **Appointment changed** and the scheduler confirmation reference. Reloading preserves the result. **Operator** shows the shared queue and overdue/failed/reconciling counts.

The frontend also supports callback-window updates, rejected proposals, withdrawal, staff takeover, and activity history. It does not create real calls. Demo sign-in requires `ENABLE_SYNTHETIC_DEMO=true` and a loopback host on port 3100; it selects one of the existing local patient/staff/operator sessions rather than minting credentials. The session is an HttpOnly, SameSite=Strict cookie scoped to `/api`; it is not returned in JSON or stored in browser JavaScript/localStorage. Mutation routes require a matching Origin header. Signing out clears the browser cookie. This demo account switcher is not a production login system.

## Optional local checks

```sh
npm run check
npm run test:backend
```

Run integration tests against a local or dedicated test database with permission to create schemas. Each test creates a uniquely named schema, applies migrations and synthetic fixtures there, and drops only that schema on completion. Tests do not modify the normal development schema or its T001. `test:backend` loads the root `.env`; alternatively set DATABASE_URL in your shell for `test:integration`; the example local database works even after development records change. An interrupted test process can leave a test schema behind; do not delete unrelated schemas during cleanup.

PowerShell:

```powershell
$env:DATABASE_URL = 'postgresql://prc:prc_local_only@127.0.0.1:55439/prc'
npm run test:integration
```

POSIX:

```sh
DATABASE_URL=postgresql://prc:prc_local_only@127.0.0.1:55439/prc npm run test:integration
```

No CI runs in this disposable workspace. Unit tests validate inputs and the text/tool boundary. PostgreSQL integration tests cover authentication, consent, complete workflow, callback deadlines, duplicate/concurrent execution, delivery cancellation/retry, unavailable slots, lost responses and a real process exit after scheduler commit. Tests isolate their data even when connection options are supplied. [Acceptance](acceptance.md) maps scenarios to evidence.

## Stop and recovery

Ctrl+C stops the development processes. `npm run db:stop` stops this project's database while preserving its named volume. Start it again with `npm run db:up`. Do not run `docker compose down -v` as routine troubleshooting.

If port 55439 is occupied, choose a free loopback port in compose.yaml and update DATABASE_URL in .env. If Docker is stopped, start it yourself before db:up. If another PostgreSQL installation is preferred, provide a dedicated database through DATABASE_URL and skip db:up.

Root .env is loaded by API development/start and database, credential and worker scripts, and by the web development/start scripts. Builds need no database or provider credentials. npm run build validates the API with TypeScript and creates the Next.js production build; the API start command runs TypeScript through tsx and expects development dependencies to be installed. A production packaging strategy is still a team decision.
