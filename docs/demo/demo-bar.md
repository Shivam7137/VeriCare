# Demo control bar

A floating bar for the staff app (`/professional/ed/...`) and the patient app (`/patient/visit`). It lets a judge or presenter work the fictional emergency department without waiting hours: speed time up, add patients, skip ahead, push one visit to its next step, and watch what the wait model says after each change.

It needs the local synthetic demo (`ENABLE_SYNTHETIC_DEMO=true`) and the local API. Like every other Journey route it is not forwarded by the hosted gateway, so on a hosted preview the bar hides itself.

## Guided steps (the default)

The bar opens on three numbered steps, one per app. Choosing a step (or **Next**) opens that app in the same tab, so a judge never leaves the product or opens a separate site. Each step says what to look for there and holds only the controls that belong to it; **Advanced** opens the full bar described below, and **Simple** comes back. The bar remembers the mode and step per browser.

1. **Nursing app** (`/professional/ed`): **Start the ER** starts the department at Slow (×10), so a judge still finds Maya waiting at step 2. After a pause the same button reads **Resume** and carries on at the chosen speed. Pause, Slow / Fast / Faster, +5 walk-ins and Start over. Choosing a speed while paused also resumes, and the bar says so ("Resumed at ×10").
2. **Patient side** (`/patient/visit`, Maya Chen's app): the judge types their own mobile number and becomes Maya's emergency contact, as if Maya had added them in her app. By default she shares everything (status, alerts and wait estimates); unticking **Maya shares her wait times with me** gives steps only, and the Guardian then holds every wait range back and records "Estimate withheld (no consent)" on the audit ledger each time. Typing the number and pressing **Be her emergency contact** is the opt-in, so no YES reply is needed. Their texts appear as a thread in the bar: a welcome, then every update a real contact gets. They can **text back** a question about Maya; it takes the same path as a real inbound text (the Visit Agent, held to Maya's consent) and the answer lands in the thread. **Move Maya to her next step** (shown before and after adding a number) moves her on; **Skip 1 hour** moves everyone else. Maya is triaged on her own and then waits until a judge moves her on, so she is never sent home before anyone meets her. **Re-seat Maya** (shown once she is past the waiting room, or gone) ends her visit if it is still open and admits a fresh Maya to the waiting room; nobody else changes, and her old contacts stop following the ended visit.
3. **Mission control** (`/professional/ed/mission`, "Live feed" in the nav): the feed, the model's predictions and the agent's decisions. Five urgent patients, one critical patient, and Staff on shift; the ML readout shows the typical wait before and after, and when it moves on its own it says why ("23 → 28 min: 3 more waiting").

The contact experience is the text thread only; the demo does not create a family page link.

Numbers are accepted as typed (`902 555 0134`, `1-902-555-0134`, `+44 20 7946 0000`). Ten digits are read as North American. The same number again replaces the earlier entry and starts a fresh thread; at most 25 active contacts per visit. The number lives only in the fictional demo tables, so every reset wipes it, and the bar then forgets it.

Whether a text really leaves the server is decided by the existing journey sender, not the bar: only with `JOURNEY_SMS_ENABLED=true`, a ready Twilio line, and the number on `VOICE_ALLOWED_NUMBERS`. With `*` on the allow-list, anyone who can open the demo can make the server text any number, so keep `*` for supervised judging only. Without a live sender (the hosted demo) the thread says the texts are shown here only. Answers to a question typed in the bar appear in the bar; a reply texted from the judge's real phone is answered by text through the Twilio webhook.

## A 60-second tour (Advanced)

1. Press **Start the ER demo** (first run only). The department opens paused at Slow (×10), with a queue, Maya Chen at the front desk and eight edge-case visits scheduled.
2. Press **×60**. One minute of real time is one hour in the department. Patients are triaged, seen, tested and sent home on their own. Maya is the exception: after triage she waits until someone moves her on.
3. Press **+5** or **Surge**. The **ML model** line under the bar shows the predicted typical wait to be seen before and after (for example 48 → 87 min), and the sparkline steps up.
4. Open **More**, set **Staff on shift** to Many. The typical wait falls. Set **Walk-ins** to Busy and Staff to Few and it climbs.
5. **Reset** (top right of the bar) starts the demo over at any time. **Next step** moves the highlighted patient one step (triage, seen by a provider, tests ordered, results back, then sent home or admitted, bed requested and moved to a ward). On the patient app it moves your own visit and the page updates within two seconds.

## Controls

| Control                       | What it does                                                                                                                                              |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Play / pause, ×1 ×10 ×60 ×300 | The department clock, Slow (×10) after every reset. ×60 is one minute per second. Choosing a speed also plays, and a resume is always announced.          |
| **+1**, **+5**, **Surge**     | Patients arrive, already triaged and waiting. A surge is five urgent arrivals at once.                                                                    |
| **Next step**                 | Moves the focused patient to their next step. Pick a different patient under **More** (staff app only; the patient app always follows your own visit).    |
| **Re-seat Maya** (step 2)     | Ends Maya's visit if it is open and admits a new Maya, triaged and waiting. Nobody else changes; her contacts stop following the old visit.               |
| **+15m**, **+1h**             | Skips ahead and plays everything in between, in a few real seconds; presses add up, to at most 8 hours queued.                                            |
| **Reset**                     | Starts the demo over from the beginning. It asks first (**Reset the demo** / **Keep going**). Speed, walk-ins and staffing go back to their defaults too. |
| **More**                      | Every patient with their own **Next ▸**, walk-ins, staffing, add one patient at a chosen triage level, counts, what just happened.                        |
| Grip                          | Drag it, or focus it and use the arrow keys (Shift for bigger steps), to move the bar. Double-click or Home puts it back. The **×** tucks it into a pill. |

While the bar sits over the lower part of the screen, the page gets the same amount of extra room at the bottom, so anything it covers (the Board's last rows, the patient app's buttons) can always be scrolled into view. On screens shorter than 760 px each step's explanation keeps to two lines. The bar's readout never shows an estimate for a silenced (confidential) visit: it says "estimate withheld (silenced)", like the Board.

## How it works

The API's demo director plays the department forward on its own clock and sends each change through the same HL7 ingest path as the scripted OPOR Twin. The wait model, the Visit Agent, texts and both apps react exactly as they would to a hospital feed. The only simulated part is who walks in and how fast people are seen: one provider start about every seven minutes (ten in the rapid assessment stream, each give or take a quarter), the sickest first, scaled by the staffing lever. Every visit's tests, decision and bed wait come from its visit number, so a restart never changes a story.

- Code: `apps/api/src/journey/demo/` (`flow.ts` rules, `director.ts` clock and actions, `view.ts` what the bar shows, `messages.ts` HL7 for each move, `seed.ts` the opening scene, `contact.ts` the judge's contact and text thread, `routes.ts` API) and `apps/web/components/demo-bar.tsx` with `demo-steps.tsx`, `demo-advanced.tsx`, `demo-panel.tsx` and `demo-placement.ts`.
- Maya is held: the director triages her like anyone else but never picks her from the queue or moves her on by itself. Re-seated visits are numbered `FIN5500001` followed by a count (`FIN55000011`, …); every Maya visit links to the same demo patient by name and birth date, so her app follows the newest one.
- Routes: `GET /journey/demo/state`, `POST /journey/demo/act`. Staff and patient sessions only, demo mode only. A patient session sees its own visit as the focus and other private visits only as "Private visit".
- Eight featured visits (confidential, security alert, left without being seen, and so on) follow their own scripts and cannot be nudged.

## Cautions

- **Reset** clears every fictional emergency visit, as `npm run twin:reset` does. It asks first.
- **The demo starts over by itself** 30 minutes after it was last used, so the next person always finds a fresh scene. Pressing any control except Reset counts as use (even one that is refused); leaving the page open or letting the clock run does not. After a Reset the countdown waits for the next press. A demo nobody has touched is never wiped. In the last five minutes the bar says "Starts over in N min if idle", with a **Keep going** button; pressing it, or any other control, keeps it going. After it happens the bar says so once. Change the time with `DEMO_IDLE_RESET_MINUTES` in `.env` (`0` turns it off; anything that is not a number of minutes falls back to 30), then restart the API.
- Anyone who can open the web app can use the bar, including Reset, because demo pages sign in automatically. Keep the web app on your own machine (or behind the hosted gateway, which does not forward these routes); do not tunnel the Next app itself to the internet while the API runs in demo mode with your own `.env`. The public copy ([hosting](../setup/hosting.md)) is the exception: an isolated container with only fictional data and no provider keys, where the bar is meant to be used.
- Do not run `npm run twin` at the same time. Two clocks would fight over the same department.
- The bar adopts a department that already exists, so a restarted API picks up where it was: paused, with default speed, walk-ins and staffing, and the featured visits' scripts rebuilt. The idle countdown starts again at the next control press.
- Limits: 70 open visits (walk-ins stop and **+5** adds only what fits), and 8 hours of skipping queued at once.
- The accuracy page includes this department's local recalibration (see [stage-time-model.md, section 11.5](../design/stage-time-model.md#115-local-recalibration-experiment-p5)): after a reset it starts again from the model as trained.
- Accuracy still means what [stage-time-model.md](../design/stage-time-model.md) says: the ranges are calibrated on simulated departments, not on a Nova Scotia hospital.
