# careBridge

A disposable, private workspace for experimenting with one department's appointment-rescheduling prototype. Push directly to main or use a branch and pull request when helpful. There is no CI, required review, branch protection, CODEOWNERS, or automated dependency-update workflow.

**Current status: the synthetic backend is implemented.** Authenticated patient, representative, staff and operator APIs share a durable rescheduling workflow: versioned proposals, exact-version decisions, agreed callbacks, fake reminders, repeat-safe booking changes and restart recovery. The scheduler and delivery transport use local fictional records. The Next.js frontend provides automatic fictional patient and care-team sessions, request tracking, a department overview, a care-team directory and a clearly labelled transfer simulator. Optional Twilio/GPT-Live voice, caller-approved forwarding and SMS are implemented; real identity and hospital integrations remain separate work. SMS delivery was observed in one emergency-contact demo call; complete phone verification and real transfers still need caller-driven validation.

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

Open the local web app on port 3100. The homepage links to **Open patient workspace** (`/patient`), **Open care-team workspace** (`/professional`) and **Open overview** (`/desktop`). Each enters with a provisioned fictional session automatically. Create and verify a patient request; propose and approve the exact appointment in the care-team workspace; then confirm it in the patient workspace after the simulated callback. The worker saves the booking result. Appointment displays use Halifax time with ADT/AST; callback inputs identify the device time zone. The API runs on port 4100 and this project's database on port 55439. `dev` starts the API, web app and durable worker. Local bearer sessions are saved in ignored `.env.sessions.json`; token values are never logged. Stop the app with Ctrl+C. `npm run db:stop` stops only this project's database and preserves its volume.

See [the prototype demo guide](docs/prototype-demo.md) for the full walkthrough, directory/transfer simulation, launch commands and optional hosted preview requirements.

The patient portal also supports simulated incoming calls, scheduled callbacks and explicit approval of AI-prepared actions. Live calls use GPT-Live 1 with Gleam, a feminine voice with a warm, empathetic conversational style, and a separate `gpt-6-luna` backend. The [emergency-contact scenario](docs/emergency-contact-demo.md) matches the patient's name and birthday, verifies the registered contact through a spoken or keypad SMS code, and then shares the fictional recorded location. The original coordination scenario requests a portal keypad code only when a task needs authorization; its caller-requested texts require separate keypad approval. The professional portal shows calls, handovers and SMS outcomes. No provider keys are needed for simulation. See [phone and AI setup](docs/phone-setup.md) for configuration and validation limits. `npm run voice:check` checks configuration without placing calls.

Open **Call monitor** at `/professional/monitor` to follow live caller/assistant transcripts, inspect tool inputs and results, and review timing, interruptions and errors. Captured transcripts and tool events are saved with each call and can be exported as JSON. See the [monitor guide](docs/call-monitor.md) for retention and interpretation limits.

VeriCare Journey gives every emergency visit its own agent. `/patient/visit` is the patient's page, `/family/<link>` the page for people they approve, `/professional/ed` the staff Desk, `/professional/ed/accuracy` the estimate ledger and `/professional/ed/mission` mission control. See [the Visit Agent](docs/visit-agent.md) and [the system design](docs/vericare-journey-design.md).

Open `/pitch` for the hackathon presentation: eight animated slides that each play on their own, then a live panel that follows the current phone call with its transcript, tool calls and texts from the same monitor feed. Arrow keys or a click advance, `N` shows speaker notes and `F` enters fullscreen.

Choose **Open overview** on the homepage, or open `/desktop`, to see department requests, saved booking evidence, history, appointments, calls, handovers and phone readiness together. It reuses a valid department session or enters automatically; patient sessions remain separate. Search, status filters and request links help navigate the records. The view refreshes every five seconds and keeps the last successful snapshot with a warning if refresh fails. `/professional/team` contains the fictional directory and separate transfer simulator. Directory destinations start empty; saving one does not place a call.

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
| `ml`                   | Stage-time models: open data, simulator, training, card     |
| `apps/api/src/agents`  | Visit Agent: planner, tools, knowledge-base retrieval       |
| `docs/contracts.md`    | Implemented API, authority and agent tool contracts         |
| `docs/architecture.md` | Component boundaries and workflow invariants                |
| `docs/backlog.md`      | Packages A–H, dependencies and completion evidence          |
| `docs/acceptance.md`   | Backend acceptance scenarios and executable evidence        |
| `docs/decisions.md`    | Starter choices and decisions the team still owns           |

Start with [the source brief](docs/team-guide.md) and [contributing](CONTRIBUTING.md). Before coding, read [AGENTS.md](AGENTS.md). Let others know when shared contracts change. The backlog and suggested roles are coordination aids; an owner or reviewer assignment is not required to start.

The [eight GitHub issues](https://github.com/Shivam7137/patient-request-coordination/issues) and [demonstration milestone](https://github.com/Shivam7137/patient-request-coordination/milestone/1) are optional planning aids. See [setup verification](docs/setup-verification.md) for historical checks and [GitHub settings](docs/github-settings.md) for the current lightweight configuration.

This private repository has no open-source license grant. Optional demo hosting still depends on the local backend and worker; it is not a durable production deployment. Paid provider activation, live-call validation, hospital connectors and collaborator invitations require their own setup.
