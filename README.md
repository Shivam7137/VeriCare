# Patient Request Coordination

A disposable, private workspace for experimenting with one department's appointment-rescheduling prototype. Push directly to main or use a branch and pull request when helpful. There is no CI, required review, branch protection, CODEOWNERS, or automated dependency-update workflow.

**Current status: repository foundation and initial backend persistence.** The starter runs a Next.js development page and a persistent Node.js API, seeds fictional task T001 into PostgreSQL, and reads that saved task and its history. An internal service saves versioned proposal drafts with revision checks and atomic audit events. It does not yet reschedule appointments, verify users, send reminders, or place calls. The [backlog](docs/backlog.md) defines the remaining work.

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

Optional local checks:

```sh
npm run check
npm run test:integration
```

The integration command requires `DATABASE_URL` in the process environment; see [setup](docs/setup.md) for PowerShell and POSIX examples. These commands are available locally and do not gate anyone's work.

## Workspace

| Path                   | Purpose                                                     |
| ---------------------- | ----------------------------------------------------------- |
| `apps/web`             | Next.js App Router development page                         |
| `apps/api`             | Fastify API, migrations, proposal persistence, fixture seed |
| `packages/contracts`   | Shared task/event/proposal schemas and synthetic fixture    |
| `docs/contracts.md`    | Implemented endpoints and proposed interface inventory      |
| `docs/architecture.md` | Component boundaries and workflow invariants                |
| `docs/backlog.md`      | Packages A–H, dependencies and completion evidence          |
| `docs/acceptance.md`   | Full demonstration scenarios and implementation status      |
| `docs/decisions.md`    | Starter choices and decisions the team still owns           |

Start with [the source brief](docs/team-guide.md) and [contributing](CONTRIBUTING.md). Before coding, read [AGENTS.md](AGENTS.md). Let others know when shared contracts change. The backlog and suggested roles are coordination aids; an owner or reviewer assignment is not required to start.

The [eight GitHub issues](https://github.com/Shivam7137/patient-request-coordination/issues) and [demonstration milestone](https://github.com/Shivam7137/patient-request-coordination/milestone/1) are optional planning aids. See [setup verification](docs/setup-verification.md) for historical checks and [GitHub settings](docs/github-settings.md) for the current lightweight configuration.

This private repository has no open-source license grant. Hosting, paid services, live voice, hospital connectors, and collaborator invitations are outside this setup.
