# Patient/professional portals and phone agents

Goal: separate patient and healthcare-professional web experiences and prepare a working synthetic phone/AI integration before provider credentials are supplied.

## Design

- `/patient` and `/professional` are distinct workspaces with their own session cookies. The homepage selects a portal. Professionals retain backend staff/operator permissions; a doctor label does not create a new unrestricted role.
- Default `VOICE_MODE=simulated` needs no external credentials. The patient can generate a short-lived phone access code, simulate a verified call, try permitted agent actions, and request a callback. Professionals see calls, setup readiness and handover requests.
- Twilio Voice receives signed webhooks, authenticates callers with a single-use code obtained from the authenticated portal (caller ID is not authority), then connects a signed/token-bound Media Stream to OpenAI Realtime. Audio is G.711 mu-law. API keys and numbers stay on the server. No audio or verbatim transcript storage by default.
- An appointment-coordination agent can read current progress and propose a callback change or confirmation/withdrawal; a routing agent handles handover. No clinical advice, staff approval, direct scheduling, or model-declared completion. Any patient mutation proposed by AI requires a separate explicit patient confirmation (DTMF or authenticated simulator control) and fresh backend revision/authority checks.
- Phone sessions bind to the authenticated principal and optional existing task. New-request intake uses the patient's own appointment and explicit availability/callback intervals; ambiguous times require clarification. Pending actions are shown/read back before confirmation. Ending a call only records call outcome.
- Outbound callbacks are explicit patient requests, bounded by the agreed callback window and an allowlisted test number, persisted before provider dispatch. Uncertain Twilio call creation is exposed for reconciliation, never blindly redialled. Status callbacks are idempotent and cannot regress a terminal call. Live mode requires credentials, a public HTTPS webhook origin and an explicit enable flag; supplying keys alone does not place calls.
- No live calls, messages, deployments, or real patient records in this implementation session. The remaining credential/number/public-URL configuration is documented without asking the user to share keys in chat.

## Implementation and checks

1. Portal UI and separate sessions: split the existing dashboard into explicit patient/professional entry points; retain backend authority and mobile layout. Add phone panel to each portal through the integration contract.
2. Provider adapters: typed voice configuration/readiness, signed Twilio webhook validation/TwiML and call creation, OpenAI Realtime bridge with interruption handling and function-call results. Test protocol fixtures, malformed/unsigned input, disconnects and tool restrictions without contacting providers.
3. Durable phone domain: additive migration, expiring single-use access codes, authenticated simulation, explicit action confirmation, call status/event history, handover, bounded outbound dispatch and uncertain-outcome handling. Test authorization, replay, expiry, cross-patient access and no completion on hangup.
4. Integrate API, worker and portal phone panels; document exact environment variables/provider console instructions. Verify both portals and simulated call flow in Chromium, full backend suites, type/format/build and independent review. Commit on `Shivam`.

The existing isolated cloud checkout and synthetic data are preserved. The user authorized implementation; repository planning instructions require no additional approval ceremony. Current `globals.css` exceeds 600 lines; new portal/phone styles go in separate focused stylesheets.
