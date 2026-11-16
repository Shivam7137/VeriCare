# careBridge prototype demo

This is a fictional clinic demonstration. Web sessions enter automatically. Appointment changes use a local mock scheduler, and ordinary workflow callbacks/reminders use local simulated delivery. Optional real phone access and forwarding are separate. Real telephone audio and handset transfer have not been validated.

## Open the workspaces

| Workspace           | Local URL                          | Homepage label           |
| ------------------- | ---------------------------------- | ------------------------ |
| Patient             | http://127.0.0.1:3100/patient      | Open patient workspace   |
| Care team           | http://127.0.0.1:3100/professional | Open care-team workspace |
| Department overview | http://127.0.0.1:3100/desktop      | Open overview            |

The directory and transfer simulator are at http://127.0.0.1:3100/professional/team (**Care team & phone**). For a hosted preview, use the same paths on its configured origin.

The [call monitor](call-monitor.md) is at http://127.0.0.1:3100/professional/monitor (**Call monitor**). It follows live transcripts and tool activity, saves records for later review and exports JSON. Start with the explicitly labelled synthetic playback sample to inspect the layout without placing a call.

## Demonstrate an appointment change

1. In the patient workspace, choose **New appointment request**. Select **Appointment to change** and an available **Preferred appointment**. Keep the callback window open now and finish it before the proposed appointment. Add a fictional **Request note**, then **Create request** and **Verify my request**.
2. In the care-team workspace, search for that note and open the request. Choose the exact appointment, then **Propose appointment** and **Approve proposal**. Approval alone does not change the booking.
3. Return to the patient workspace. After the worker records the simulated callback, review the proposed start/end and choose **Confirm appointment**. Confirmation must match the current proposal and occur inside the agreed callback window. An expired window needs a new window and renewed proposal/approval.
4. Wait for **Appointment changed** and the saved scheduler confirmation reference. Reload and inspect the overview to see the persisted outcome. The saved receipt refers to that operation's appointment, even if another request later moves the current booking.

Appointment displays use Halifax time with the year and ADT/AST. Callback inputs show the device's time zone; the backend retains exact instants.

### Let the scheduling agent pick the time

Set `AGENT_AUTO_PROPOSE=true` in `.env` and restart `npm run dev`. When a request is verified (in the patient workspace or by keypad approval on a call), the scheduling agent offers the earliest open slot inside the requested availability. The request arrives in the care-team workspace already at **Staff review**, the offer is labelled as the agent's choice, and the activity history shows **Scheduling agent** for that step. Step 2 above becomes a single **Approve proposal**; staff can still choose **Replace proposal** to pick a different time.

The agent has no session and cannot approve, confirm or book. If no open slot fits, or the callback window has closed, the request waits at **Propose** for staff as before. The agent acts once, at verification: after a rejection, an expiry or a changed callback window, staff propose the next time. The flag is off by default and the demo dataset from `npm run demo:populate` is unaffected.

## Demonstrate forwarding without a phone call

1. Open **Care team & phone**. Fictional members start with no phone destination. **Add phone destination** / **Edit phone destination** and **Save destination** can save or clear a destination; saving never calls it. A number is unnecessary for the simulator.
2. Under **Staff phone access**, choose **Get phone access code**, optionally **Copy code**, then **Start simulated call**. Codes have eight digits, expire after ten minutes and are single-use. Generating a code never places a call.
3. Choose **Patient context (optional)** and **Find patient’s doctor**, or select a teammate explicitly under **Transfer destination**. Ambiguous or unassigned doctors require selection. Choose **Prepare simulated transfer**, review the exact named destination, then **Approve simulated transfer** or **Cancel transfer**.
4. Choose **Simulate connected** or **Simulate no answer**. The saved forwarding history identifies the simulated mode/outcome. Generate a fresh code to start another demonstration; use **End simulated call** only to stop an unfinished simulation. These results are not evidence of a real connection or appointment completion.

For an actual call, use the number displayed under **Your phone access** or **Staff phone access**, generate a fresh code and enter it when prompted. Real forwarding requires a saved destination and explicit caller keypad approval: **1** after readback finishes, **2** to cancel. Spoken agreement and portal buttons do not approve live actions. Configuration readiness does not establish working audio or handset transfer. Do not schedule a real callback as part of the simulated walkthrough.

## Launch locally

Use Node.js 24 and Docker Desktop with the Linux engine running. From the repository root:

```sh
npm ci
npm run setup
npm run db:up
npm run db:migrate
npm run db:seed
npm run demo:populate
npm run demo:credentials
npm run dev
```

`setup` preserves an existing `.env`. Keep private API/provider settings in that ignored file; see [phone setup](phone-setup.md). Do not place secrets in browser variables or committed files. `npm run dev` keeps the loopback API (4100), web (3100) and worker running. Docker/PostgreSQL must remain available. Stop only this project's database with `npm run db:stop`; its volume is preserved.

Sessions expire after 24 hours. `npm run demo:credentials` preserves an existing `.env.sessions.json`, including an expired snapshot. To renew, move the file to a secure ignored location, such as `work/session-backups/`, then rerun the command. Do not print its contents. Remove the old private copy when no longer needed. A hosted server must also receive the fresh `DEMO_SESSIONS_JSON` snapshot and restart/redeploy; renewing the local file alone does not update hosted credentials.

## Optional hosted Next preview

A hosted frontend is not a durable backend deployment. Keep Docker/PostgreSQL, the local API and worker, the gateway and its HTTPS tunnel running. The local web process is needed only when demonstrating locally. Start the gateway in a separate terminal:

```sh
npm run demo:gateway
```

It listens on `127.0.0.1:4199` and forwards to the API on `127.0.0.1:4100`. Point a persistent HTTPS/WebSocket-capable tunnel at 4199. For example, with an installed Cloudflare tunnel client:

```sh
cloudflared tunnel --url http://127.0.0.1:4199
```

The gateway allows signed Twilio provider paths (including transfer results), the exact `/voice/stream` WebSocket upgrade, and a limited `/backend` route set. It preserves provider path/query, form bodies and signature headers. `/backend` requests require a bearer-shaped header, but the API authenticates the actual session and authorizes every action; a matching regex is not authentication. The API validates provider signatures and stream identity. Fixture/provisioning routes and arbitrary proxy paths are excluded. PATCH is limited to a directory member.

Configure these **server-only** variables on the Next hosting project, then build/redeploy that project:

| Variable                | Value                                                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `ENABLE_SYNTHETIC_DEMO` | `true`                                                                                                                     |
| `API_URL`               | The gateway tunnel HTTPS origin followed by `/backend`                                                                     |
| `PUBLIC_DEMO_ORIGIN`    | The exact frontend HTTPS origin, with no trailing slash, path or query                                                     |
| `DEMO_SESSIONS_JSON`    | The private contents of the current ignored `.env.sessions.json`, entered through private hosting settings without logging |

Never use a `NEXT_PUBLIC_` prefix for credentials. Configure the exact public origin rather than relying on arbitrary hosting aliases. The hosting root/build must use this npm workspace repository and the `apps/web` Next app; host-specific deployment is separate from local setup. Existing `.vercelignore` excludes local secrets, data and operational artifacts.

For real voice routing, set private `VOICE_PUBLIC_BASE_URL` to the gateway tunnel origin, update the provider's incoming/status routing to that same origin, and restart the API/worker after configuration changes. See [phone setup](phone-setup.md) for all generated callbacks. When the tunnel changes, update **all three**: voice callback base/provider routing and hosted `API_URL`. Old generated callback URLs and active calls may still reference the previous origin. Keep the new origin stable for the demonstration.

Check the shared frontend and all workspaces after deployment. Inspect an unavailable-session error rather than assuming the demo renewed itself. Backend/provider tests use fake transports; public frontend reachability and configuration readiness do not prove telephone audio or a live transfer.
