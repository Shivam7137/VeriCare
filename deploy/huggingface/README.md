---
title: VeriCare
emoji: 🏥
colorFrom: blue
colorTo: green
sdk: docker
app_port: 7860
pinned: false
short_description: An agent for every hospital patient (fictional demo)
---

# VeriCare: live demo

VeriCare gives each patient in hospital their own agent. It tells them and the family they choose where they are, what comes next and roughly how long it will take. The demo is set in an emergency department. Every patient, phone number and record in it is fictional.

Open the app on its own page (the link above the preview, ending in `.hf.space`) so its sign-in cookie works.

| Page                    | What you see                                                    |
| ----------------------- | --------------------------------------------------------------- |
| `/professional/ed`      | The staff Desk: tasks, the board, forecasts, accuracy and audit |
| `/patient/visit`        | Maya's phone app: her step, her wait range, check-ins, family   |
| `/professional/monitor` | Simulated phone calls: transcript, tool calls and texts         |
| `/pitch`                | The presentation                                                |

Use the floating demo bar: **Start the ER demo**, then **×60**, **+5** or **Surge**, and **Next step**. The demo starts over by itself 30 minutes after it was last used, and from the opening scene whenever the Space restarts or wakes from sleep (the first visit after a quiet spell takes a minute or two).

This hosted copy runs everything in one container: PostgreSQL, the API, the worker and the web app. Texts and calls are simulated and shown on screen, and the Visit Agent uses its rules planner, which sends the same approved messages a language model would choose from.

Source code and full documentation: https://github.com/Shivam7137/VeriCare
