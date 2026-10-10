# Patient, professional and phone workspaces

The app has separate `/patient` and `/professional` portals, with independent HttpOnly sessions. Patients create requests, track proposals and manage phone calls. Healthcare professionals use the staff account to propose/approve appointments and review handovers; the operator account is read-only. The homepage links to both. These remain synthetic demonstration identities and a mock appointment scheduler.

## Run without credentials

Follow the [quick start](../README.md), including migrations and local session provisioning. `npm run dev` runs the API, web app and durable worker. `npm run voice:check` prints configuration readiness without reading out credentials or contacting a provider. The default `VOICE_MODE=simulated` needs no keys and never dials a number.

1. In the patient portal, create and verify a request. Select it, get a phone access code and start a simulated call.
2. Try a progress check or prepare a callback change. Review the exact action, then explicitly approve or cancel it. Preparing an action does not change the request.
3. For proposal confirmation, have a staff user propose and approve a slot in the professional portal first. The patient can then ask the assistant to prepare confirmation and approve that exact action. Only the backend worker can record a successful booking, using scheduler evidence.
4. Schedule a callback inside the request's agreed callback window. When the worker changes it to ringing, generate a fresh code and use **Answer simulated callback with access code**. This does not use a phone network.
5. For new-request phone intake, select **New request**, generate an unbound code and start a call. Use **Prepare a new request**, review it, and approve. Phone verification supplies the synthetic verified identity; staff still must propose and approve a slot.
6. **Ask for a professional** records a handover and stops call automation. The professional portal shows that call. This is a review queue, not a live call transfer; staff takeover is a separate backend action.

The simulator exposes the real agent tools as buttons. Spoken AI and telephone audio require the live provider configuration below. Ending a call never marks an appointment request complete.

## Configure Twilio and OpenAI later

Keep keys in the server's private runtime environment or the ignored local `.env` file with `chmod 600 .env`. Never put keys in browser variables, source, screenshots or chat. The same configuration must reach both API and worker; restart both after changes. OpenAI uses a project API key with Realtime access, not an assistant/workflow ID.

| Variable                | Purpose                                                                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `TWILIO_ACCOUNT_SID`    | Account owning the voice number (`AC…`).                                                                                           |
| `TWILIO_AUTH_TOKEN`     | Actual account auth token for REST authentication and webhook HMAC verification. A proxy placeholder cannot verify signatures.     |
| `TWILIO_PHONE_NUMBER`   | Voice-capable caller ID in E.164 form, e.g. `+15555550123`.                                                                        |
| `OPENAI_API_KEY`        | OpenAI project API key. `VOICE_OPENAI_API_KEY` is an alternative and takes precedence; use it where `OPENAI_*` names are reserved. |
| `OPENAI_REALTIME_MODEL` | Defaults to `gpt-realtime`; your account must support the chosen model.                                                            |
| `OPENAI_VOICE`          | Defaults to `marin`.                                                                                                               |
| `VOICE_PUBLIC_BASE_URL` | Public HTTPS origin routed to this API, without a path/query, e.g. `https://voice.example.com`.                                    |
| `VOICE_ALLOWED_NUMBERS` | Comma-separated consenting test numbers, in E.164 form, for inbound calls and outbound callbacks.                                  |
| `VOICE_MODE`            | Leave `simulated` until ready; use `twilio` for provider calls.                                                                    |
| `VOICE_LIVE_ENABLED`    | Leave `false` until ready; must explicitly be `true` to activate provider endpoints and dispatch.                                  |

Entering credentials alone does not turn calls on. `npm run voice:check` reports missing/invalid variable names; `liveReady: true` establishes configuration presence only, not provider connectivity. The professional portal displays the same readiness without credentials, full numbers or account identifiers.

Set `VOICE_ALLOWED_NUMBERS=*` explicitly to accept all E.164 caller and callback numbers. An empty setting still blocks live readiness. Signed Twilio webhooks, portal access codes, authenticated callback scheduling and explicit action approval remain required. Readiness reports `allNumbersAllowed: true` for this setting.

Expose only these provider paths through your HTTPS reverse proxy/tunnel to API port 4100. Preserve the exact path/query, form body and `X-Twilio-Signature`; enable WebSocket upgrade for `/voice/stream`. Do not expose the local demo session endpoints. Keep the API on loopback behind the proxy, and keep the demonstration web app private.

| Twilio setting or generated callback         | Method/path                     |
| -------------------------------------------- | ------------------------------- |
| Phone number → Voice → “A call comes in”     | POST `/voice/incoming`          |
| Phone number → Voice → call status changes   | POST `/voice/status`            |
| Verification prompt (generated TwiML)        | POST `/voice/verify`            |
| Outbound TwiML (configured by the worker)    | POST `/voice/outbound/:id`      |
| Outbound status (configured by the worker)   | POST `/voice/status?callId=:id` |
| Bidirectional Media Stream (generated TwiML) | WSS `/voice/stream`             |

Allow outbound HTTPS to `api.twilio.com` and secure WebSockets to `api.openai.com`. The reverse proxy must support a persistent bidirectional connection. On a Twilio trial account, callback destinations may also need verification in Twilio. No public endpoint or paid deployment is provisioned by this change.

After configuring the number and public origin, explicitly enable live mode, restart API/worker, then place a test call from an allowlisted number. Generate an eight-digit access code in the patient portal and enter it at the prompt. Codes expire after ten minutes, are single-use, and bind to the portal identity and optional selected request. Generate the code near the scheduled callback time. An outgoing call still requires this code; answering the phone is not identity verification.

## Agent and persistence behavior

The appointment assistant uses the OpenAI Realtime GA WebSocket protocol with G.711 μ-law audio and Twilio bidirectional Media Streams. Its administrative tools list appointments/slots, read request progress, prepare a new request, callback change, proposal decision or withdrawal, and request professional help. It does not give clinical advice, approve as staff, execute a booking or assert completion without backend evidence.

Mutating tools produce a five-minute pending action bound to the exact proposal/revision. The caller approves separately with keypad **1**, or cancels with **2**; the patient portal also provides explicit approval/cancellation. Spoken “yes” and model tool calls do not approve. A second preparation cannot replace a valid pending action. Stale, stopped or unauthorized requests fail backend checks. Staff cannot approve on behalf of a patient through the phone endpoint.

Keypad approval unlocks only after the assistant's action readback finishes playing. Early keys and acknowledgements from interrupted audio do not approve an action; after an interruption the assistant can repeat the description. An approval is consumed once and recorded before the workflow command. If a crash or lost response leaves its outcome unknown, inspect the request and audit history before preparing another action; the application does not automatically replay an uncertain approval.

The database stores call status, masked display numbers, limited operational events, prepared actions and tool results. Raw audio and verbatim transcripts are not persisted by this app; live audio and relevant synthetic request context are sent to the configured providers. Provider retention is controlled by their account settings. The recipient number is retained while dispatch needs it and is omitted from public API responses. Portal access codes and stream tokens are stored as hashes. Do not use real patient data in this prototype.

Callbacks are durable and claimed once just before dispatch, with fresh requester authority, task state and callback-window checks. Network ambiguity during call creation becomes `reconciling`; the worker never blindly redials. Matching signed provider webhooks can reconcile the existing call. If no webhook arrives, inspect the Twilio console and call ID before taking manual action. Hangup or handover cannot retract a provider request already dispatched. App shutdown or loss of database authority closes active streams; call termination is separate from booking completion.

## Validation and limits

`npm test` exercises provider signatures/TwiML, configuration, portal boundaries and Realtime protocol sockets. `npm run test:backend` exercises the durable store, agent actions, authenticated/signed routes and callback worker against isolated PostgreSQL schemas. These use synthetic credentials and injected provider transports; no real calls are made. `npm run check` adds formatting, type checks and production builds.

Live Twilio/OpenAI connectivity and spoken quality must be tested after actual credentials, a number and public HTTPS routing are supplied. Production identity verification, hospital scheduling integration, live human transfer and production handling of patient information remain separate integrations.

Protocol references: [Twilio Media Streams](https://www.twilio.com/docs/voice/media-streams/websocket-messages), [Twilio signature validation](https://www.twilio.com/docs/usage/security#validating-requests), [OpenAI Realtime WebSockets](https://developers.openai.com/api/docs/guides/realtime-websocket), and [OpenAI Realtime protocol types](https://github.com/openai/openai-node/blob/master/src/resources/realtime/realtime.ts).
