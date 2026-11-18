# Run VeriCare locally

One guide for anyone bringing up the whole stack on their own machine: the database, API, worker, web apps and demo data. Part 1 is for people. Part 2 is for coding agents (Claude Code, Codex and similar) and lists the exact commands, checks and rules to follow.

No OpenAI, Twilio or hospital credentials are needed. Out of the box everything runs on fictional data, with the rules-based agent and simulated texts and calls.

## What runs

| Piece      | Started by             | Address                 | What it is                                                   |
| ---------- | ---------------------- | ----------------------- | ------------------------------------------------------------ |
| PostgreSQL | `npm run db:up`        | `127.0.0.1:55439`       | Docker container `patient-request-coordination-db-1`, v17    |
| API        | `npm run dev`          | http://127.0.0.1:4100   | Fastify backend, Visit Agent, wait model, demo director      |
| HL7 feed   | `npm run dev` (in API) | `127.0.0.1:2575` (MLLP) | Receives the simulated hospital feed                         |
| Worker     | `npm run dev`          | none                    | Delivers due jobs, expires windows, reconciles operations    |
| Web apps   | `npm run dev`          | http://127.0.0.1:3100   | Next.js: nursing app, patient app, mission control, demo bar |

Everything listens on loopback only.

---

## Part 1: for humans

### 1. Install the prerequisites

- **Node.js 24** (the repo pins it in `.nvmrc`; `>=24 <25` is enforced). npm comes with it.
- **Docker Desktop** with the Linux engine. It must be _running_ before step 3; on Windows it does not start by itself.
- **Git**.
- Optional: **Python 3.11+**, only if you want to retrain the wait model.

Check:

```sh
node --version     # v24.x
docker info        # must not error
```

### 2. Get the code and install

```sh
git clone https://github.com/Shivam7137/VeriCare.git
cd VeriCare
npm ci
npm run setup      # copies .env.example to .env; keeps an existing .env
```

### 3. Start and fill the database

```sh
npm run db:up             # starts PostgreSQL and waits until healthy
npm run db:migrate        # applies migrations in order (safe to rerun)
npm run db:seed           # small fixture (safe to rerun)
npm run demo:populate     # fictional clinic dataset (safe to rerun)
npm run demo:credentials  # demo sign-ins, saved to .env.sessions.json
```

### 4. Run it

```sh
npm run dev               # API on 4100, web on 3100, worker
```

Wait for both the API and Next to say they are ready, then open:

| App                      | URL                                           |
| ------------------------ | --------------------------------------------- |
| Nursing app (start here) | http://127.0.0.1:3100/professional/ed         |
| Patient app              | http://127.0.0.1:3100/patient/visit           |
| Mission control          | http://127.0.0.1:3100/professional/ed/mission |
| Call monitor             | http://127.0.0.1:3100/professional/monitor    |
| API health / readiness   | http://127.0.0.1:4100/health, `/ready`        |

Every page signs you in with a fictional demo account. The floating **demo bar** walks you through steps 1, 2 and 3; it can speed up time, add patients, cause a surge and push a visit to its next step. See [the demo bar guide](docs/demo/demo-bar.md) and [the prototype demo](docs/demo/prototype-demo.md).

### 5. Stop and restart

- `Ctrl+C` stops the API, web app and worker.
- `npm run db:stop` stops the database and keeps its data. `npm run db:up` brings it back.
- Next time you only need: start Docker, `npm run db:up`, `npm run dev`.
- The demo bar's **Reset** button returns the emergency department to its opening scene. It also resets itself 30 minutes after the last button press (`DEMO_IDLE_RESET_MINUTES`, `0` turns that off).

### Optional extras

All are off by default and are turned on in `.env`. Restart `npm run dev` after any change to `.env`.

| You want                    | Set in `.env`                                                                          | More                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Language-model planning     | `OPENAI_API_KEY` and `VISIT_AGENT_ENABLED=true` (a key alone never turns it on)        | [The Visit Agent](docs/design/visit-agent.md)                            |
| Embedding search in answers | `KB_EMBEDDINGS=true` (needs the key)                                                   | [The Visit Agent](docs/design/visit-agent.md)                            |
| Real text messages          | Twilio values, `JOURNEY_SMS_ENABLED=true`, numbers in `VOICE_ALLOWED_NUMBERS`          | Keep `*` off that list unless you supervise the demo                     |
| Alex on a real phone line   | Twilio values, `VOICE_MODE=twilio`, `VOICE_LIVE_ENABLED=true`, `VOICE_PUBLIC_BASE_URL` | [Phone setup](docs/setup/phone-setup.md)                                 |
| Retrain the wait model      | Python 3.11+, then the steps in [ml/README.md](ml/README.md#run-it)                    | [Stage-time models](docs/design/stage-time-model.md#17-reproducing-this) |
| Run the hosted container    | Docker; see [hosting](docs/setup/hosting.md)                                           | Same image as the Cloud Run demo                                         |

### Run the tests

```sh
npm test               # unit tests: API, web, contracts, scripts (no database)
npm run test:backend   # database tests in throwaway schemas (needs Docker and .env)
npm run check          # formatting, typecheck, unit tests and production build
```

Database tests create their own schema per test and drop only that one; your demo data is not touched.

### Troubleshooting

| Symptom                                           | Fix                                                                                                                         |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `db:up` fails with a pipe or daemon error         | Docker Desktop is not running. Start it, wait for "Engine running", retry.                                                  |
| Port 55439, 4100, 3100 or 2575 already in use     | Another copy is running: stop it. Or change the port in `compose.yaml` / `.env` (`DATABASE_URL`, `API_PORT`, `API_URL`).    |
| `engines` error during `npm ci`                   | Wrong Node version. Install Node 24 (`nvm use` reads `.nvmrc`).                                                             |
| Pages say the service is unavailable              | The API or database is down. Check `http://127.0.0.1:4100/ready`; rerun `npm run db:up`, then `npm run dev`.                |
| Signed-out or 401 errors after a day              | Demo sessions last 24 hours. Move `.env.sessions.json` aside, rerun `npm run demo:credentials`, then delete the old copy.   |
| Web calls to `/api/backend/*` return 500 in dev   | The Next dev server got into a bad state. Stop `npm run dev` and start it again.                                            |
| The API stops responding after you edit a file    | `tsx watch` sometimes fails to restart the API. Restart `npm run dev`.                                                      |
| The ED looks scrambled with visits jumping around | `npm run twin` and the demo bar are both driving the department. Run only one; `npm run twin:reset` or **Reset** cleans up. |
| Prettier complains about line endings             | The repo is LF-only. Set your editor to LF; avoid tools that write CRLF.                                                    |

Never use `docker compose down -v` to fix a problem. It deletes the database volume and all local data.

---

## Part 2: for coding agents

Read [AGENTS.md](AGENTS.md) first; its rules apply here too. This section gives you a non-interactive path and the checks that tell you each step worked.

### Bring-up, in order

Run from the repository root. Each command exits non-zero on failure; stop and report the first one that fails instead of trying later steps.

| #   | Command                    | Safe to rerun | Success looks like                                               |
| --- | -------------------------- | ------------- | ---------------------------------------------------------------- |
| 0   | `docker info`              | yes           | exit 0. If it fails, ask the user to start Docker Desktop.       |
| 1   | `npm ci`                   | yes           | exit 0                                                           |
| 2   | `npm run setup`            | yes           | prints `Created .env` or `Kept existing .env`. Never overwrites. |
| 3   | `npm run db:up`            | yes           | exit 0 after the container is healthy (`--wait`)                 |
| 4   | `npm run db:migrate`       | yes           | exit 0; already-applied migrations are skipped                   |
| 5   | `npm run db:seed`          | yes           | exit 0; existing rows are preserved                              |
| 6   | `npm run demo:populate`    | yes           | exit 0; the same daily batch is not duplicated                   |
| 7   | `npm run demo:credentials` | yes           | exit 0; keeps an existing `.env.sessions.json`                   |
| 8   | `npm run dev`              | long-running  | API answers `GET /health` with 200, web answers on 3100          |

`npm run dev` never exits. Start it as a background process (or through your preview tool; `.claude/launch.json` defines `carebridge` = `npm run dev` on port 3100), then poll for readiness instead of sleeping:

```sh
node --input-type=module -e "
const urls = ['http://127.0.0.1:4100/health', 'http://127.0.0.1:4100/ready', 'http://127.0.0.1:3100/professional/ed'];
for (const url of urls) {
  let ok = false;
  for (let i = 0; i < 60 && !ok; i++) {
    try { ok = (await fetch(url)).ok; } catch {}
    if (!ok) await new Promise((r) => setTimeout(r, 2000));
  }
  console.log(ok ? 'ok  ' : 'FAIL', url);
  if (!ok) process.exit(1);
}"
```

The first request to a Next page compiles it and can take 20 to 40 seconds.

### Before starting anything, check what is already running

Another session or the user may already have the stack up. Check before you start a second copy:

```sh
node --input-type=module -e "for (const u of ['http://127.0.0.1:4100/health','http://127.0.0.1:3100']) { try { console.log((await fetch(u)).status, u) } catch { console.log('down', u) } }"
docker ps --filter name=patient-request-coordination
```

If it is up, use it. Do not kill processes you did not start; ask the user first.

### Calling the API as a demo user

All general routes need `Authorization: Bearer <token>`. Tokens live in `.env.sessions.json` under the keys `synthetic-patient-001`, `synthetic-representative-001`, `synthetic-staff-001` and `synthetic-operator-001`. Load them from disk inside your script; never print, log, commit or paste a token. The read-only smoke test in [docs/setup/setup.md](docs/setup/setup.md) shows the pattern.

### Verifying a change

| You changed                  | Run                                                                                      |
| ---------------------------- | ---------------------------------------------------------------------------------------- |
| Anything                     | `npm test`                                                                               |
| API code that touches the DB | `npm run test:backend` (Docker and `.env` required)                                      |
| Types, shared contracts      | `npm run typecheck`                                                                      |
| Before you hand work back    | `npm run check`                                                                          |
| UI                           | Load the page in a browser against the running dev stack and read the console for errors |
| `ml/vericare_ml/features.py` | Also update `apps/api/src/journey/stage-features.ts`; the fixture test fails otherwise   |

### Rules that protect the user's machine

- **Preserve local state.** Do not delete or overwrite `.env`, `.env.sessions.json`, the Docker volume `prc_postgres_data`, or schemas you did not create. No `docker compose down -v`, no `DROP SCHEMA public`.
- **Destructive demo actions need a yes.** The demo bar's Reset, `npm run twin:reset` and "Restart the demo" truncate the fictional ED tables. Ask first if the user may be in the middle of a demo.
- **Never send a real text or call.** Check `.env` before you exercise contact or SMS flows. If `JOURNEY_SMS_ENABLED=true` or `VOICE_LIVE_ENABLED=true`, and especially if `VOICE_ALLOWED_NUMBERS` contains `*`, any phone number you type goes to Twilio for real. Do not submit numbers in the demo bar's step 2; stub `fetch` in the page or use the simulated mode.
- **One clock at a time.** Do not run `npm run twin` while the demo bar is in use.
- **Secrets stay out.** Never commit `.env*`, never echo keys, never put real patient data anywhere. All demo people and numbers are fictional.
- **Windows hosts.** The shell may be PowerShell; `npm run` scripts work the same there. Write files with LF line endings. Keep heavy Python jobs to about 4 parallel workers on 16 GB machines.
- **Files near 600 lines.** Flag them before making substantial changes (repo rule).

### Where to go next

- [docs/README.md](docs/README.md): every document, indexed.
- [docs/setup/setup.md](docs/setup/setup.md): deeper notes on migrations, sessions, the worker and integration tests.
- [docs/design/architecture.md](docs/design/architecture.md): component boundaries and invariants.
- [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).
