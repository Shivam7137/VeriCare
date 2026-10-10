# Backend contracts

The synthetic backend implements the workflow below with PostgreSQL, local identities, a database-backed mock scheduler, and fake delivery. Shared input and record schemas are exported by [`@prc/contracts`](../packages/contracts/src/index.ts). Real identity providers, hospital scheduling, telephone calls, and further frontend features remain separate work.

## Authentication and access

Every backend route in the tables below requires `Authorization: Bearer <opaque-token>`. Local provisioning creates expiring sessions for verified, active synthetic principals; PostgreSQL stores token hashes. Use `npm run demo:credentials` as described in [setup](setup.md); there is no HTTP login, token-minting route, or request field that selects the caller's identity or role. Never put tokens in URLs, logs, or Git.

Patients access their own records. A representative is a patient-role principal who also needs a current, unrevoked grant for the represented patient. Emergency-contact status grants nothing. Department staff may propose, approve, take over, and execute; department operators may monitor but cannot mutate the workflow. Current identity and authority are checked again by the services. Only the assigned requester may verify, change the callback window, or confirm a task; withdrawal is also available to the represented patient.

The public exceptions are `GET /health` (process liveness), `GET /ready` (database/schema readiness), and the fixed synthetic demo routes when explicitly enabled. Readiness returns `200 {status:"ready"}` or `503 {status:"not_ready",reason:"database_or_schema_unavailable"}`. The demo paths are `/demo/tasks/T001`, `/demo/tasks/T001/proposals`, and `/demo/tasks/T001/events`; their responses remain `Task`, `{taskId,proposals}`, and `{taskId,events}` respectively. They expose only the fixed fixture and return 404 when it is absent or 503 when unavailable. The API binds to loopback.

## Inputs and concurrency

JSON inputs are strict: extra fields, including caller-supplied roles, actors, completion state, or booking confirmation references, are rejected. IDs are nonempty strings; patient, appointment, slot, and authority-requester input IDs are limited to 200 characters. `summary` is trimmed, 1–500 characters; `evidenceRef` is trimmed, 1–200 characters.

| Input name   | Exact JSON fields                                                                                                                             |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `TimeWindow` | `{startsAt, endsAt, timeZone}`: UTC ISO datetimes ending in `Z`, end after start, explicit valid IANA zone such as `America/Halifax` or `UTC` |
| `CreateTask` | `{patientId, appointmentId, availability: TimeWindow, callbackWindow: TimeWindow, summary}`                                                   |
| `Revision`   | `{expectedRevision}`: nonnegative integer                                                                                                     |
| `Propose`    | `{expectedRevision, slotId, expiresAt}`: UTC ISO expiry                                                                                       |
| `Decision`   | `{expectedRevision, proposalVersion, response, evidenceRef}`: positive integer version; response `approve` or `reject`                        |
| `Callback`   | `{expectedRevision, callbackWindow: TimeWindow}`                                                                                              |
| `Stop`       | `{expectedRevision, evidenceRef}`                                                                                                             |

Creation requires future availability and a callback window that has not ended and ends no later than availability starts. Proposal slots must be available and within that availability; expiry must be after creation and callback start and no later than the slot start. Callback delivery and requester approval must occur inside the agreed callback window. The demo department requires staff approval.

Workflow commands lock the task and compare `expectedRevision`; successful changes increment the revision and append audit evidence atomically. Reload progress after a conflict or background delivery, which can also increment the revision. `POST /tasks/:id/execute` rechecks staff access and revision under the executor's lock. An already saved operation for the same active proposal can be replayed with the original revision; replay does not create another operation.

## Task and scheduling routes

Success is HTTP 200 unless indicated otherwise. `Progress` is defined below.

| Method and path                  | Input                               | Result and authority                                                                                                                                     |
| -------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /me`                        | None                                | `Principal`: authenticated identity                                                                                                                      |
| `GET /tasks`                     | None                                | `{tasks: Progress[]}`: authorized tasks, most recently updated first, at most 200 candidates; includes patients covered by current representative grants |
| `POST /tasks`                    | `CreateTask`                        | 201 `Task`: patient or authorized representative becomes requester                                                                                       |
| `GET /tasks/:id`                 | None                                | `Progress`: authorized patient/representative or department staff/operator                                                                               |
| `GET /tasks/:id/events`          | None                                | `{taskId, events}`: occurrence time, then event ID                                                                                                       |
| `GET /tasks/:id/proposals`       | None                                | `{taskId, proposals}`: immutable drafts in version order                                                                                                 |
| `POST /tasks/:id/verify`         | `Revision`                          | `Task`: requester records access verification using the verified local identity and booking ownership                                                    |
| `POST /tasks/:id/proposals`      | `Propose`                           | `Task`: staff activates the next proposal version                                                                                                        |
| `POST /tasks/:id/staff-approval` | `Decision`                          | `Task`: department staff decides the exact active version                                                                                                |
| `POST /tasks/:id/confirmation`   | `Decision`                          | `Task`: requester decides the exact active version; approval requires delivered callback evidence                                                        |
| `POST /tasks/:id/callback`       | `Callback`                          | `Task`: requester changes the callback window and invalidates active decisions                                                                           |
| `POST /tasks/:id/withdraw`       | `Stop`                              | `Task`: requester or represented patient stops the request                                                                                               |
| `POST /tasks/:id/takeover`       | `Stop`                              | `Task`: department staff takes ownership and stops new automated work                                                                                    |
| `POST /tasks/:id/execute`        | `Revision`                          | `Progress`: department staff invokes the backend executor; inspect task/operation status for confirmed, rejected, cancelled, or reconciling outcome      |
| `GET /slots?patientId=...`       | Exactly `patientId` query parameter | `{patientId, slots: Slot[]}`: authorized patient's department, ordered by start and ID; inspect `available`                                              |
| `GET /bookings/:id`              | None                                | `Booking`: requires access to its patient; inaccessible and absent bookings both return 404                                                              |

Typical states are `awaiting_verification` → `awaiting_proposal` → `awaiting_staff_approval` → `awaiting_patient_confirmation` → `ready_to_execute` → `executing` → `completed`. Rejected proposals or expired windows return to proposal preparation; uncertainty uses `reconciling`. Pre-dispatch withdrawal/takeover uses `withdrawn`/`staff_takeover` and cancels pending work.

A replacement proposal cancels old pending actions/jobs and requires fresh decisions for its version. Staff approval schedules a fake callback and, when the window permits, a reminder five minutes after the later of approval and callback-window start. A reminder is not callback evidence. Completion requires a persisted scheduler confirmation matching the proposed booking, patient, department, slot, and times.

On a fresh seed, `synthetic-slot-002` starts next Thursday at 14:30 UTC. Re-seeding preserves existing slots and moved bookings, so older local records may have different times. Read `/slots` and use the returned instants rather than assuming the fixture time.

## Response records

All serialized timestamps are UTC ISO strings. Fields marked optional are omitted when unset; fields marked nullable are returned as `null` when absent.

| Record            | Fields                                                                                                                                                                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Principal`       | `id, role` (`patient`, `staff`, `operator`), nullable `patientId, departmentId`, `verified, active`                                                                                                                                 |
| `Task`            | `id, patientId, requesterId, departmentId, owner, state, revision, summary, nextAction, synthetic:true, createdAt, updatedAt`                                                                                                       |
| `Workflow`        | `appointmentId, availability, callbackWindow, requireStaffApproval`; optional `activeProposalVersion, callbackDelivered:{version,at}, operationId, takeoverRequested, withdrawalRequested`                                          |
| `Proposal`        | `id, taskId, version, status:"draft", appointmentId, slotId, expectedBookingVersion, startsAt, endsAt, expiresAt, createdAt, createdBy`; activation is identified by the workflow's version, not a change to immutable draft status |
| `Action`          | `id, proposalVersion, kind` (`staff_approval`/`patient_confirmation`), `assigneeId, status, expiresAt`, nullable `respondedBy, respondedAt, evidenceRef`; statuses `pending, approved, rejected, cancelled`                         |
| `Event`           | `id, actorId, action, occurredAt, evidenceRef`; task context is supplied by the progress record or `{taskId,events}` wrapper                                                                                                        |
| `Operation`       | `id, operationKey, proposalVersion, status, result, attempts, lastError`; statuses `prepared, dispatched, reconciling, confirmed, rejected, cancelled`; result and error are nullable                                               |
| `SchedulerResult` | `{status:"confirmed", confirmationRef, booking:Booking}` or `{status:"rejected", reason}`                                                                                                                                           |
| `Job`             | `id, proposalVersion, kind` (`callback`/`reminder`), `status` (`pending, delivered, cancelled, failed`), `recipientId, dueAt, expiresAt, attempts`, nullable `lastError, deliveredAt`                                               |
| `Slot`            | `id, departmentId, startsAt, endsAt, available`                                                                                                                                                                                     |
| `Booking`         | `id, patientId, departmentId, slotId, version, startsAt, endsAt`; booking version is a string                                                                                                                                       |

`Progress` is `{task, workflow, proposals, activeProposal, actions, events, operations, operation, jobs}`. `workflow`, `activeProposal`, and `operation` are nullable. It includes historical proposals and operations; `operation` identifies the workflow's saved operation. Legacy T001 may have no workflow record and remains readable; create a new task for the full journey. The older demo event response additionally includes `taskId` on each event.

## Representative authority routes

| Method and path                                      | Exact input                                        | Result                                                                                                                        |
| ---------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `POST /authority-requests`                           | `{patientId}`                                      | 201 `AuthorityRequest`; authenticated patient-role requester asks for access                                                  |
| `GET /authority-requests`                            | None                                               | `{requests: AuthorityRequest[]}` for the requester, represented patient, or department staff; operators receive an empty list |
| `POST /authority-requests/:id/review`                | `{approved, evidenceRef, expiresAt?}`              | `AuthorityRequest`; represented patient or department staff decides; approval requires a future UTC ISO expiry                |
| `POST /authority-grants`                             | `{patientId, requesterId, expiresAt, evidenceRef}` | 201 `AuthorityGrant`; represented patient or department staff grants/renews explicit authority                                |
| `DELETE /patients/:patientId/authority/:requesterId` | None                                               | 204, empty body; represented patient or department staff revokes authority                                                    |

`AuthorityRequest` is `{id, patientId, requesterId, status, createdAt, reviewedBy, evidenceRef}`, with status `pending`, `approved`, or `denied` and nullable review fields. `AuthorityGrant` is `{id, patientId, requesterId, grantedBy, expiresAt, revokedAt, evidenceRef}`, with nullable `revokedAt`. Pending requests contain no appointment details and do not establish whether a patient ID exists. Access begins only after a valid grant; expiry or revocation removes it on subsequent checks.

## Agent boundary

`POST /agent/interpret` accepts exactly `{text}` (trimmed, 1–2000 characters) and performs no mutations. It returns `{intent, availability, callbackWindow, clarifications, ready}`. Intent is `reschedule` or `unknown`; windows are `TimeWindow` or `null`; clarifications are strings; `ready` only means this limited parser found the required explicit information, not that access or booking eligibility has been established.

Use this deterministic syntax, separated by semicolons or newlines:

```text
Reschedule my appointment;
availability: 2030-01-14T15:30:00Z/2030-01-14T17:00:00Z [America/Halifax];
callback: 2030-01-07T12:00:00Z/2030-01-07T13:00:00Z [America/Halifax]
```

Both interval endpoints must include seconds and end in `Z`; fractional seconds are accepted. Each label must occur once and its interval must have a valid IANA zone. Relative phrases such as “Thursday afternoon” or “after work”, missing zones, invalid dates, reversed intervals, and duplicate labels produce clarification prompts without invented times. The parser recognizes rescheduling language or moving/changing an appointment; it does not resolve natural-language dates or check current-time eligibility.

`POST /agent/tools` accepts only these strict envelopes and returns `{tool, result}`. It calls the same workflow service with the bearer session's actor and authority:

| Envelope                                            | Result                                                                           |
| --------------------------------------------------- | -------------------------------------------------------------------------------- |
| `{tool:"progress", taskId}`                         | `Progress`                                                                       |
| `{tool:"request_callback", taskId, input:Callback}` | `Task`                                                                           |
| `{tool:"confirm", taskId, input:Decision}`          | `Task`; same requester, active-version, and callback checks as HTTP confirmation |
| `{tool:"withdraw", taskId, input:Stop}`             | `Task`                                                                           |
| `{tool:"call_ended", taskId, evidenceRef}`          | `Task`; requester-only audit event increments revision while preserving state    |

There is no agent staff-approval, execution, or completion tool. Ending a call or delivering a message never completes a booking.

## Operator and worker behavior

`GET /operator/queue` is available to current department staff/operators and returns `{departmentId, asOf, counts, tasks:Progress[]}`. Patients receive 403. Counts cover the returned tasks, with the same 200-candidate limit as task listing:

- `tasks`: returned task count.
- `overduePendingActions`: pending actions whose expiry is at or before `asOf`.
- `overdueJobs`: pending jobs due at or before `asOf`.
- `failedDeliveries`: jobs with status `failed`.
- `reconciliation`: operations with status `dispatched` or `reconciling`.

The separate worker expires pending proposal/callback windows, drains due fake jobs, and recovers ready or unfinished operations. `npm run worker:once` runs one iteration; `npm run worker` repeats it. Each iteration considers up to 100 tasks/jobs per stage. Delivery rechecks task state, active version, authority, decision, and expiry under locks; attempts are bounded to three with persisted exponential backoff and one fake receipt per job. No external message is sent.

The executor saves an operation before dispatch with key `reschedule:<taskId>:v<proposalVersion>`. The mock scheduler commits booking changes and a receipt atomically. Response loss triggers lookup of that original key before any retry; uncertainty remains visible in progress. Withdrawal/takeover after dispatch records the stop request and reconciles the existing operation. If the booking was already confirmed, its completion evidence is retained and staff review is requested; a second booking change is not launched.

## Errors

Authenticated backend routes return only `{error:"code"}` for errors. Raw storage messages, stack traces, tokens, and validation internals are not returned. A successful execute response can contain a rejected/cancelled/reconciling operation; HTTP 200 alone does not mean the appointment changed.

| HTTP status | Codes and meaning                                                                                                                                                                                                                                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 400         | `invalid_input` for malformed JSON, invalid schema, or extra fields; `invalid_windows` for invalid availability/callback ordering or elapsed callback windows                                                                                                                                                                                    |
| 401         | `unauthorized`: missing, invalid, expired, or revoked session, or inactive/unverified identity                                                                                                                                                                                                                                                   |
| 403         | `forbidden` or `requester_required`: an authenticated role cannot perform the action, including patient access to the operator queue                                                                                                                                                                                                             |
| 404         | `not_found`: absent or inaccessible patient/task/booking/authority record; staff-only authorization also uses this response                                                                                                                                                                                                                      |
| 409         | Workflow conflicts such as `revision_conflict`, `proposal_version_conflict`, `invalid_transition`, `proposal_expired`, `callback_required`, `callback_window_unavailable`, `slot_unavailable`, `outside_availability`, `action_not_pending`, `not_ready_to_execute`, `workflow_not_initialized`, `department_not_configured`, `already_reviewed` |
| 503         | `storage_unavailable`: unexpected backend/storage failure                                                                                                                                                                                                                                                                                        |

Reload progress after a 409 and decide from the current state rather than blindly repeating a mutation. Only the configured `demo-department` accepts new workflow requests. The public readiness/demo routes retain their response shapes described above.

## Earlier internal draft service

[`saveProposalDraft`](../apps/api/src/proposals.ts) remains an internal persistence helper covered by its original regression tests. It takes trusted audit context, locks/revision-checks an `awaiting_proposal` task, and returns `{task,proposal,event}` without activating a workflow proposal. It is not an HTTP authentication boundary and is not used by the active workflow's proposal endpoint. New clients use the authorized routes above.

## Basic web demo adapter

The loopback Next.js app exposes `/api/session` (GET identity, POST `{persona:"patient"|"staff"|"operator"}`, DELETE sign out) only with `ENABLE_SYNTHETIC_DEMO=true`. Every session/proxy request includes `X-PRC-Portal: patient|professional`. The two portals have separate HttpOnly, SameSite=Strict cookies; patient permits only the patient role, professional permits staff/operator. Each proxy request rechecks the backend identity against that portal. It reads existing locally provisioned sessions; it cannot create new backend principals, roles, or sessions. Identity JSON never includes the bearer token. Mutating requests require an Origin matching the loopback host on port 3100.

`/api/backend/*` forwards that cookie as bearer authorization only to an allowlist of task commands/reads, slots, the current booking, the operator queue and authenticated phone commands below. It cannot proxy arbitrary URLs, provider webhooks or local files. Fastify applies the same authorization and revision checks to these requests. The frontend displays backend decisions and confirmation evidence; it has no completion or direct execution button. Time entry is explicitly UTC; polling is serialized, and disappearing appointment choices require explicit reselection.

## Phone API

All paths below use the same authenticated bearer identity and current patient/department scope. Input objects reject unknown fields. Call IDs and pending action IDs are server-generated UUIDs.

| Method/path                     | Input or result                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------ |
| GET `/voice/config`             | Safe readiness, agent responsibilities, audio/transcript storage flags; no credential values.    |
| POST `/voice/access-codes`      | `{taskId?}` → `{code,expiresAt}`; active verified patient/requester only.                        |
| POST `/voice/simulate`          | `{code}` → verified simulated call; disabled in Twilio mode.                                     |
| GET `/voice/calls`              | `{calls}` scoped to the requester or professional department.                                    |
| GET `/voice/calls/:id`          | Call status and limited operational events, without code/token hashes or full recipient numbers. |
| POST `/voice/callbacks`         | `{taskId,to,dueAt}` → queued call within the agreed window; live numbers must be allowlisted.    |
| POST `/voice/calls/:id/verify`  | `{code}` → authenticated simulated callback; assigned patient only.                              |
| POST `/voice/calls/:id/tool`    | `{toolCallId,name,arguments}` → tool result or pending action; simulator, call owner only.       |
| POST `/voice/calls/:id/confirm` | `{actionId}` → backend workflow result for that exact pending action; call owner only.           |
| POST `/voice/calls/:id/cancel`  | `{}` cancels the pending action without changing the task.                                       |
| POST `/voice/calls/:id/end`     | `{}` ends/cancels the phone session, without completing the appointment task.                    |

The allowed phone tools are `get_request_status`, `list_appointments`, `list_available_slots`, `prepare_request`, `prepare_callback`, `prepare_confirmation`, `prepare_withdrawal` and `request_human`. There is no phone tool for staff approval, execution or booking completion. Read-only access can explain a completed request; mutations still enforce current state, revision, authority and exact proposal. A pending action expires after five minutes and cannot be silently replaced. Confirmation consumption is at most once; uncertain outcomes require inspecting saved request/audit state, not automatic replay.

Public Twilio endpoints are separate, disabled by default, and require a valid signature for the configured public URL and account. Streaming also requires a single-use token bound to an authenticated call and its provider SID. [Phone setup](phone-setup.md) documents the URLs, live enable flags, credential handling, callback dispatch and protocol limits.
