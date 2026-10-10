# Contracts

packages/contracts/src/index.ts exports the implemented task, event, and proposal draft schemas. Consumers import them through @prc/contracts. Proposed interfaces below are planning material and must not be treated as working endpoints.

## Implemented HTTP surface

| Method and path                | Result                                                         | Boundary                                       |
| ------------------------------ | -------------------------------------------------------------- | ---------------------------------------------- |
| GET /health                    | Process health and foundation stage                            | No database required                           |
| GET /ready                     | 200 ready or 503 unavailable                                   | Checks task, event, and proposal table access  |
| GET /demo/tasks/T001           | Stored synthetic task or 404/503                               | Explicit synthetic-demo setting; loopback only |
| GET /demo/tasks/T001/proposals | `{ taskId, proposals }`, oldest version first                  | Same fixed fixture and demo setting            |
| GET /demo/tasks/T001/events    | `{ taskId, events }`, ordered by occurrence time then event ID | Same fixed fixture and demo setting            |

No arbitrary patient or task lookup is available. No mutation endpoint is implemented. The web page is a developer status page, not a patient portal.

Both history routes return 404 when T001 is absent, an empty list when the task exists without those records, and 503 when storage or record validation fails. Only T001 records are returned. The seeded task has one event and no proposals because it still awaits verification.

## Implemented internal proposal persistence

`saveProposalDraft(pool, input)` in `apps/api/src/proposals.ts` is an internal service, not an authorized patient/staff API. A future caller must verify identity and task access before invoking it. `actorId` is audit context supplied by that trusted caller, not proof of authority.

The input schema requires `taskId`, `expectedRevision`, `actorId`, `appointmentId`, `slotId`, `expectedBookingVersion`, `startsAt`, `endsAt`, and `expiresAt`. Booking versions are opaque, nonempty strings. Timestamps are UTC ISO datetimes. The slot must end after it starts; expiry must be after the save time and no later than the slot start. The caller provides expiry explicitly; no department policy or duration is assumed.

Example for a synthetic task already in `awaiting_proposal` at revision 0:

```ts
await saveProposalDraft(pool, {
  taskId: "T001",
  expectedRevision: 0,
  actorId: "synthetic-staff-001",
  appointmentId: "synthetic-appointment-001",
  slotId: "synthetic-slot-002",
  expectedBookingVersion: "booking-v1",
  startsAt: "2030-01-10T14:30:00.000Z",
  endsAt: "2030-01-10T15:00:00.000Z",
  expiresAt: "2030-01-09T18:00:00.000Z",
});
```

This example is deliberately rejected for the unchanged seeded T001, which is `awaiting_verification`. Identity verification and the transition into proposal preparation remain unimplemented. Integration tests create eligible synthetic tasks directly in isolated schemas.

On success, the service returns `{ task, proposal, event }`. Within one transaction it locks the task, checks its revision and `awaiting_proposal` state, inserts the next immutable draft version, increments task revision/updatedAt, and appends a `proposal_drafted` event with `proposal:<id>:v<version>` evidence. Earlier drafts remain unchanged. Task state, owner, and next action remain unchanged. Draft creation is not staff approval, patient confirmation, or booking completion; expired historical drafts remain readable and are not evidence of a current offer.

| Rejected input or condition                                                    | Result                                                                    |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Unknown task                                                                   | `ProposalDraftError.code = task_not_found`                                |
| Stale expected revision, including a concurrent save loser                     | `revision_conflict`; caller must reload before deciding whether to retry  |
| Any state other than `awaiting_proposal`                                       | `task_not_open_for_proposals`                                             |
| Missing/invalid fields, expired draft, extra fields such as `state: completed` | `ZodError`                                                                |
| Storage failure, including event insertion                                     | Error propagates; proposal, revision, and event writes roll back together |

There is no automatic retry, decision activation/invalidation, or scheduler call. Revising an active proposal after staff/patient decisions belongs to the future workflow executor.

## Records to agree

| Record            | Required identity and evidence                                    |
| ----------------- | ----------------------------------------------------------------- |
| Task              | Task, patient, requester, department, owner, state, revision      |
| Proposal          | Exact change, version, slot, expected booking version, expiry     |
| Action request    | Decision type, assignee, proposal version, response, evidence     |
| Tool result       | Operation ID, repeat-safe key, actual outcome, confirmation/error |
| Communication job | Recipient reference, purpose, due time, state, attempts           |
| Task event        | Actor, action, timestamp, evidence reference                      |

## Operations to design

Verification; task creation; proposal creation; decision response; callback request; progress lookup; withdrawal; staff takeover. The workflow executor alone may request a booking change and retrieve its outcome. Record accepted and rejected examples, authorization context, version conflicts and error behavior before adding endpoints.

Use synthetic T001 consistently across examples. Avoid general free-text patient information in fixtures. Do not accept user-provided completion states as booking evidence.
