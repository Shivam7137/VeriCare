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

## Basic frontend verification — 2026-10-10

The Next.js development fixture was replaced with a basic responsive patient/staff/operator demo. `npm run check` passed again after this change, including formatting, workspace type checks, 13 unit tests and all builds.

A real headless Chromium session completed the browser journey against the running API and worker: patient creation and verification, staff proposal and approval, simulated callback, patient confirmation, then a durable scheduler reference. Reloading preserved the completed request. Operator monitoring, sign-out, and the mobile layout at 390px also passed, with no page exceptions or horizontal overflow. This walkthrough created one new fictional request and moved its fictional booking; existing tasks and history were preserved.

Additional browser checks rejected a cross-origin demo login and unsupported persona, verified the HttpOnly/SameSite cookie and absence from `document.cookie`, and denied task access after logout. A four-second task response still rendered without overlapping polling. Removing the selected appointment from a subsequent availability response preserved that selection and disabled submission until the user selected another time. Independent review confirmed both polling/selection fixes and found no remaining blocker in the local demo scope.

The runtime remains the three processes from `npm run dev`, with the web UI on port 3100 and API on 4100. No production authentication or external provider connection was added. See the [frontend walkthrough](setup.md#basic-frontend-walkthrough).

## Separate portals and phone agents — 2026-10-10

On `Shivam`, `npm run check` passed with 65 unit/protocol/portal tests, all workspace type checks, formatting and production builds. `npm run test:backend` passed 136 PostgreSQL integration tests with zero failures or skips. Migration 004 was applied to the local database without replacing existing data. `npm run voice:check` reported simulated mode ready and live mode disabled.

Real headless Chromium journeys against the running API and worker verified independent patient/professional sessions; request creation and verification; staff proposal and approval; simulated agent preparation, cancellation and explicit patient approval; scheduler-confirmed completion; progress readback and hangup. A second journey verified callback-window change approval, scheduled callback dispatch, answering with a fresh code, visible professional handover, and new-request phone intake saved only after approval. Signing out of the patient portal preserved the professional session. No page exceptions or horizontal overflow occurred; phone flows were checked at desktop, 390px and 320px widths. These journeys created fictional requests and changed one fictional booking; prior records were retained.

Independent review findings were fixed and regression-tested: initial audio arriving during authentication, early keypad input, interrupted readback/repetition, cancellation races, callback eligibility immediately before each dispatch, obsolete callbacks blocking the queue, final booking readback, signed recovery of uncertain dispatch, and shutdown waiting for pending stream authorization and database finalization.

Twilio and OpenAI transports were validated using signatures, protocol fixtures, local WebSockets and injected provider responses. No real provider calls, audio sessions or external messages were sent. Actual provider connectivity and spoken quality remain unverified until credentials, a voice number, allowlisted test numbers and public HTTPS routing are supplied. See [phone setup](phone-setup.md).

The environment draft now includes updated phone startup instructions, simulated defaults, and optional egress domains `api.twilio.com` and `api.openai.com`; existing installation instructions and network presets were preserved. The draft was saved, but publication and fresh-task restoration were not performed. Review/save the draft and publish it in environment settings when reusing this configuration.

## Desktop overview — 2026-10-10

The `/desktop` screen aggregates the existing department-scoped professional APIs. It adds request search, status filters and pagination; selected-request history and confirmed booking evidence; recent calls and professional handovers; associated bookings and slot availability; and phone/AI readiness. Its sign-in uses the existing read-only operator demo account, or reuses a professional session. The separate patient session is preserved.

`npm run check` passed with 65 tests, formatting, workspace type checks and production builds. Headless Chromium verified the screen against saved API records, including filters, evidence, request links, call details, readiness and logout. Responsive checks passed at 1536, 1366, 1024, 768, 390 and 320 pixels without page overflow; narrow request tables scroll within their container. Separate browser fixtures verified 13-request pagination, empty states, stale-data warnings during server failure, persistent expired-session errors, and logout while an earlier data request remained in flight. These checks did not change backend records or call external providers. A [desktop screenshot](screenshots/desktop-overview.png) is saved for viewing without starting the app.
