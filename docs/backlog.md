# Team backlog

The backend completion goal is implemented for synthetic records. Packages remain coordination aids; no assignment or formal review is required to experiment.

| Package           | Status                      | Delivered or remaining work                                                                                                                                            |
| ----------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A Workflow        | Backend complete            | Explicit demo policy, versioned decisions, callback window, completion evidence and stop/recovery semantics.                                                           |
| B Backend         | Complete                    | Authenticated commands and progress, immutable proposals/events, optimistic revisions, transactional execution and worker recovery.                                    |
| C Identity        | Synthetic backend complete  | Locally provisioned opaque sessions, patient/department scopes, representative consent requests/grants/revocation. Real identity verification remains an integration.  |
| D Scheduler       | Mock complete               | Persisted slots/bookings, exact time/version checks, one change per operation key, durable receipt lookup and reconciliation.                                          |
| E Frontend        | Remaining                   | Replace the development page with patient, staff and operator journeys using the implemented APIs.                                                                     |
| F Follow-up       | Mock complete               | Durable callbacks/reminders, agreed-window enforcement, cancellation, bounded retries, receipts and operator diagnostics.                                              |
| G Agent and voice | Text/tool backend complete  | Explicit-window extraction and authorized tools implemented. Real voice, model configuration and test calls remain.                                                    |
| H Integration     | Backend acceptance complete | Isolated PostgreSQL tests cover complete journey, authorization, concurrency, failure recovery and process crash. Full web/voice demonstration waits for E and live G. |

See [acceptance evidence](acceptance.md), [API contracts](contracts.md), [setup](setup.md), and the [backend completion plan](backend-completion-plan.md). The GitHub planning issues have not been automatically closed: some include frontend or live integration scope.
