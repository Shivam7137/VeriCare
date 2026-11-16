# VeriCare Journey research

Public-web research collected 2026-11-11 for the master design in [../vericare-journey-design.md](../vericare-journey-design.md) and the OPOR interface mapping in [../opor-patient-tracking.md](../opor-patient-tracking.md). No internal NS Health or OPOR Hub material was used. Every report tags claims CONFIRMED / INFERRED / UNCERTAIN with source URLs, and several relied on search summaries rather than full pages, so re-check anything you put on a slide.

| File                                                                 | Covers                                                            | Read it for                                                     |
| -------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------- |
| [00-initial-findings.md](00-initial-findings.md)                     | OPOR program, C3, YourHealthNS, first FHIR pass, policy precedent | Background facts and dates                                      |
| [01-oracle-health-interfaces.md](01-oracle-health-interfaces.md)     | HL7 v2 ADT, FirstNet, Millennium FHIR, auth, tooling              | 5 annotated sample HL7 messages; why HL7 v2 is the event source |
| [02-ed-operations-and-data.md](02-ed-operations-and-data.md)         | CTAS, ED journey, NS/CIHI numbers, turnaround times, datasets     | Simulator parameter table                                       |
| [03-wait-estimates.md](03-wait-estimates.md)                         | Prediction methods, calibration, risk communication, precedent    | MVP estimate algorithm and TypeScript sketch                    |
| [04-privacy-legal-compliance.md](04-privacy-legal-compliance.md)     | PHIA, PIIDPA residency, CASL, SMS numbers, AI disclosure          | 25 MUST / 9 SHOULD requirements                                 |
| [05-security-threat-model.md](05-security-threat-model.md)           | Voice-agent attacks, OTP, SIM swap, spoofing, audit               | 26-row threat table, 40 adversarial tests                       |
| [06-patient-family-ux.md](06-patient-family-ux.md)                   | Information needs, NS population, competitors, notifications      | Timeline UI, 16 SMS templates, voice lines                      |
| [07-challenge-and-stakeholders.md](07-challenge-and-stakeholders.md) | Challenge rules, Innovation Hub, YourHealthNS, costs              | Pitch framing, cost per visit                                   |
| [08-codebase-and-stack.md](08-codebase-and-stack.md)                 | careBridge audit, OpenAI realtime, Twilio, libraries              | 15-step file-by-file build plan                                 |

## Findings that changed the design

1. **FHIR can't discover ED events.** Verified against Oracle's open sandbox: `Encounter?_lastUpdated=…` is rejected ("at least one of _id, identifier, account, … patient, or subject must be provided"). No Subscription, Flag or `$export` on the open endpoint. HL7 v2 ADT is the event source; FHIR is enrichment by patient or encounter id. (01)
2. **CTAS has no standard home.** `Encounter.priority` in Millennium is admission type (Code Set 3), not CTAS, and no standard v2 field carries CTAS. It's site-specific: treat it as a per-site mapper setting. VIP appears as `hospitalization.specialCourtesy`. Restricted patients are filtered silently. (01)
3. **Use an 80% range, lead with the upper bound.** A 25th–75th percentile range misses half of patients by design. Calibrate against each patient's actual remaining wait: ERstat's intervals covered about 22% of real visits. (03)
4. **Estimates don't raise satisfaction.** Two RCTs found no effect, and no controlled trial shows texting reduces LWBS. Pitch staff time, family calls and the LEAVING-to-nurse loop; frame estimates as respect and orientation, measured in the pilot. A Dalhousie review found no evidence that publishing waits reduces crowding. (03, 07)
5. **Estimates need express consent.** PHIA s.37 covers presence, location and general condition "in general terms". A personal step and range is likely beyond that, so `estimates` is a separate consent scope. Every Alex disclosure is legally NS Health's as its agent (s.28). (04)
6. **Residency is the pilot blocker.** PIIDPA s.5 requires storage and access in Canada, including by service providers (replaced 2027-04-01). OpenAI Realtime processes in the US/EU only; Twilio has no Canadian region; the model hears whatever the caller says. (04, 05, 08)
7. **Caller ID is worthless in Canada.** Twilio verifies STIR/SHAKEN only for the US and France. SIM-swap lookups for Canada are private beta. (05)
8. **OTP fixes.** Count failures per patient + contact, not per call; resends must not reset the counter; hard-block the `12345678` demo code outside synthetic mode. (05)
9. **careBridge gaps.** No inbound SMS (LEAVING/STOP need a signed route). The voice agent runs any registered tool, so gating must move server-side. `voice_events` drops unknown detail keys. New migrations also go in `migrations.ts` and its test. (08)
10. **Simulator calibration.** NS reports cover only 8.4% of visits with PIA times in CIHI, so use Ontario CIHI figures (PIA mean 118 min, p90 257 min) and the open NHAMCS dataset. Model the Halifax Infirmary Rapid Assessment Zone (up to 30% of patients) and waiting-room bloodwork. (02)

## Conflicts and corrections

- **Deadline.** The challenge page lists MVP semi-finals on **Nov 18**; the project document says MVP and video are due **Nov 15**. Check the team briefing. (07)
- **LWBS 10.02%.** Confirmed from the 2023-24 DHW report text (519,310 visits) in 02. Report 06 couldn't verify it; 07 quotes 522,956 visits. Use 519,310 / 10.02% with the DHW report as source.
- **AI scribe guidance.** Report 04 says no NS guidance was found; 00 found the DHW AI scribe guide at https://novascotia.ca/dhw/publications/ai-scribe-for-health.pdf. It exists.

## Still unknown

- Which feed NS Health would expose (integration engine, C3, or a FirstNet extract) and whether CTAS and tracking-board locations are in it. NS Health's integration engine vendor wasn't found.
- How OPOR marks confidential / "no information" patients and security alerts.
- Challenge judging criteria, video rules and IP terms (not public).
- CRTC automated-dialing rules for outbound calls (CRTC pages blocked the agent).
- Per-site Halifax Infirmary numbers (only in chart images in the DHW report).
- Bill S-5 current stage.
