# Documentation

Every document, by what you need it for. Start with [the system design](design/vericare-journey-design.md) for what VeriCare Journey is, and [the demo guide](demo/prototype-demo.md) to run it.

## Run it

| Document                                                           | What it covers                                     |
| ------------------------------------------------------------------ | -------------------------------------------------- |
| [Local development](setup/setup.md)                                | Install, database, environment and the dev servers |
| [Patient, professional and phone workspaces](setup/phone-setup.md) | Phone line, Twilio routing and the voice agent     |

## Demo it

| Document                                                       | What it covers                                   |
| -------------------------------------------------------------- | ------------------------------------------------ |
| [Prototype demo](demo/prototype-demo.md)                       | Walkthroughs for every workspace                 |
| [Demo control bar](demo/demo-bar.md)                           | Speeding up the ER, adding patients, resetting   |
| [Fictional clinic dataset](demo/demo-data.md)                  | The populated clinic and how to refresh it       |
| [Emergency contact phone demo](demo/emergency-contact-demo.md) | Finding a patient by phone with SMS verification |

## How it works

| Document                                                             | What it covers                                      |
| -------------------------------------------------------------------- | --------------------------------------------------- |
| [VeriCare Journey: system design](design/vericare-journey-design.md) | The master design: agents, models, feed, privacy    |
| [Per-patient ED tracking on OPOR](design/opor-patient-tracking.md)   | The HL7 v2 and FHIR interface mapping               |
| [The Visit Agent](design/visit-agent.md)                             | The agent, its tools and its knowledge base         |
| [Stage-time models](design/stage-time-model.md)                      | How the wait models were built and how well they do |
| [Call monitor](design/call-monitor.md)                               | Live transcripts and tool activity                  |
| [Synthetic backend architecture](design/architecture.md)             | Component boundaries and workflow invariants        |
| [Backend contracts](design/contracts.md)                             | API, authority and agent tool contracts             |
| [Decisions](design/decisions.md)                                     | Choices made, and the ones still open               |

## Reports and research

| Document                                                                         | What it covers                        |
| -------------------------------------------------------------------------------- | ------------------------------------- |
| [Security, scalability and performance](reports/security-scalability-summary.md) | Summary for judges                    |
| [Alex: conversational voice design](reports/voice-research.md)                   | Voice agent research                  |
| [VeriCare Journey research](research/README.md)                                  | Nine research notes behind the design |

## Other folders

- [agent/](agent/plan.md): the `/plan`, `/exec` and `/review` instructions that [AGENTS.md](../AGENTS.md) points to.
- [screenshots/](screenshots/): images used by these documents.
