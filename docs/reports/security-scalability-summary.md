# Security, scalability and performance: summary for judges

Written 2026-11-16. A one-page view of how VeriCare Journey keeps patient information safe, and what it would take to run at provincial scale. Details are in [the threat model](../research/05-security-threat-model.md), [the Visit Agent record](../design/visit-agent.md) and [the system design](../design/vericare-journey-design.md). Everything here was measured on the demo with fictional patients.

## Security: the model never holds the keys

| Risk                                     | What the code does                                                                                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prompt injection from a caller or a text | The language model only chooses among actions code prepared. It never writes a fact, a number or a message body. Text from the public is labelled as data in its context. |
| Disclosure to the wrong person           | A Guardian in plain code decides every disclosure, and checks again at the moment a plan is applied, so consent withdrawn mid-plan is honoured.                           |
| The model seeing too much                | It never receives a name, birth date, phone number, triage level, reason for visit or result. A silenced visit raises nothing for it at all.                              |
| A sicker patient waiting on a model      | "Worse", chest pain, breathing, fainting, bleeding and self-harm words raise a top-priority nurse task in code before any model is asked.                                 |
| Model outage or a bad plan               | A rules planner sends the same approved messages, and each fallback is logged with its reason (tested for errors, empty plans and refused plans).                         |
| Impersonation on the phone               | Alex's status and relay tools unlock only after a one-time code sent to the number on file. A silenced visit and a transfer sound identical.                              |
| Tampering                                | Visit events and the audit ledger are append-only in the database, and each ledger row is hash-chained to the one before it.                                              |
| Webhook forgery                          | Every inbound text and delivery report must carry a valid Twilio signature. A text from an unknown number gets no reply at all.                                           |
| Leaked family link                       | Only a SHA-256 hash of the link is stored; withdrawal kills it at once; it is rate-limited. It reveals the step only, never medical details.                              |

Not done yet, and needed before real patients: a privacy impact assessment with NS Health, Canadian hosting for speech and the model (today OpenAI and Twilio process outside Canada), and an external security review.

## Scalability

- **Per visit, not per hospital.** Each visit's agent wakes only on its own events. Work grows with events, not with the size of the department.
- **The hospital record stays the source of truth.** VeriCare reads the HL7 feed OPOR already emits, keeps its own state as a projection of an event log, and replays the log to rebuild it.
- **Resent messages are harmless.** Feed messages are keyed by control id, inbound texts by provider id. A replay changes nothing (tested).
- **What changes for scale.** One API process plans the agent's work today, with claims held in memory. Running several processes needs a database claim on each wake (`FOR UPDATE SKIP LOCKED`, already used by the text sender). The model call is stateless, so it scales out with processes.

## Performance (demo department, 2026-11-16)

| Measure                                 | Result                                                                              |
| --------------------------------------- | ----------------------------------------------------------------------------------- |
| Language-model plan, per decision       | 1.6 s on average, 2.2 s at the 90th percentile, 2.8 s at most (37 plans)            |
| Updates people must get                 | Sent in the same transaction as the hospital message, without waiting for the model |
| Three-hour scenario                     | 96 HL7 messages, 344 ledger rows, played in under a minute                          |
| Wait-to-be-seen ranges people were told | 25 of 35 held, none ran over (simulated department)                                 |
| Automated tests                         | 195 unit and 234 database tests                                                     |

Model calls time out after 8 seconds and fall back to the rules path. The stage-time model runs inside the API with no machine-learning runtime.
