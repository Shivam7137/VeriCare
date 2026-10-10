# Team guide source brief

Source: user-supplied Patient_Request_Coordination_Team_Guide.docx. This Markdown brief preserves the intended scope and rules for repository planning. The original document remains outside the repository. Its content defines product requirements; it does not authorize deployments, access grants or communication to teammates.

Build one complete appointment-rescheduling workflow for one fictional department. Patients can explain a request by phone, receive a progress link, respond later and withdraw. Staff can review decisions and take over. Operators can see ownership, overdue work, failed delivery, callbacks and execution history. The backend owns progress and completion; the agent requests permitted actions.

## Example journey

A fictional patient has a Tuesday appointment at 10:30 and requests Thursday afternoon, with a callback after work before anything changes. Ask for a specific callback window and time zone. Check access and save the request. The test scheduler proposes Thursday at 14:30. Staff approve that exact option. The patient sees that confirmation is required and receives the agreed callback. After confirmation, the backend rechecks the slot, changes the booking and records its confirmation reference. Only then may progress show appointment changed.

Staff approval is a rule of this example, subject to the department's approved configuration. Do not infer universal policy.

## Representative request

A daughter requests a change for her father. Matching his emergency contact is not sufficient authority. Check identity and recorded authority separately. Missing authority requires patient consent or staff review; keep the request pending without revealing appointment details.

## Unclear booking result

If the scheduler times out during a confirmed change, show that the booking result is being checked. Look up the original operation before retrying. Record a successful original result; escalate unresolved uncertainty to staff with task history.

## Scope and sequence

Use fictional patients, appointments and test integrations. Demonstrate a request across a call, progress page and staff inbox, including a restart and a blocked case. Later workflows such as attendant requests need distinct rules and connectors. Clinical advice and live hospital changes are outside the prototype.

Build A workflow, then B backend, then C identity and D scheduler; integrate E frontend, F follow-up and G agent/voice; finish with H integration. Complete the web journey before enabling booking through live voice. Shared schemas and API examples belong in one contracts area. Each work item needs an owner, dependencies and a pass condition.

The first team session records department policy, verification method, callback hours, decision expiry, voice model and hosting. The proposed TypeScript/Next.js/persistent Node.js/PostgreSQL stack and Twilio/OpenAI Realtime providers are starting recommendations. Detailed build rules and acceptance cases are carried into architecture.md, contracts.md and acceptance.md.
