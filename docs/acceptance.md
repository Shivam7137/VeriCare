# Demonstration acceptance

These cases come from the guide. They are requirements, not passing results. Save task/event IDs, proposal versions, operation references, relevant delivery records and exact test commands as evidence when implemented.

| Scenario                         | Required outcome                                                                                                                  | Setup status                                                                 |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Complete journey                 | Verify, propose Thursday 14:30, staff approve exact version, agreed callback, patient confirms, recheck, record booking reference | Not implemented                                                              |
| Wrong-patient access             | Deny access and withhold details                                                                                                  | Not implemented; no general patient route exists                             |
| Missing representative authority | Emergency-contact match alone grants no access; request consent or staff review                                                   | Not implemented                                                              |
| Changed proposal                 | Invalidate prior decisions; obtain new decisions for current version                                                              | Not implemented                                                              |
| Duplicate submission             | Same operation key produces at most one booking change                                                                            | Not implemented                                                              |
| Unavailable slot                 | Recheck fails safely; keep the request active for a new proposal                                                                  | Not implemented                                                              |
| Lost booking response            | Show reconciliation; look up original operation before retrying                                                                   | Not implemented                                                              |
| Restart                          | Preserve task, proposals, events and due work                                                                                     | T001/event persistence test supplied; full workflow recovery not implemented |
| Hangup                           | Call termination does not finish the request                                                                                      | Not implemented                                                              |
| Cancelled reminder               | Resolve/withdraw action, cancel pending work, recheck before sending                                                              | Not implemented                                                              |
| Staff takeover                   | Retain history; stop new automated actions; reconcile in-flight work                                                              | Not implemented                                                              |

The initial integration test proves only database migration/seed repeatability and T001/event retrieval through a fresh pool/API instance. It is not a full server/process crash test or a demonstration of the scheduling workflow.
