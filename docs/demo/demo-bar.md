# Demo control bar

A floating bar for the staff app (`/professional/ed/...`) and the patient app (`/patient/visit`). It lets a judge or presenter work the fictional emergency department without waiting hours: speed time up, add patients, skip ahead, push one visit to its next step, and watch what the wait model says after each change.

It needs the local synthetic demo (`ENABLE_SYNTHETIC_DEMO=true`) and the local API. Like every other Journey route it is not forwarded by the hosted gateway, so on a hosted preview the bar hides itself.

## A 60-second tour

1. Press **Start the ER demo** (first run only). The department opens paused, with a queue, Maya Chen at the front desk and eight edge-case visits scheduled.
2. Press **×60**. One minute of real time is one hour in the department. Patients are triaged, seen, tested and sent home on their own.
3. Press **+5** or **Surge**. The **ML model** line under the bar shows the predicted typical wait to be seen before and after (for example 48 → 87 min), and the sparkline steps up.
4. Open **More**, set **Staff on shift** to Many. The typical wait falls. Set **Walk-ins** to Busy and Staff to Few and it climbs.
5. **Reset** (top right of the bar) starts the demo over at any time. **Next step** moves the highlighted patient one step (triage, seen by a provider, tests ordered, results back, then sent home or admitted, bed requested and moved to a ward). On the patient app it moves your own visit and the page updates within two seconds.

## Controls

| Control                       | What it does                                                                                                                                              |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Play / pause, ×1 ×10 ×60 ×300 | The department clock. ×60 is one minute per second. Choosing a speed also plays.                                                                          |
| **+1**, **+5**, **Surge**     | Patients arrive, already triaged and waiting. A surge is five urgent arrivals at once.                                                                    |
| **Next step**                 | Moves the focused patient to their next step. Pick a different patient under **More** (staff app only; the patient app always follows your own visit).    |
| **+15m**, **+1h**             | Skips ahead and plays everything in between, in a few real seconds; presses add up, to at most 8 hours queued.                                            |
| **Reset**                     | Starts the demo over from the beginning. It asks first (**Reset the demo** / **Keep going**). Speed, walk-ins and staffing go back to their defaults too. |
| **More**                      | Every patient with their own **Next ▸**, walk-ins, staffing, add one patient at a chosen triage level, counts, what just happened.                        |
| Grip                          | Drag it, or focus it and use the arrow keys (Shift for bigger steps), to move the bar. Double-click or Home puts it back. The **×** tucks it into a pill. |

## How it works

The API's demo director plays the department forward on its own clock and sends each change through the same HL7 ingest path as the scripted OPOR Twin. The wait model, the Visit Agent, texts and both apps react exactly as they would to a hospital feed. The only simulated part is who walks in and how fast people are seen: one provider start about every seven minutes (ten in the rapid assessment stream, each give or take a quarter), the sickest first, scaled by the staffing lever. Every visit's tests, decision and bed wait come from its visit number, so a restart never changes a story.

- Code: `apps/api/src/journey/demo/` (`flow.ts` rules, `director.ts` clock and actions, `view.ts` what the bar shows, `messages.ts` HL7 for each move, `seed.ts` the opening scene, `routes.ts` API) and `apps/web/components/demo-bar.tsx` with `demo-panel.tsx` and `demo-placement.ts`.
- Routes: `GET /journey/demo/state`, `POST /journey/demo/act`. Staff and patient sessions only, demo mode only. A patient session sees its own visit as the focus and other private visits only as "Private visit".
- Eight featured visits (confidential, security alert, left without being seen, and so on) follow their own scripts and cannot be nudged.

## Cautions

- **Reset** clears every fictional emergency visit, as `npm run twin:reset` does. It asks first.
- **The demo starts over by itself** 30 minutes after it was last used, so the next person always finds a fresh scene. Pressing any control except Reset counts as use (even one that is refused); leaving the page open or letting the clock run does not. After a Reset the countdown waits for the next press. A demo nobody has touched is never wiped. In the last five minutes the bar says "Starts over in N min if idle", with a **Keep going** button; pressing it, or any other control, keeps it going. After it happens the bar says so once. Change the time with `DEMO_IDLE_RESET_MINUTES` in `.env` (`0` turns it off; anything that is not a number of minutes falls back to 30), then restart the API.
- Anyone who can open the web app can use the bar, including Reset, because demo pages sign in automatically. Keep the web app on your own machine (or behind the hosted gateway, which does not forward these routes); do not tunnel the Next app itself to the internet while the API runs in demo mode.
- Do not run `npm run twin` at the same time. Two clocks would fight over the same department.
- The bar adopts a department that already exists, so a restarted API picks up where it was: paused, with default speed, walk-ins and staffing, and the featured visits' scripts rebuilt. The idle countdown starts again at the next control press.
- Limits: 70 open visits (walk-ins stop and **+5** adds only what fits), and 8 hours of skipping queued at once.
- Accuracy still means what [stage-time-model.md](../design/stage-time-model.md) says: the ranges are calibrated on simulated departments, not on a Nova Scotia hospital.
