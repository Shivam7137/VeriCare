# Patient Request Coordination

[![CI](https://github.com/Shivam7137/patient-request-coordination/actions/workflows/ci.yml/badge.svg)](https://github.com/Shivam7137/patient-request-coordination/actions/workflows/ci.yml)

A development foundation for one department's appointment-rescheduling prototype. The intended workflow carries a request through verification, a specific proposal, staff approval, patient confirmation, and a recorded scheduling outcome.

**Current status: repository foundation.** The starter runs a Next.js development page and a persistent Node.js API, seeds fictional task T001 into PostgreSQL, and reads that saved task. It does not yet reschedule appointments, verify users, send reminders, or place calls. The [backlog](docs/backlog.md) defines the remaining work.

Only synthetic records and test integrations belong here. The API and web commands bind to loopback. The synthetic task endpoint requires an explicit development setting. Do not expose this starter publicly or load real patient data before identity and deployment controls are implemented.

## Quick start

Install Node.js 24 and Docker Desktop with its Linux engine running. From the repository root:

```sh
npm ci
npm run setup
npm run db:up
npm run db:migrate
npm run db:seed
npm run dev
```

Open [the development page](http://127.0.0.1:3100). The API runs on port 4100 and this project's database on port 55439. Stop the app with Ctrl+C. `npm run db:stop` stops only this project's database and preserves its volume.

```sh
npm run check
npm run test:integration
```

The integration command requires `DATABASE_URL` in the process environment; see [setup](docs/setup.md) for PowerShell and POSIX examples. CI creates an isolated PostgreSQL service, runs the quality checks, and checks persistence across a fresh application connection pool.

## Workspace

| Path                   | Purpose                                                |
| ---------------------- | ------------------------------------------------------ |
| `apps/web`             | Next.js App Router development page                    |
| `apps/api`             | Fastify API, SQL migration, idempotent fixture seed    |
| `packages/contracts`   | Shared task/event schemas and synthetic fixture        |
| `docs/contracts.md`    | Implemented endpoints and proposed interface inventory |
| `docs/architecture.md` | Component boundaries and workflow invariants           |
| `docs/backlog.md`      | Packages A–H, dependencies and completion evidence     |
| `docs/acceptance.md`   | Full demonstration scenarios and implementation status |
| `docs/decisions.md`    | Starter choices and decisions the team still owns      |

Start with [the source brief](docs/team-guide.md) and [contributing](CONTRIBUTING.md). Before coding, read [AGENTS.md](AGENTS.md). Contract changes need review. Assign named owners and reviewers when teammates are confirmed; suggested roles are not access grants.

The [eight GitHub issues](https://github.com/Shivam7137/patient-request-coordination/issues) are grouped under the [first demonstration milestone](https://github.com/Shivam7137/patient-request-coordination/milestone/1). See [setup verification](docs/setup-verification.md) for evidence and [GitHub settings](docs/github-settings.md) for the private-plan branch-protection limitation.

This private repository has no open-source license grant. Hosting, paid services, live voice, hospital connectors, and collaborator invitations are outside this setup.
