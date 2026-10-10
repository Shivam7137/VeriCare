# Patient Request Coordination

A disposable, private workspace for experimenting with one department's appointment-rescheduling prototype. Push directly to main or use a branch and pull request when helpful. There is no CI, required review, branch protection, CODEOWNERS, or automated dependency-update workflow.

**Current status: the synthetic backend is implemented.** Authenticated patient, representative, staff and operator APIs share a durable rescheduling workflow: versioned proposals, exact-version decisions, agreed callbacks, fake reminders, repeat-safe booking changes and restart recovery. The scheduler and delivery transport use local fictional records. A basic Next.js frontend now supports patient requests, staff proposals/approvals, patient confirmation and operator monitoring. Live identity, hospital and voice integrations remain separate work.

Only synthetic records and test integrations belong here. Development commands bind to loopback. The optional unauthenticated fixture endpoints are for the local development page. Local session provisioning is a test identity mechanism, not real patient verification.

## Quick start

Install Node.js 24 and Docker Desktop with its Linux engine running. From the repository root:

```sh
npm ci
npm run setup
npm run db:up
npm run db:migrate
npm run db:seed
npm run demo:populate
npm run demo:credentials
npm run dev
```

Open the local web app on port 3100. The homepage links to separate **Patient** (`/patient`) and **Healthcare professional** (`/professional`) portals. Create and verify a patient request; use the professional staff account to propose and approve a time; then confirm in the patient portal after the simulated callback. Both portals can stay signed in independently. The worker saves the booking result automatically. **Operator** provides a read-only overview. All displayed and entered times are UTC. The API runs on port 4100 and this project's database on port 55439. `dev` starts the API, web page and durable worker. Local bearer sessions are saved in ignored `.env.sessions.json` with restricted file permissions; token values are never logged. Stop the app with Ctrl+C. `npm run db:stop` stops only this project's database and preserves its volume.

The patient portal also supports simulated incoming calls, scheduled callbacks and explicit approval of AI-prepared actions. The professional portal shows calls and handovers. No provider keys are needed for simulation. See [phone and AI setup](docs/phone-setup.md) for Twilio/OpenAI configuration, agent behavior and the later live-call check. `npm run voice:check` checks configuration without placing calls.

Choose **Desktop overview** on the homepage, or open `/desktop`, to see department requests, booking evidence, history, appointments, calls, handovers and AI readiness together. **Open desktop demo** signs in with the read-only operator account; an existing professional session is reused. Search, status filters and request links help navigate the records. The view refreshes every five seconds, and it keeps the last successful snapshot with a warning if refresh fails. Patient sign-in remains separate.

[View the desktop screenshot](docs/screenshots/desktop-overview.png).

`npm run demo:populate` adds a rich fictional clinic dataset: 10 named patients, 4 care-team members, 26 requests and appointments, 90 time slots, and 32 simulated calls. Maya Chen is the existing patient demo account, with eight new requests at different stages. Each completed request has real mock-scheduler evidence; revised proposals, rejected offers, withdrawals, human handovers and a failed callback delivery make the queues useful to explore. See [demo data](docs/demo-data.md) for the scenario guide and repeat-safe refresh commands.

Optional local checks:

```sh
npm run check
npm run test:backend
```

The backend integration command loads `.env` and creates isolated test schemas; see [setup](docs/setup.md). These commands are available locally and do not gate anyone's work.

## Workspace

| Path                   | Purpose                                                     |
| ---------------------- | ----------------------------------------------------------- |
| `apps/web`             | Next.js patient, staff and operator demo                    |
| `apps/api`             | Authenticated Fastify API, workflow, worker, mock scheduler |
| `packages/contracts`   | Shared task/event/proposal schemas and synthetic fixture    |
| `docs/contracts.md`    | Implemented API, authority and agent tool contracts         |
| `docs/architecture.md` | Component boundaries and workflow invariants                |
| `docs/backlog.md`      | Packages A–H, dependencies and completion evidence          |
| `docs/acceptance.md`   | Backend acceptance scenarios and executable evidence        |
| `docs/decisions.md`    | Starter choices and decisions the team still owns           |

Start with [the source brief](docs/team-guide.md) and [contributing](CONTRIBUTING.md). Before coding, read [AGENTS.md](AGENTS.md). Let others know when shared contracts change. The backlog and suggested roles are coordination aids; an owner or reviewer assignment is not required to start.

The [eight GitHub issues](https://github.com/Shivam7137/patient-request-coordination/issues) and [demonstration milestone](https://github.com/Shivam7137/patient-request-coordination/milestone/1) are optional planning aids. See [setup verification](docs/setup-verification.md) for historical checks and [GitHub settings](docs/github-settings.md) for the current lightweight configuration.

This private repository has no open-source license grant. Hosting, paid provider activation, live-call validation, hospital connectors, and collaborator invitations are outside this local setup.
