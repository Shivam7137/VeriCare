# Synthetic backend completion goal

Complete the backend for the single fictional department described in `team-guide.md` and every backend scenario in `acceptance.md`, on branch `Shivam`. The goal includes runnable HTTP APIs, durable state, local identity, a mock scheduler, fake delivery, an agent tool boundary, restart recovery, and regression tests. Existing records must survive additive migrations. Frontend journeys, real identity providers, real calls, hospital integrations, and deployment are separate work.

## Design and explicit prototype choices

- Node.js 24, Fastify, PostgreSQL 17 and the current npm lockfile remain the platform. Add no external service requirements.
- Provision synthetic principals and short-lived opaque bearer sessions locally. Store only token hashes in PostgreSQL. Session provisioning writes tokens to an ignored local file, never logs them. HTTP clients cannot select their role or mint a session. Authentication, verified identity, and representative authority are separate checks.
- Patients may access themselves; representatives need an unexpired, unrevoked rescheduling grant from the patient or department staff. Emergency-contact status grants nothing. Pending authority requests contain no appointment details. Staff and operators are department-scoped; operators monitor but cannot approve or execute bookings.
- Task mutations require an expected revision and a task row lock. Proposal versions are immutable. Activating a replacement cancels previous pending actions/jobs and requires fresh staff approval and requester confirmation for the exact version.
- Demo department policy explicitly requires staff approval. Callback and availability windows use UTC instants plus an explicit IANA time zone. No inferred "after work" defaults. A callback must be delivered inside its agreed window before the assigned requester can confirm. Booking execution rechecks the recorded callback evidence, current authority, exact decisions, expiry, booking version and slot.
- Persist an operation before scheduler dispatch. Its key is derived from task and proposal version. The database-backed mock scheduler atomically persists booking changes and idempotent receipts. Response loss enters reconciliation; recovery looks up the original operation before any retry. No client supplies a completion state or confirmation reference.
- Withdrawal/takeover before dispatch cancels pending work. After dispatch, record the request and reconcile the existing operation; never launch another booking. A confirmed result remains recorded even if staff took over while it was in flight.
- Fake communication jobs are durable and version-scoped. Workers lock the task before the job, recheck state/version/authority/expiry immediately before delivery, and record one fake receipt per job. Failures have bounded retries/backoff and operator-visible errors. No external messages are sent.
- Authenticated patient/staff/operator progress endpoints expose task, active proposal, actions, operation, events, and jobs only after authorization. Agent tools use the same actor permissions and cannot approve on behalf of staff or declare completion. Text parsing returns missing-information prompts when dates/windows are ambiguous.
- A separate restartable worker drains due communication jobs, ready tasks, and unfinished operations. Health/readiness and operator endpoints expose actionable status. Synthetic demo remains loopback only.

## Implementation steps and ownership

1. **Shared storage and contracts (root):** Add migration 003, API input/output schemas, workflow records, transaction/error helpers. Verify additive migration and fixture preservation.
2. **Identity (identity agent):** Own `identity.ts`, `identity-fixtures.ts`, and `identity.test.ts`. Implement session authentication, department/patient authorization, explicit representative grants and pending requests. Verify invalid/expired/revoked sessions, wrong patient/department, missing/expired/revoked authority, and no privilege selection through HTTP.
3. **Scheduler (scheduler agent):** Own `scheduler.ts`, `scheduler-fixtures.ts`, and `scheduler.test.ts`. Implement persisted slots/bookings and idempotent change/lookup. Verify duplicate/concurrent keys, different payload under one key, unavailable slots, booking conflict, response loss and restart.
4. **Workflow and executor (root):** Implement create/verify/propose/decide/callback/withdraw/takeover, active-version invalidation and persisted operation execution/reconciliation. Test the complete journey and all blocked/racing/recovery paths.
5. **Follow-up (delivery agent):** Own `delivery.ts` and `delivery.test.ts`. Implement durable fake callbacks/reminders, eligibility rechecks, receipts, retries and cancellation. Root supplies shared workflow types and integrates worker/API.
6. **HTTP, tools, and runtime (root):** Connect authenticated routes and strict validation; provide typed progress and operator queues, agent text/tool endpoints, local credential provisioning and worker startup. Verify real HTTP and process restart as well as injected API requests.
7. **Completion gate:** Run unit and isolated PostgreSQL integration suites, format/type/build checks, live API smoke, and independent backend review. Update contracts/setup/acceptance with exact evidence and commit all completed backend work on `Shivam`.

## Review focus

- Concurrent approval/proposal/withdrawal and worker races must not execute a stale or unauthorized booking.
- Authority or session revocation must take effect at subsequent authorization checks; in-flight scheduler uncertainty must still be reconciled.
- Crashes before dispatch, after scheduler commit, or before delivery acknowledgement must not duplicate a change or fake delivery.
- Expired proposals/callback windows and malformed extra input fields must fail without leaking records or mutating tasks.
- Tests must use isolated schemas even when DATABASE_URL supplies connection options; local development records and credentials must be preserved.

## Progress

- Goal and prototype boundaries recorded. Existing baseline: commit `065f5b9`, 7 unit tests and 11 integration tests pass.
- Ruling: use the existing isolated cloud checkout and branch. Repository instructions explicitly allow a brief plan without additional approval gates; the user authorized completing the backend.

## Completed outcome — 2026-10-10

All seven implementation steps are complete for the synthetic backend. Authenticated routes, consent, versioned decisions, scheduler execution/reconciliation, fake callback/reminder delivery, agent tools, local credentials and the independent worker are integrated. `npm run dev` starts all three application processes. Additive migration and repeated seeding preserve existing local records.

Independent review identified and resolved three concurrency defects: delivery used a fixed clock across lock waits; booking eligibility could race consent revocation or expiry during a slot check; transaction-held scheduler reads could starve the connection pool. New regression tests cover each. The reviewer found no remaining blockers within this scope. Direct input validation also now rejects numeric offsets where an IANA zone is required.

Final checks passed: `npm run check` (format, types, 13 unit tests, complete build), `npm run test:backend` (106 integration tests, zero failures/skips), real HTTP authentication/authorization and web smoke checks, worker one-shot recovery, and development process restart. See [setup verification](setup-verification.md) for runtime evidence and [acceptance](acceptance.md) for the test mapping.

Frontend journeys, production identity verification, hospital/voice providers and deployment remain explicitly outside this completed backend goal. No external communications were sent and no existing development records were deleted.
