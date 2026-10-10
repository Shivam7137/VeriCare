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
npm run dev
```

`setup` creates .env only if missing. Ordered migrations are tracked in schema_migrations and applied within a transaction under a PostgreSQL advisory lock. Migration 002 adds proposal drafts without changing existing task/event records. Seeding adds T001 and E001 transactionally and preserves existing rows on repeated runs.

The app is at http://127.0.0.1:3100. The API is at http://127.0.0.1:4100; GET /health checks the process, GET /ready checks access to all three application tables, and GET /demo/tasks/T001 retrieves the fixture when explicitly enabled. GET /demo/tasks/T001/proposals and GET /demo/tasks/T001/events expose its stored draft versions and event history under the same demo setting. An unavailable database yields a setup message in the web page, not a fabricated successful task.

## Optional local checks

```sh
npm run check
```

Run integration tests against a local or dedicated test database with permission to create schemas. Each test creates a uniquely named schema, applies migrations and synthetic fixtures there, and drops only that schema on completion. Tests do not modify the normal development schema or its T001. Set DATABASE_URL in your shell; the example local database works even after development records change. An interrupted test process can leave a test schema behind; do not delete unrelated schemas during cleanup.

PowerShell:

```powershell
$env:DATABASE_URL = 'postgresql://prc:prc_local_only@127.0.0.1:55439/prc'
npm run test:integration
```

POSIX:

```sh
DATABASE_URL=postgresql://prc:prc_local_only@127.0.0.1:55439/prc npm run test:integration
```

No CI runs in this disposable workspace. Integration tests cover upgrades, proposal versions, revision conflicts, concurrent saves, transaction rollback, demo reads, and persistence across recreated connection pools. They do not yet prove server crash recovery, worker replay, callback survival, or scheduler reconciliation.

## Stop and recovery

Ctrl+C stops the development processes. `npm run db:stop` stops this project's database while preserving its named volume. Start it again with `npm run db:up`. Do not run `docker compose down -v` as routine troubleshooting.

If port 55439 is occupied, choose a free loopback port in compose.yaml and update DATABASE_URL in .env. If Docker is stopped, start it yourself before db:up. If another PostgreSQL installation is preferred, provide a dedicated database through DATABASE_URL and skip db:up.

Root .env is loaded by API development/start and database scripts, and by the web development/start scripts. Builds need no database or provider credentials. npm run build validates the API with TypeScript and creates the Next.js production build; the API start command runs TypeScript through tsx and expects development dependencies to be installed. A production packaging strategy is still a team decision.
