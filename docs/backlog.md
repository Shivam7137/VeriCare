# Team backlog

The backend completion goal is implemented for synthetic records. Packages remain coordination aids; no assignment or formal review is required to experiment.

| Package           | Status                      | Delivered or remaining work                                                                                                                                                                                 |
| ----------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A Workflow        | Backend complete            | Explicit demo policy, versioned decisions, callback window, completion evidence and stop/recovery semantics.                                                                                                |
| B Backend         | Complete                    | Authenticated commands and progress, immutable proposals/events, optimistic revisions, transactional execution and worker recovery.                                                                         |
| C Identity        | Synthetic backend complete  | Locally provisioned opaque sessions, patient/department scopes, representative consent requests/grants/revocation. Real identity verification remains an integration.                                       |
| D Scheduler       | Mock complete               | Persisted slots/bookings, exact time/version checks, one change per operation key, durable receipt lookup and reconciliation.                                                                               |
| E Frontend        | Basic demo complete         | Patient creation/verification/confirmation, staff proposals/approval/takeover, operator overview, callback changes, withdrawal and history. Representative consent screens and production login remain.     |
| F Follow-up       | Mock complete               | Durable callbacks/reminders, agreed-window enforcement, cancellation, bounded retries, receipts and operator diagnostics.                                                                                   |
| G Agent and voice | Provider wiring complete    | Verified call sessions, explicit phone approvals, incoming/callback simulation, Twilio webhooks, Realtime audio bridge and model configuration. Actual credentials/public HTTPS and live test calls remain. |
| H Integration     | Backend acceptance complete | Isolated PostgreSQL tests cover complete journey, authorization, concurrency, failure recovery and process crash. Basic web journey is verified; live voice demonstration waits for provider integration.   |

See [acceptance evidence](acceptance.md), [API contracts](contracts.md), [setup](setup.md), and the [backend completion plan](backend-completion-plan.md). The GitHub planning issues have not been automatically closed: some include frontend or live integration scope.
