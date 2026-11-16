# 04. Legal, privacy and compliance for VeriCare Journey

Research date 2026-11-11. Public sources only; nothing logged into. Not legal advice. Tags: **CONFIRMED** = I read it in the cited source; **INFERRED** = my reading/application; **UNCERTAIN** = secondary source only, blocked, or conflicting.

PHIA text is the consolidation printed "April 1, 2026"; PIIDPA is the consolidation dated "October 19, 2026". I extracted both from the official PDFs and read them directly.

---

## 1. Headline findings

1. **s.37 PHIA is narrower than our estimate feature.** A custodian may, at its discretion, tell family (or a person it reasonably believes has a close personal relationship) only information "in general terms" about the **presence, location and general condition on the day of disclosure**, and only if not contrary to the patient's express request. A per-patient "step 2 of 5, seen in about 1 to 3 hours" is plausibly beyond "general terms". It then needs the patient's **express consent** (s.43(a): express consent is required for disclosure to a non-custodian unless authorized by law). Our `consent_records` scopes (status, alerts, estimates) are the right shape; s.37 alone cannot carry them. Section text CONFIRMED; the "beyond general terms" conclusion is INFERRED.
2. **Who is the custodian matters most.** NS Health is the PHIA custodian. VeriCare would be its **agent** (definition s.3(aaa), s.28) acting only for the custodian's purposes. Every disclosure Alex makes is legally NS Health's disclosure. A hackathon demo can't be that; a pilot needs an agent agreement, PIA and sign-off. Statute CONFIRMED; application INFERRED.
3. **PIIDPA, not PHIA, is the data-residency rule.** PHIA only restricts _disclosure_ outside the Province (s.44) and has no stored-in-Canada clause (I searched the whole Act). The "stored only in Canada and accessed only in Canada" rule for NS public bodies and their **service providers and subcontractors** is the Personal Information International Disclosure Protection Act s.5. It is still in force and is being replaced by the new FOIPOP Act effective 2027-04-01. CONFIRMED. That NS Health is a "public body" under it: INFERRED.
4. **Our vendor stack is the weak spot.** OpenAI offers Canadian _at-rest storage_ but **no Canadian processing**, and its Realtime API regional processing is US/Europe only. Twilio has **no Canadian Region** (US1, IE1, AU1). A pilot with real NS Health data needs a PIIDPA s.5(2) decision by the head of the public body, patient consent, or a Canadian-processing stack. CONFIRMED.
5. **"The model never sees PHI" is false on the voice path.** The caller's spoken name, birthday and relationship go through the realtime model even if our tools return only approved sentences. Say so honestly in the deck.
6. **Outbound calling is where CRTC rules bite; status SMS is mostly outside CASL.** A status text to a consenting patient is not a commercial electronic message (INFERRED). Carrier rules (toll-free verification or short code, STOP) apply regardless. CRTC pages were bot-blocked for me, so ADAD details are UNCERTAIN.
7. **Recording:** Canada is one-party consent for participants, but PHI adds retention and secondary-use duties. Don't store raw audio by default.

---

## 2. Nova Scotia PHIA (S.N.S. 2010, c. 41)

Source for section text: https://www.nslegislature.ca/sites/default/files/legc/statutes/personal%20health%20information.pdf. All CONFIRMED unless tagged.

### 2.1 Consent (ss.11-20)

| Section | What it says                                                                                                                                                                                                                                                                                                                                                                       | VeriCare consequence                                                                                |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 11      | No collection/use/disclosure without consent (reasonably necessary, lawful purpose) or unless the Act permits                                                                                                                                                                                                                                                                      | Record a legal basis for every disclosure                                                           |
| 12      | Unless the Act requires express consent, **knowledgeable implied consent** may be accepted                                                                                                                                                                                                                                                                                         | OK inside the care team; not enough for family disclosure beyond s.37                               |
| 13      | Consent must be the individual's, knowledgeable, relate to the specific information, and be voluntary                                                                                                                                                                                                                                                                              | Scope-specific consent (status vs estimate vs alerts), not a blanket tick                           |
| 14-15   | Knowledgeable = reasonable to believe the person knows the purpose and that they may give or withhold consent; met by a readily available notice or an explanation. **s.15(2)-(3): not met if the custodian should know the person has limited ability to read/understand the language or a disability impairing understanding; custodian must make reasonable efforts to assist** | Notice must be plain-language, EN/FR, accessible. Distressed ED patients may not be able to consent |
| 16      | Express consent may be written **or oral**                                                                                                                                                                                                                                                                                                                                         | Oral consent captured by staff or Alex is legally possible; record it                               |
| 17      | Consent may be limited or revoked at any time by notice; no retroactive effect; custodian must take reasonable steps to comply and explain consequences                                                                                                                                                                                                                            | STOP / "stop telling my family" must propagate immediately and be logged                            |
| 18-20   | Any capable individual, regardless of age, may consent; capacity can vary by time and by item (s.19); capacity includes disclosure to parent/guardian/SDM (s.20)                                                                                                                                                                                                                   | ED capacity fluctuates; re-confirm consent given while distressed                                   |

### 2.2 Substitute decision-makers (ss.21-22)

- s.21(1): an SDM may give or refuse consent if the individual lacks capacity. Order (s.21(2)): person authorized by law; court-appointed guardian; spouse; adult child; parent; person in loco parentis; adult sibling; grandparent; adult grandchild; adult aunt/uncle; adult niece/nephew; other adult next of kin; Public Trustee.
- s.21(5): persons in (b) to (g) must have been in personal contact in the preceding **12 months**, be willing, know of no higher-ranked able person, and **certify in writing**. s.22: follow the patient's prior express wishes, else their likely wishes.
- Implication (INFERRED): VeriCare must not decide who is an SDM. For MVP, "family" means a person the _capable patient_ named. Any "I'm the SDM" claim becomes a staff handoff. s.106(e) makes knowingly false claims of consent authority an offence.

### 2.3 Disclosure to family and close persons

- **s.37** (essence): custodian "has the discretion to disclose" to family or a person reasonably believed to have a close personal relationship, "if the information is given in general terms and concerns the presence, location, and general condition of the individual on the day on which the information is disclosed and the disclosure is not contrary to the express request of the individual."
- NS government toolkit ch.5 (https://novascotia.ca/DHW/PHIA/documents/chapters/5-Collection-Use-and-Disclosure.pdf, p.15): examples where a mother phones with the patient's name and is told location and general condition, unless the patient said not to tell family; disclosure is permitted, **not required**; if the caller says they aren't family, the custodian may inquire about a "close personal relationship".
- **s.42**: disclosure without consent **must be documented**: description or copy of what was disclosed, recipient, date, and the authority. Our `disclosures` table must carry those four fields.
- **s.43(a)**: express consent required for disclosure to a non-custodian unless required/authorized by law. (s.43 also lists fundraising, marketing, media, research.)
- **s.38(1)(d)**: disclosure to any person where there are reasonable grounds that it averts or minimizes a significant danger to anyone's health or safety. Not a basis for routine estimates.
- **s.45(2)** (per toolkit): a non-custodian may use received PHI only for the purpose of the disclosure.
- **NS Health's own statement** (https://www.nshealth.ca/node/1073): NS Health may "give family or friends confirmation that you are in hospital, your room and telephone extension, and general condition" on the day asked; patients can withhold or withdraw this and are told to let staff know they want it kept private. The page also covers SMS-service subscriptions and privacy contacts (privacy@nshealth.ca). CONFIRMED via page fetch. I did **not** find the phrase "no information" on an NS Health page; that term is UNCERTAIN, but the opt-out is confirmed.
- Reading (INFERRED): "general condition" is a coarse category. "Waiting to be seen" and "being assessed" fit presence/location/condition. A numeric time window and anything CTAS-derived should live in the express-consent scope.

### 2.4 Agents (s.3(aaa), ss.28-29)

- Agent: a person who, **with the custodian's authorization**, acts for or on behalf of the custodian in respect of PHI **for the custodian's purposes and not the agent's own** (includes employees, volunteers, insurers; "includes but is not limited to").
- s.28(1): custodian stays responsible; may permit agents to collect/use/disclose/retain/destroy only if the custodian could itself, within the agent's duties and the custodian's limits, and prescribed requirements are met. **s.28(3): agent must notify the custodian at the first reasonable opportunity if PHI is stolen, lost or accessed by unauthorized persons.** s.29(2): custodian-agent transfer is a "use", not a disclosure.
- Implication (INFERRED): VeriCare, Twilio and OpenAI sit in the agent chain; sub-agents need custodian permission. Agent agreement must cover purposes, no secondary use or model training, breach notice, retention/destruction, audit, residency.

### 2.5 Safeguards, audit logs and the regulation

- s.61 confidentiality; s.62(1) information practices that are reasonable and protect against theft, loss, unauthorized access, use, disclosure, copying, modification; s.62(2) complaints policy; s.67 contact person; s.68 public statement of practices.
- **s.63 record of user activity (RUA)** for any electronic information system holding PHI: available to the individual on request within **30 days, free (s.63(4))**; custodian may audit RUAs to detect breaches (s.63(5)).
- s.65 + **N.S. Reg. 217/2012** (https://novascotia.ca/just/regulations/regs/phipershealth.htm, text read):
  - s.10(1): safeguards for network infrastructure, hardware/OS (only authorized users), and software including **how it authenticates a user's identity**; s.10(2) written policies; **s.10(3)-(4): record every security breach likely to pose risk to PHI, with corrective actions**.
  - **s.11(2) RUA minimum fields:** name of the individual whose PHI was accessed; unique ID (health card or custodian number); name of the accessor; additional accessor ID (system user id); description of PHI accessed (or all that could have been); date/time (or date range). **s.11(3): keep the underlying data for at least 1 year after each access.**
  - Toolkit ch.8 distinguishes an audit log from an RUA; an RUA can be generated from audit-log fields (https://novascotia.ca/DHW/PHIA/documents/PHIA-complete-toolkit.pdf; fact sheet https://www.gov.ns.ca/dhw/phia/documents/Fact-Sheet-Record-of-User-Activity.pdf).
  - Regulation was amended by N.S. Reg. 63/2026 (effective 2026-03-03, per search summary); I did not read what changed (UNCERTAIN).
- Implication: VeriCare is an "electronic information system" (a computer system that processes PHI, per the regulation as quoted in toolkit ch.8). `audit_events` must answer "who accessed this patient's information, when, what" with the fields above for >= 1 year.

### 2.6 Breaches and offences

- s.69: notify the individual at the first reasonable opportunity if PHI is stolen, lost or subject to unauthorized access/use/disclosure/copying/modification **and** there is potential for harm or embarrassment. s.70: custodian may decide not to notify (unlikely a breach, or no potential for harm) but **must then notify the Review Officer (OIPC) as soon as possible**. OIPC form and process (one form per breach; email oipcns@novascotia.ca): https://oipc.novascotia.ca/sites/default/files/2025%2011%2006%20S.%2070%20PHIA%20Guidelines.pdf.
- A voice-agent disclosure to the wrong person is a s.69 breach.
- s.106 offences include wilful unauthorized disclosure, **falsely representing entitlement to obtain another's PHI (106(c))**, failing to protect PHI securely (106(d)), false SDM assertions (106(e)). s.107: up to **$10,000 or 6 months** (individual), up to **$50,000** (corporation). s.108: officers/agents who authorized or could have prevented it are also liable.

### 2.7 Retention (ss.47-51)

- s.49(2): when the retention period expires, PHI no longer needed for the schedule's purposes must be securely destroyed, erased or **de-identified**. s.50: custodian must have a **written retention schedule** (purposes, periods, destruction). PHIA sets no fixed number of years; the custodian does. Only the RUA has a floor (1 year, Reg s.11(3)).

### 2.8 Outside-Province disclosure (s.44)

- s.44(1): PHI collected in NS may go to a person outside the Province only with consent, if permitted by the Act/regs, for prescription monitoring, for planning with another province's government, or where reasonably necessary for health care and the individual hasn't expressly instructed otherwise. It's about disclosure, not hosting.

### 2.9 OIPC guidance, PIAs, decisions

- OIPC NS publishes PHIA custodian tools: rules summary/checklist, breach steps, Privacy Management Program toolkit, a **"Privacy Impact Assessment - Personal Health Information Act" template**, Reasonable Security Checklist (listed in https://oipc.novascotia.ca/sites/default/files/publications/PHIA%20Essentials%20Toolkit%202019%2012%2019.pdf; hub https://oipc.novascotia.ca/PHIA_Custodians). Listing CONFIRMED; I did not open the template.
- **PHIA contains no statutory PIA requirement** (zero hits for "impact assessment" in the Act). PIAs are a Privacy Management Program practice. NS Health will likely require one internally (INFERRED).
- Decisions found: IR18-01 (Aug 2018, Dept of Health and Wellness: pharmacist accessed 46 people's records; weak auditing of DIS access) https://oipc.novascotia.ca/sites/default/files/reports/IR18-01%20DHW%20%2801%20Aug%202018%29_0.pdf ; Review Report 20-02 (Feb 2020, NSHA phishing breach, 2,841 notified) https://oipc.novascotia.ca/sites/default/files/reports/20-02%20Review%20Report%202020%2002%2026.pdf ; OIPC "Tips for Addressing Employee Snooping" (Feb 2023). News reports describe 335 records snooped by six NSHA staff in 2018 (UNCERTAIN on figures). **I found no OIPC decision specifically on disclosure to family by phone.**
- Federal overlay: PIPEDA Part 1 does not apply to NS PHIA custodians for in-province PHI under the Personal Health Information Custodians in Nova Scotia Exemption Order SOR/2016-62 (https://laws-lois.justice.gc.ca/eng/regulations/SOR-2016-62/FullText.html; existence confirmed by search, scope not read; UNCERTAIN whether it reaches a commercial vendor). Bill S-5 (Connected Care for Canadians Act): sources conflict on stage (Senate passed 2026-05-26 vs committee), not law (https://www.parl.ca/LegisInfo/en/bill/45-1/s-5). Bill C-36 (privacy reform) exists; stage not found.

---

## 3. PIIDPA and the new FOIPOP Act

- **PIIDPA s.5(1)** (CONFIRMED, https://nslegislature.ca/sites/default/files/legc/statutes/personal%20information%20international%20disclosure%20protection.pdf): a public body, and a **service provider or associate of a service provider**, shall ensure personal information in its custody or control is **stored only in Canada and accessed only in Canada** unless (a) the individual identified the information and consented in the prescribed manner, (b) it's for a disclosure allowed under the Act, or (c) the head of the public body allowed it under s.5(2) as necessary for the public body's operation. s.5(3): such decisions reported to the Minister within 90 days of year-end. s.5(4): service provider collects and uses only what's necessary and keeps reasonable security.
- s.6: any foreign demand for disclosure (subpoena, order from a foreign authority) must be reported **immediately to the Minister**. s.13: offences for service providers.
- "Service provider" (s.2(1)(g)) = retained by contract for a public body and uses/discloses/manages/stores/accesses its personal information; "associate" includes subcontractors and their staff. So OpenAI and Twilio would be associates of VeriCare. INFERRED.
- **Replacement:** NS says PIIDPA "will be repealed" and the new FOIPOP Act takes effect **2027-04-01**, with breach notification at "significant risk of harm" (https://news.novascotia.ca/en/2025/09/26/province-introduces-modernized-access-privacy-legislation). A secondary source says the cross-border limit moves into the new Act (UNCERTAIN; bill text not read). Assume the same residency expectation continues.

---

## 4. SMS and calls

### 4.1 CASL

- s.1(2): a CEM is a message that, from its content, links or contact info, could reasonably be concluded to have a purpose of encouraging participation in a commercial activity. s.6(1): CEMs need consent, sender ID and an unsubscribe mechanism. s.6(6) exempts from consent messages that solely give a quote, confirm a transaction, give warranty/recall/safety info, give factual info on an ongoing account, relate to employment, or deliver an entitled service. s.6(8): live voice calls, faxes and voice recordings to a phone account are excluded from CASL (https://laws-lois.justice.gc.ca/eng/acts/E-1.6/page-1.html, CONFIRMED).
- Application (INFERRED): a publicly funded ED status text has no commercial purpose, so it isn't a CEM and CASL consent/unsubscribe isn't triggered. **No promotional content** (app downloads, careBridge marketing) in these messages; it could turn them into CEMs and would breach PHIA s.106(k) without express consent. Honor STOP regardless.

### 4.2 CRTC Unsolicited Telecommunications Rules and ADAD

- crtc.gc.ca returned a bot-check wall; I did not bypass it. From the National DNCL operator FAQ (https://www.lnnte-dncl.gc.ca/en/Organization/Frequently-Asked-Questions, CONFIRMED): product recall, **appointment reminder**, bill collection, public service and market research calls are not telemarketing and needn't follow DNCL rules "but may need to follow the ADAD Rules"; ADAD rules also contain provisions for non-telemarketing calls.
- Secondary (UNCERTAIN): non-solicitation ADAD calls must still meet requirements on calling hours, caller ID, dialing patterns and disconnection (CRTC Notice 2013-140, https://crtc.gc.ca/eng/archive/2013/2013-140.htm). Hours conflict between sources (9:00-21:30 vs 9:30-20:00). **CRTC Notice 2026-132 is a live consultation on the ADAD rules**, so rules may change.
- Design reading (INFERRED): prefer SMS for proactive alerts; use outbound voice only for **patient-requested callbacks**. Inbound family calls are outside these outbound rules.
- **STIR/SHAKEN:** CRTC Decision 2021-123 requires all telecom providers to authenticate/verify caller ID on IP calls (https://crtc.gc.ca/eng/archive/2021/2021-123.htm, per search summary). It's carrier-level: use a Twilio number we own, never spoof an NS Health number. Twilio's Canadian attestation level: not found (UNCERTAIN).

### 4.3 Twilio Canada messaging

- https://www.twilio.com/en-us/guidelines/ca/sms (CONFIRMED): Canadian carriers filter A2P strictly; Twilio recommends **short codes or verified toll-free numbers**; **alphanumeric sender IDs unsupported**; support HELP/STOP in the recipient's local language; send non-urgent messages in daytime.
- https://www.twilio.com/en-us/guidelines/ca/short-code (CONFIRMED): **12-16 weeks** to provision, plus a CWTA short-code application; annual provisioning freeze mid-October to early January; **express consent required**; STOP/HELP responses must match CWTA-approved text (change takes ~2-3 weeks); 100 msg/s default; Canada needs its own code.
- Toll-free needs verification; default throughput about 3 msg/s (Twilio support article https://support.twilio.com/hc/en-us/articles/360038172934, per search summary; UNCERTAIN). Unregistered long codes risk filtering.
- For the MVP: a verified toll-free number is the only realistic path (a short code can't be ready by 2026-11-15, and the freeze is active). Demo on synthetic numbers.

---

## 5. AI-specific

- **AIDA is dead:** it was part of Bill C-27 and died on prorogation in January 2025. The June 2026 "AI for All" strategy signals targeted rather than comprehensive legislation (https://www.bakermckenzie.com/en/insight/publications/2026/06/canada-federal-government-releases-refreshed-national-ai-strategy; UNCERTAIN detail). No binding federal rule requiring AI disclosure on calls found.
- **Voluntary Code of Conduct (Sept 2023)**, page last modified 2026-06-04, 46 signatories. Six principles: accountability, safety, fairness/equity, **transparency (including "clearly identifying AI systems that could be mistaken for humans")**, human oversight and monitoring, validity/robustness. Voluntary only (https://ised-isde.canada.ca/site/ised/en/voluntary-code-conduct-responsible-development-and-management-advanced-generative-ai-systems). CONFIRMED.
- **AI scribe guidance (Jan 2026):** Ontario IPC and BC OIPC issued non-binding guidance on 2026-01-28; Alberta expects a PIA under its HIA; NL also issued guidance (all from secondary sources: Mondaq, Aird Berlis, McCarthy; the IPC page itself returned 403). **I found no NS OIPC AI scribe or AI-agent guidance** (UNCERTAIN). What transfers (INFERRED): PIA first; vendor contract barring secondary use/training and fixing residency and deletion; patient notice and a non-AI alternative; human review and handoff; accuracy testing; minimal transcript retention; incident reporting.
- **Recording and transcripts:** Criminal Code Part VI forbids knowingly intercepting a private communication unless a party consents ("one-party consent"); privacy law requires notice of purposes for commercial recording; transcripts are durable and discoverable and need deletion schedules (https://blog.privacylawyer.ca/2025/09/recording-conversations-using-ai.html, CONFIRMED summary). It doesn't settle whether an AI vendor is a non-participant interceptor. No statute found requiring AI announcement; vendor blogs recommend it (UNCERTAIN).
- Conclusion (INFERRED): open every call with "This is Alex, an automated assistant for [site]. Calls may be recorded to improve service. Say 'person' any time." Callers (family) also give us their own personal information, which needs a purpose notice.

---

## 6. Data residency by vendor

| Vendor / item                         | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Status                               |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| OpenAI API                            | Canada: **regional storage yes, regional processing no**; requires MAM or ZDR approval plus a Modified Retention amendment. Inference stays in region only where processing is listed. **Realtime API:** ZDR-eligible; 30-day abuse-monitoring retention by default; **regional processing and storage only US and Europe**. Residency excludes account/billing data. https://developers.openai.com/api/docs/guides/your-data                                                                                                 | CONFIRMED                            |
| OpenAI Jan 2026 post                  | At-rest residency expanded to Canada among others (https://openai.com/index/introducing-data-residency-in-europe/, per search summary)                                                                                                                                                                                                                                                                                                                                                                                        | CONFIRMED (2nd source)               |
| Twilio                                | Regions US1, IE1, AU1 only; "does not guarantee that all data will remain within your selected Region" during rollout; not all products outside US1. https://www.twilio.com/docs/global-infrastructure                                                                                                                                                                                                                                                                                                                        | CONFIRMED                            |
| Twilio BAA/HIPAA, recording retention | Not found                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | UNCERTAIN (open)                     |
| Oracle Health / OCI Canada            | Oracle runs Canadian hospital EHRs on OCI (North York General 2025, TSSO Ontario 2026); Oracle Database@Google Cloud in Toronto and Montreal; Oracle's sovereign-cloud paper says it doesn't move data out of a region without customer authorization (https://www.canhealth.com/2026/02/11/tsso-moves-electronic-records-to-oracle-cloud/, https://oracle.com/news/announcement/north-york-general-becomes-first-hospital-in-canada-to-migrate-ehr-to-oci-2025-04-25/). **Nothing found on where OPOR/NS Health is hosted.** | CONFIRMED for others; OPOR UNCERTAIN |
| CLOUD Act                             | Oracle, OpenAI and Twilio are US companies; raised only by a competitor's marketing blog. Relevant to PIIDPA s.6 foreign-demand notice.                                                                                                                                                                                                                                                                                                                                                                                       | UNCERTAIN                            |

Implication (INFERRED): Alex (Twilio media to OpenAI Realtime, processed in the US) can't claim Canadian residency. Mitigate: (1) code-gated approved sentences only, no PHI-bearing events sent to the model; (2) ZDR/MAM with OpenAI; (3) Twilio recording off, no PHI stored in vendor accounts; (4) for a pilot, get a PIIDPA s.5(2) head decision or move to a Canadian-processing voice stack (not researched: UNCERTAIN).

---

## 7. Accessibility and language

- **NS Accessibility Act:** the Goods and Services Accessibility Standard is "Expected in 2027" and appears not yet in regulation (https://novascotia.ca/accessibility/goods-services/). Province targets all standards by 2030 (https://novascotia.ca/accessibility/access-by-design/). NS Health publishes an accessibility plan and 2026 report card (https://www.nshealth.ca/sites/default/files/documents/Nova%20Scotia%20Health%20Accessibility%20Plan%20Report%20Card%20-2026.pdf). Information and Communication standard status: UNCERTAIN. No binding standard today, but a public-sector tool will be judged against the Act's purpose and NS Health's plan.
- **PHIA s.15(2)-(3)** already makes accessibility a consent-validity issue (CONFIRMED): reasonable efforts to assist people with language or disability barriers. Build voice-first, plain-language SMS, relay/TTY acceptable, large-type web, WCAG 2.1 AA.
- **French:** NS Health publishes a French-language services plan under the French-language Services Act (https://www.nshealth.ca/french-language-services-nova-scotia-health); DHW 2026-27 plan ties to the Act (https://www.novascotia.ca/documents/french-language-services-plan-2026-2027-department-health-and-wellness). Whether the Act obliges French on automated patient lines: UNCERTAIN (Act not read). Twilio says support HELP/STOP in the recipient's local language. Practical: EN/FR on SMS (add ARRET/AIDE keywords; INFERRED), voice language switch, grade 6-8 reading level.

---

## 8. Requirements checklist

### MUST

**Consent and disclosure**

- M1. Family disclosure only to a registered contact with a recorded consent scope: `presence_location_condition` (s.37 basis, discretionary, same-day, general terms) plus separate express-consent scopes for `journey_status`, `estimates`, `alerts`. Store consent text version, channel (oral/written), timestamp, who captured, language.
- M2. Every disclosure writes a `disclosures` row with the s.42 fields: description/copy, recipient, date/time, authority (s.37 or consent id).
- M3. **Express request wins:** a patient "keep my information private" flag blocks all family disclosure at once; revocation (s.17) takes effect for the next call/text, is logged, and isn't retroactive.
- M4. s.37 disclosures cover only the day of disclosure; no prior-visit lookups.
- M5. Estimates are express-consent-only; never under s.37 alone; suppression rules per the design doc; ranges not promises; escalation line.
- M6. Fail closed on any capacity or SDM question and hand off to staff. VeriCare never decides SDM status; contacts are patient-named.
- M7. No marketing or promotional content in any message.

**Verification**

- M8. Verification beyond name and birthday (SMS one-time code), identical neutral reply on failure, rate limits and lockout. Wilful false representation is an offence (s.106(c)) and a wrong-person disclosure is a s.69 breach.

**Audit and breach**

- M9. Append-only `audit_events` with the Reg s.11(2) fields for every staff and system access; retained >= 1 year (Reg s.11(3)); per-patient export within 30 days (s.63).
- M10. Breach runbook: detect mis-disclosure, record it (Reg s.10(3)-(4)), notify the custodian at the first reasonable opportunity (s.28(3)); custodian notifies the individual (s.69) or OIPC (s.70(2)).
- M11. Role-based access and individual logins on `/professional/ed` (Reg s.10(1)(c)); every flag change logged with user.

**Retention and handling**

- M12. Retention is a configurable TTL following NS Health's written schedule (s.50), with secure deletion or de-identification (s.49). MVP default: purge raw transcripts/audio shortly after the visit; keep structured audit rows.
- M13. No PHI or transcripts used for model training; OpenAI ZDR/MAM; Twilio call recording off by default.
- M14. SMS templates only: no diagnosis, result values or CTAS number; reviewed by privacy.
- M15. Minimum necessary: the gate returns categories and approved text, never raw event data, to the voice model.

**SMS and calling**

- M16. STOP/HELP (and French equivalents), persisted opt-out, immediate; HELP identifies sender and privacy contact.
- M17. Verified toll-free sender for MVP/pilot; short code only with 12-16 weeks lead and CWTA approval, avoiding the mid-Oct to early-Jan freeze.
- M18. Own caller ID, no spoofing; outbound voice only on patient-requested callbacks until ADAD rules are confirmed by counsel.
- M19. Daytime-only for non-urgent SMS, except in-visit alerts the patient opted into.

**AI transparency**

- M20. Alex opens each call with AI disclosure, recording statement and "say person for a human"; identical handoff wording for all transfers.
- M21. Spoken output from approved templates only; log prompt-injection attempts.

**Governance (pilot, not the hackathon demo)**

- M22. Written agent agreement with NS Health (s.28) covering purposes, no secondary use, breach notice, sub-agents (Twilio, OpenAI), audit, retention, destruction.
- M23. PIA on the OIPC PHIA template; named custodian privacy contact (s.67).
- M24. PIIDPA handling: head-of-public-body decision (s.5(2)) or Canadian residency; foreign-demand reporting process (s.6).
- M25. Demo uses **synthetic data only**; say so in the video and deck.

### SHOULD

- S1. Canadian-processing model endpoint (or Canadian storage plus ZDR) before any pilot; show a residency map.
- S2. EN/FR parity on voice, SMS and web; grade 6-8 plain language; relay/TTY path; WCAG 2.1 AA.
- S3. Patient-facing "who was told what" view fed by `disclosures`.
- S4. Consents expire at discharge unless renewed.
- S5. Re-confirm consent on capacity doubt; offer in-person consent at triage.
- S6. Publish estimate coverage internally; auto-disable estimates if coverage falls below target.
- S7. State alignment with the federal voluntary AI code (transparency, oversight, incident log).
- S8. Staff training and an access-logging banner on the console (snooping is the OIPC NS enforcement pattern).
- S9. Track CRTC Notice 2026-132 and the 2027 FOIPOP regulations.

---

## 9. Open questions

1. Will NS Health treat VeriCare as an **agent** (s.28), or must this live inside NS Health/OPOR tooling? Who owns the PIA?
2. What is NS Health's ED practice for family contact (implied vs express)? Does OPOR have a "no information"/confidential flag and does it appear in feeds? (I found NS Health's "keep private" instruction, not the term "no information".)
3. Where is OPOR hosted (OCI Canada?), and would NS Health require a PIIDPA s.5(2) decision for OpenAI/Twilio?
4. Does NS Health consider a wait-time range to be "general condition"? Needs a privacy ruling; this design assumes no.
5. CRTC ADAD rules for non-solicitation automated calls (hours, identification, caller ID), and whether health notifications are exempt. The CRTC site was blocked; confirm with counsel.
6. Is a US voice vendor processing call audio a Criminal Code Part VI concern beyond participant consent?
7. Does the French-language Services Act require French on automated patient lines?
8. Twilio BAA terms, recording retention and Canadian STIR/SHAKEN attestation.
9. Has NS OIPC or NS Health issued AI scribe/AI agent guidance or policy?
10. What did N.S. Reg. 63/2026 change in the PHIA regulations?
11. Stages of Bill S-5 and Bill C-36.

---

## Source index

- PHIA: https://www.nslegislature.ca/sites/default/files/legc/statutes/personal%20health%20information.pdf
- PHIA Regulations: https://novascotia.ca/just/regulations/regs/phipershealth.htm
- DHW toolkit ch.5: https://novascotia.ca/DHW/PHIA/documents/chapters/5-Collection-Use-and-Disclosure.pdf ; complete toolkit: https://novascotia.ca/DHW/PHIA/documents/PHIA-complete-toolkit.pdf
- RUA fact sheet: https://www.gov.ns.ca/dhw/phia/documents/Fact-Sheet-Record-of-User-Activity.pdf
- OIPC NS PHIA hub: https://oipc.novascotia.ca/PHIA_Custodians ; s.70 guideline above ; snooping tips https://oipc.novascotia.ca/sites/default/files/publications/Tips%20for%20Addressing%20Employee%20Snooping.pdf
- NS Health privacy statement: https://www.nshealth.ca/node/1073
- PIIDPA: https://nslegislature.ca/sites/default/files/legc/statutes/personal%20information%20international%20disclosure%20protection.pdf ; FOIPOP release: https://news.novascotia.ca/en/2025/09/26/province-introduces-modernized-access-privacy-legislation
- CASL: https://laws-lois.justice.gc.ca/eng/acts/E-1.6/page-1.html
- DNCL FAQ: https://www.lnnte-dncl.gc.ca/en/Organization/Frequently-Asked-Questions
- Twilio: https://www.twilio.com/en-us/guidelines/ca/sms , https://www.twilio.com/en-us/guidelines/ca/short-code , https://www.twilio.com/docs/global-infrastructure
- OpenAI: https://developers.openai.com/api/docs/guides/your-data
- Voluntary AI Code: https://ised-isde.canada.ca/site/ised/en/voluntary-code-conduct-responsible-development-and-management-advanced-generative-ai-systems
- Recording law: https://blog.privacylawyer.ca/2025/09/recording-conversations-using-ai.html
- PIPEDA exemption order: https://laws-lois.justice.gc.ca/eng/regulations/SOR-2016-62/FullText.html
- NS accessibility: https://novascotia.ca/accessibility/goods-services/
