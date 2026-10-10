# Contracts

packages/contracts/src/index.ts is the source of truth for implemented task/event record shapes. Consumers import it through @prc/contracts. Proposed interfaces below are planning material and must not be treated as working endpoints.

## Implemented HTTP surface

| Method and path      | Result                              | Boundary                                       |
| -------------------- | ----------------------------------- | ---------------------------------------------- |
| GET /health          | Process health and foundation stage | No database required                           |
| GET /ready           | 200 ready or 503 unavailable        | Checks tasks table access                      |
| GET /demo/tasks/T001 | Stored synthetic task or 404/503    | Explicit synthetic-demo setting; loopback only |

No arbitrary patient or task lookup is available. No mutation endpoint is implemented. The web page is a developer status page, not a patient portal.

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
