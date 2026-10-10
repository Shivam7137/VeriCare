# Setup verification

The initial implementation is commit `bcc1c45e2cb9f5657107f3db8594977fba721c7b`.

These are historical setup checks. CI and automated dependency updates were subsequently removed at the user's request. Local check commands remain available, without mandatory gates.

- Local Node.js 24: formatting and type checks passed, four unit checks passed, and the Next.js production build passed.
- A real `npm run dev` launch on Windows started the web page on loopback port 3100 and API on port 4100. API health returned success. The rendered page accurately displayed the database-unavailable setup state.
- [GitHub CI run 38019175036](https://github.com/Shivam7137/patient-request-coordination/actions/runs/38019175036) passed on a clean Linux checkout: npm ci, formatting, types, unit tests, build, and the PostgreSQL integration test.
- The integration test reapplied migrations and seeds, closed the original connection pool, opened a new pool/API instance, and retrieved T001 with one initial event. This verifies persistence across application connections, not complete workflow or job recovery.
- Dependency installation reported zero known npm audit vulnerabilities at setup time. This is a point-in-time package check, not a security assessment.

Docker Desktop was stopped locally and was left unchanged. The local PostgreSQL-backed browser state was therefore not exercised; PostgreSQL persistence was verified in CI. At that initial setup stage the full demonstration scenarios were unimplemented; the current backend results below supersede that status. Repository privacy, eight open package issues, milestone, merge settings and enabled vulnerability alerts were checked through the authenticated GitHub API.

The current workspace intentionally has no branch protection or required reviews; see github-settings.md. Hosting and frontend/live-provider integration remain future project work.

## Current synthetic backend verification — 2026-10-10

On branch `Shivam`, in the cloud workspace with Node.js 24.19, npm 11.9 and PostgreSQL 17:

- `npm run check` passed: repository formatting, all workspace type checks, 13 unit tests and the contracts/API/Next.js build.
- `npm run test:backend` passed: 106 PostgreSQL integration tests, zero failures, zero skips. Isolated schemas covered the full workflow, authority, callback windows, retries, duplicate execution, scheduler receipts, concurrency and a child-process crash after scheduler commit.
- Migration 003, `db:seed` and `demo:credentials` completed. Repeated seed and credential commands preserved saved records and the existing credential file. The session file is ignored by Git and has mode 0600; tokens were not printed.
- The API, Next.js development page and independent worker were started together with `npm run dev`. An initial restart encountered ports still held by the prior task-owned process group; that group was stopped and the new three-process startup succeeded.
- Live HTTP checks passed for health/readiness, authenticated T001 progress and slots, unauthorized access rejection, missing representative authority, the scoped operator queue, and rendered web fixture. Post-restart API and web checks also passed.
- `npm run worker:once` completed successfully against the local development database. Scheduling changes and injected failures were tested in isolated schemas; local development records were preserved.
- Independent review findings were fixed and regression-tested: callback time advancing during lock waits, consent revocation/proposal expiry during dispatch checks, and connection starvation with five concurrent workflow requests. Final review found no remaining blockers for the synthetic scope.

Cloud startup instructions were saved to the environment configuration draft, including database setup, local credential provisioning, all three processes and readiness checks. This confirms draft persistence and the current runtime only; publication and fresh-task restoration have not been performed or verified.

The full frontend, external identity proof, live hospital/voice connections and deployment are separate work. The scheduler and delivery evidence above use persisted mocks; no real appointment or external message was created.
