# Patient, professional and phone workspaces

For the focused emergency-contact patient-location conversation, see [the emergency phone demo](emergency-contact-demo.md). `VOICE_SCENARIO=emergency_contact` accepts the registered contact's SMS code aloud or through the keypad; it does not ask for portal or staff codes. The appointment and directory instructions below describe `VOICE_SCENARIO=coordination`.

The app automatically enters the fictional `/patient` and `/professional` workspaces with independent HttpOnly sessions; no web sign-in is required. Patients create requests, track proposals and manage phone access. Care-team staff propose/approve appointments and review handovers. `/desktop` is the department overview and `/professional/team` is the fictional care-team directory and transfer simulator. The homepage links to the three main workspaces. These remain synthetic demonstration identities and a mock appointment scheduler.

## Run without credentials

Follow the [quick start](../README.md), including migrations and local session provisioning. `npm run dev` runs the API, web app and durable worker. `npm run voice:check` prints configuration readiness without reading out credentials or contacting a provider. The default `VOICE_MODE=simulated` needs no keys and never dials a number.

1. In the patient portal, create and verify a request. Select it, get a phone access code and start a simulated call.
2. Try a progress check or prepare a callback change. Review the exact action, then explicitly approve or cancel it. Preparing an action does not change the request.
3. For proposal confirmation, have a staff user propose and approve a slot in the professional portal first. The patient can then ask the assistant to prepare confirmation and approve that exact action. Only the backend worker can record a successful booking, using scheduler evidence.
4. With the default simulated voice mode, choose **Schedule a simulated callback** and **Queue simulated callback** inside the request's agreed callback window. When the worker changes it to ringing, generate a fresh code and use **Answer simulated callback with access code**. This does not use a phone network.
5. For new-request phone intake, choose **New appointment request** without submitting the web form. In the phone panel, generate an unbound code and choose **Start simulated call**. Use **Prepare a new request**, review it, and approve. Phone verification supplies the synthetic verified identity; staff still must propose and approve a slot.
6. **Ask for a professional** records a handover and stops call automation. The professional portal shows that call. This records a review queue entry; staff takeover is a separate backend action. Care-team forwarding uses a separately prepared and approved transfer as described below.

The simulator exposes the real agent tools as buttons. Spoken AI and telephone audio require the live provider configuration below. Ending a call never marks an appointment request complete.

## Care-team directory and transfers

Open `/professional/team` (**Care team & phone**). Members are fictional and their phone destinations start empty. **Add phone destination** / **Edit phone destination** and **Save destination** let staff save or clear an international-format destination. Saving never places a call. Do not enter a real number just to demonstrate the simulator.

Under **Staff phone access**, choose **Get phone access code**, then **Start simulated call**. Select **Patient context (optional)** and **Find patient’s doctor**, or explicitly **Choose a teammate**. Ambiguous/unassigned doctors require selection. Choose **Prepare simulated transfer**, review the named destination, then **Approve simulated transfer** or **Cancel transfer**. **Simulate connected** and **Simulate no answer** save explicitly simulated results. No destination is dialled, even with real voice enabled. Forwarding history keeps these outcomes separate from appointment status.

For forwarding a real Twilio call, a saved destination and an eight-digit phone code are required. The conversation starts before verification; the assistant asks for a code when the requested directory lookup or transfer needs authorization. After the assistant reads the exact action aloud, caller keypad **1** approves and **2** cancels. Spoken agreement and portal buttons cannot approve a live action. Approval unlocks only when readback finishes. The backend rejects unconfigured destinations, the app's own number and stale/replayed actions. A provider callback records the actual transfer result; dispatch alone does not establish a connection. Real handset audio and forwarding have not been validated.

## Configure Twilio and GPT-Live

Keep keys in the server's private runtime environment or the ignored local `.env` file. Never put keys in browser variables, source, screenshots or chat. The same configuration must reach both API and worker; restart both after changes. OpenAI uses a project API key with access to GPT-Live and the configured Responses backend model, not an assistant/workflow ID.

| Variable                     | Purpose                                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TWILIO_ACCOUNT_SID`         | Account owning the voice number (`AC…`).                                                                                                          |
| `TWILIO_AUTH_TOKEN`          | Actual account auth token for REST authentication and webhook HMAC verification. A proxy placeholder cannot verify signatures.                    |
| `TWILIO_PHONE_NUMBER`        | Voice-capable caller ID in E.164 form, e.g. `+15555550123`; SMS also requires messaging capability and provider eligibility.                      |
| `OPENAI_API_KEY`             | OpenAI project API key. `VOICE_OPENAI_API_KEY` is an alternative and takes precedence; use it where `OPENAI_*` names are reserved.                |
| `OPENAI_LIVE_MODEL`          | `gpt-live-1`, the implemented native Live voice model.                                                                                            |
| `OPENAI_VOICE_BACKEND_MODEL` | Defaults to `gpt-6-luna`; handles delegated reasoning and tool requests through Responses.                                                        |
| `OPENAI_VOICE`               | Defaults to `gleam`, a feminine North American voice for GPT-Live.                                                                                |
| `VOICE_PUBLIC_BASE_URL`      | Public HTTPS origin routed to this API, without a path/query, e.g. `https://voice.example.com`.                                                   |
| `VOICE_ALLOWED_NUMBERS`      | Comma-separated consenting test numbers, in E.164 form, for inbound calls, outbound callbacks and SMS.                                            |
| `VOICE_DEPARTMENT_ID`        | Use `demo-department` to scope newly arriving, unverified callers to the department's call monitor.                                               |
| `SMS_APP_URL`                | Public HTTPS app origin for texted portal links; defaults to `PUBLIC_DEMO_ORIGIN`. Paths, query data, credentials and local origins are rejected. |
| `VOICE_MODE`                 | Leave `simulated` until ready; use `twilio` for provider calls.                                                                                   |
| `VOICE_LIVE_ENABLED`         | Leave `false` until ready; must explicitly be `true` to activate provider endpoints and dispatch.                                                 |

Entering credentials alone does not turn calls on. `npm run voice:check` reports missing/invalid variable names; `liveReady: true` establishes configuration presence only, not provider connectivity. The professional portal displays the same readiness while hiding provider secrets and account identifiers. The public app phone line and authorized staff directory destination fields are displayed.

Set `VOICE_ALLOWED_NUMBERS=*` explicitly to accept all E.164 caller, callback and SMS numbers. An empty setting still blocks live readiness. Signed Twilio webhooks, authorization for protected tools, authenticated callback scheduling and explicit action approval remain required. Readiness reports `allNumbersAllowed: true` for this setting. `OPENAI_REALTIME_MODEL` belongs to the retained legacy bridge and does not choose the active Live model.

Expose only these provider paths through your HTTPS reverse proxy/tunnel to API port 4100. Preserve the exact path/query, form body and `X-Twilio-Signature`; enable WebSocket upgrade for `/voice/stream`. Do not expose local fixture or provisioning endpoints. Keep the API on loopback behind the proxy. `npm run demo:gateway` provides the restricted gateway on 4199, including the authenticated backend routes required by an optional hosted Next preview; see [prototype demo operations](prototype-demo.md).

| Twilio setting or generated callback         | Method/path                        |
| -------------------------------------------- | ---------------------------------- |
| Phone number → Voice → “A call comes in”     | POST `/voice/incoming`             |
| Phone number → Voice → call status changes   | POST `/voice/status`               |
| Verification endpoint (retained)             | POST `/voice/verify`               |
| Outbound TwiML (configured by the worker)    | POST `/voice/outbound/:id`         |
| Outbound status (configured by the worker)   | POST `/voice/status?callId=:id`    |
| Transfer result (generated TwiML)            | POST `/voice/transfers/:id/result` |
| SMS delivery status (generated per message)  | POST `/voice/sms/:id/status`       |
| Bidirectional Media Stream (generated TwiML) | WSS `/voice/stream`                |

Allow outbound HTTPS to `api.twilio.com` and secure WebSockets to `api.openai.com`. The reverse proxy must support a persistent bidirectional connection. On a Twilio trial account, callback destinations may also need verification in Twilio. A public gateway still depends on its local API, worker, database and tunnel.

The `/voice/stream` handshake validates signed WSS and HTTPS URL forms against the configured public origin, including Twilio's documented trailing-slash signature variant. This compatibility is limited to that exact GET route; POST callbacks still require their exact URL and signed form body. Twilio error [31920](https://www.twilio.com/docs/api/errors/31920) means the audio WebSocket did not upgrade successfully, even when the incoming-call webhook returned valid TwiML. Test the WSS signature as well as HTTPS when checking a tunnel.

After configuring the number and public origin, explicitly enable live mode and restart API/worker. A test call from an allowlisted number should receive a brief greeting and an invitation to speak. General conversation, explaining the demo and preparing a portal-link text do not require a code. When a lookup or action needs access, the assistant asks for the eight-digit code from the relevant patient or care-team workspace. Enter it on the keypad; do not speak it aloud. Codes expire after ten minutes, are single-use, and bind to the portal identity and optional selected request. Keypad code digits stay out of the model conversation and monitor. Outbound calls also require authorization before protected actions; answering the phone is not identity verification.

## Agent and persistence behavior

The active voice path uses the native GPT-Live protocol at `wss://api.openai.com/v1/live/sessions`, with 8 kHz G.711 μ-law audio and Twilio bidirectional Media Streams. GPT-Live handles conversation; the separate Responses backend receives workflow rules and tools. The application checks authority and performs each tool operation. This follows OpenAI's [Live WebSocket](https://developers.openai.com/api/docs/guides/voice-websockets?api=live) and [Responses delegation](https://developers.openai.com/api/docs/guides/live-delegation?delegation-mode=responses#configure-responses-delegation) model. The older Realtime bridge remains for compatibility tests and is not the active call route.

Administrative tools list appointments/slots, read request progress, prepare a new request, callback change, proposal decision, withdrawal, transfer or SMS, and request professional help. The assistant does not give clinical advice, approve as staff, execute a booking or assert completion without backend evidence.

Mutating tools produce a five-minute pending action bound to the exact proposal/revision. The caller approves separately with keypad **1**, or cancels with **2**. For simulated calls, the patient portal also provides explicit approval/cancellation; live approval requires caller keypad confirmation after readback. Spoken “yes” and model tool calls do not approve. A second preparation cannot replace a valid pending action. Stale, stopped or unauthorized requests fail backend checks. Staff cannot approve on behalf of a patient through the phone endpoint.

Keypad approval unlocks only after the assistant's action readback finishes playing. Early keys and acknowledgements from interrupted audio do not approve an action; after an interruption the assistant can repeat the description. An approval is consumed once and recorded before the workflow command. If a crash or lost response leaves its outcome unknown, inspect the request and audit history before preparing another action; the application does not automatically replay an uncertain approval.

The database stores call status, masked display numbers, operational events, prepared actions, transcripts and tool results. The [call monitor](call-monitor.md) saves native Live captions and backend tool activity for review. No raw audio is recorded by this app. Live audio and relevant synthetic request context are sent to the configured providers; provider retention is controlled by their account settings. Caller and recipient numbers remain private server-side fields for dispatch and are omitted from public call/SMS views. Portal access codes and stream tokens are stored as hashes. Do not use real patient data in this prototype.

Callbacks are durable and claimed once just before dispatch, with fresh requester authority, task state and callback-window checks. Network ambiguity during call creation becomes `reconciling`; the worker never blindly redials. Matching signed provider webhooks can reconcile the existing call. If no webhook arrives, inspect the Twilio console and call ID before taking manual action. Hangup or handover cannot retract a provider request already dispatched. App shutdown or loss of database authority closes active streams; call termination is separate from booking completion.

## Caller-requested SMS

The assistant prepares a text only when the caller asks. The recipient comes from the current call: the signed inbound caller number or the existing outbound destination. Tools accept no arbitrary recipient or freeform message. `portal_link` needs no phone identity; `request_status` and `appointment_summary` require an authorized patient and use backend records, excluding clinical notes. A changed destination, expired preview or changed appointment/request data cancels confirmation.

Preparation saves the full message and a five-minute pending action. The assistant describes its purpose and phone ending, then asks the caller to press **1** to approve or **2** to cancel. The spoken preview omits the URL and STOP footer; the complete text remains visible in the monitor. Every message identifies the demo and includes STOP guidance. Simulated calls save `simulated` and never contact Twilio.

The outbox records `prepared`, `dispatching`, `accepted`, `sent`, `delivered`, `failed`, `unknown` or `cancelled`. `accepted` means provider acceptance; `sent` still does not establish delivery. Signed status callbacks must match the message SID saved from the REST acknowledgement. Early callbacks are retained as bounded evidence without changing the public status or adopting a SID; matching evidence is applied atomically when that acknowledgement arrives, and unrelated SIDs are discarded. Without an acknowledged SID the outcome stays uncertain and is never automatically resent. The worker marks interrupted dispatches `unknown`. Opt-out error `21610` is recorded as a failure. See [Twilio message statuses](https://www.twilio.com/docs/messaging/api/message-resource) and [opt-out error 21610](https://www.twilio.com/docs/api/errors/21610). Sending or delivering a text never changes an appointment.

## Validation and limits

`npm test` exercises provider signatures/TwiML, configuration, portal boundaries, native Live sockets and the retained Realtime compatibility tests. `npm run test:backend` exercises guest sessions, protected agent actions, signed routes, SMS confirmation/delivery states and callback recovery against isolated PostgreSQL schemas. These use synthetic credentials and injected provider transports; no real calls or texts are sent. `npm run check` adds formatting, type checks and production builds.

The current provider session check accepted the configured key with GPT-Live and Responses delegation. This confirms session startup only. A real emergency-contact demo call reported delivered SMS. The complete spoken or corrected keypad verification, interruption quality, end-to-end latency and forwarding still need caller-driven validation. Production identity verification, hospital scheduling integration and production handling of patient information remain separate integrations.

Protocol references: [Twilio Media Streams](https://www.twilio.com/docs/voice/media-streams/websocket-messages), [Twilio signature validation](https://www.twilio.com/docs/usage/security#validating-requests), [GPT-Live session behavior](https://developers.openai.com/api/docs/guides/live-conversations), and [Live prompting](https://developers.openai.com/api/docs/guides/live-prompting).
