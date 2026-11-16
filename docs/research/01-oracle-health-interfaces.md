# 01 - Oracle Health (Cerner Millennium) integration interfaces

Research date: 2026-11-11. Public web only; no logins, no OPOR Hub, no SharePoint. Tags: **CONFIRMED** = read in the cited source (or observed live against the open sandbox today); **INFERRED** = reasoned from sources or the HL7 standard; **UNCERTAIN** = could not verify.

Short version: the design doc's two-path plan holds, but three things need changing. (1) A global `Encounter?_lastUpdated=ge...` poll does not work on Millennium R4. (2) Oracle's HL7 v2 outbound specs are not public, so every field mapping for ED location, triage level and confidentiality is site-specific until NS Health shares its spec. (3) Some Cerner sites do not carry room/bed in ADT at all, so location may need a second feed.

---

## 1. Open sandbox re-verification (live, 2026-11-11)

Base: `https://fhir-open.cerner.com/r4/ec2458f2-1e24-41c8-b71b-0e701af7583d`

### 1.1 What is there (CONFIRMED, `GET /metadata`, FHIR 4.0.1, US Core server, "Oracle Health implementation of FHIR on top of Millennium")

Every resource supports `read` and `search-type` (except where noted). Search params exactly as advertised (a leading `-` is how Oracle names its non-standard params):

| Resource                                             | Search params                                                                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Account                                              | _id, patient, -encounter, -guarantor, type, identifier, _count                                                            |
| AllergyIntolerance                                   | _id, patient, clinical-status, _lastUpdated                                                                               |
| Appointment                                          | _id, _count, date, -date-or-req-period, patient, practitioner, location, status                                           |
| Binary (read only)                                   | op `autogen-ccd-if`                                                                                                       |
| CarePlan                                             | _id, date, patient, category, _count                                                                                      |
| CareTeam                                             | _id, category, encounter, patient, status                                                                                 |
| ChargeItem                                           | _id, context, account, -status, _count (ops credit, modify)                                                               |
| Communication                                        | _id, category, received, recipient, -email-status                                                                         |
| Condition                                            | _id, patient, encounter, subject, clinical-status, category, _lastUpdated                                                 |
| Consent                                              | _id, patient, actor, patient.identifier, actor.identifier                                                                 |
| Coverage                                             | _id, patient, -encounter                                                                                                  |
| Device                                               | _id, patient                                                                                                              |
| **DiagnosticReport**                                 | _id, category, code, encounter, patient, date, _lastUpdated, _count                                                       |
| DocumentReference                                    | _id, patient, encounter, period, _count, type, category, date, _lastUpdated                                               |
| **Encounter**                                        | _id, _count, patient, subject, status, date, identifier, account, _lastUpdated (revinclude Provenance:target)             |
| FamilyMemberHistory                                  | _id, patient, status                                                                                                      |
| Goal                                                 | _id, patient, target-date                                                                                                 |
| Immunization                                         | _id, patient, _lastUpdated, date, target-disease                                                                          |
| InsurancePlan                                        | _id, owned-by                                                                                                             |
| **Location**                                         | _id, -physicalType, identifier, address, address-city, address-state, address-postalcode, name, organization, type        |
| Media (read only)                                    | -                                                                                                                         |
| MedicationAdministration                             | _id, patient, status, performer, effective-time                                                                           |
| MedicationDispense                                   | _id, patient, date, _lastUpdated, _count                                                                                  |
| MedicationRequest                                    | _id, patient, intent, status, _lastUpdated, -timing-boundsPeriod, _count                                                  |
| NutritionOrder                                       | _id, patient, status, _lastUpdated, _count                                                                                |
| Observation                                          | _id, patient, subject, category, code, date, _lastUpdated, _count                                                         |
| OperationDefinition, StructureDefinition (read only) | -                                                                                                                         |
| Organization                                         | _id, identifier, type, _count, name, address (op get-cg-for-mrcu)                                                         |
| Patient                                              | _id, identifier, name, given, family, address-postalcode, birthdate, phone, email, gender, _count (op health-cards-issue) |
| Person                                               | _id, identifier                                                                                                           |
| Practitioner                                         | _id, identifier, given, family, name, active, _count                                                                      |
| Procedure                                            | _id, patient, subject, date, _lastUpdated                                                                                 |
| Provenance                                           | _id, target                                                                                                               |
| Questionnaire, QuestionnaireResponse                 | _id (and patient)                                                                                                         |
| RelatedPerson                                        | _id, identifier, patient, -encounter, -relationship-level                                                                 |
| Schedule, Slot, Specimen                             | Schedule `_id`; Slot `_id,start,service-type,schedule.actor,-location,_count`; Specimen `_id`                             |
| **ServiceRequest**                                   | _id, patient, subject, code, _lastUpdated, _count                                                                         |

Not present (CONFIRMED by absence in metadata and 404s): **Subscription** (`GET /Subscription` -> 404), **Flag** (`GET /Flag` -> 404), Group, `$export` (`Group/1/$export` and `Patient/$export` GET -> 404 on the open endpoint), `$everything`, Task, EpisodeOfCare, ClinicalImpression. `security` block is only `{"cors": true}` (open endpoint has no OAuth; `/.well-known/smart-configuration` returns 404 here).

### 1.2 Behaviour that matters (CONFIRMED, live)

- `GET /Encounter?_lastUpdated=ge2026-11-01&_count=2` -> `OperationOutcome` error: "at least one of _id, identifier, account, -claim, -pageContext, patient, or subject must be provided". **There is no tenant-wide "what changed" query on Encounter.** `_lastUpdated` only narrows a search that already has an anchor. The design doc's polling line (`Encounter?_lastUpdated=ge...`) must become a per-patient or per-account poll.
- The same per-resource anchoring applies to DiagnosticReport (`_id` or `patient`), ServiceRequest (`patient`, `subject` or `_id`), Location (`_id` or `-physicalType`), Patient (identifier/name/etc.).
- Encounter results sample (patient 12724066, 25 results): keys present were `status, class, type, subject, location, serviceProvider, participant, extension, appointment, identifier`. **No `statusHistory`, no `classHistory`** in any sampled resource. `location[]` was a single entry per encounter (`status: active` while in-progress, `completed` when finished); the sampled finished inpatient (Encounter/97953477, class IMP) showed one location, display "Model Hospital, MX Hospital, MAT, MB01, A" (building, unit, room, bed in the display string).
- `Encounter.priority` observed using Cerner code set 3, for example "Elective" (309205/670840) and "Labor and Delivery" (309204), each also carrying a v3-ActPriority coding. The sandbox has no `class=EMER` encounters in the samples I pulled (UNCERTAIN whether any exist; I sampled five patient IDs only).
- Class codes in sandbox: AMB and IMP only in samples.
- Today's docs host: `fhir.cerner.com/millennium/r4/...` now 301-redirects to `docs.oracle.com/en/industries/health/millennium-platform-apis/mfrap/...` (CONFIRMED). Any bookmarks to the old host are dead.

---

## 2. Millennium FHIR R4: Encounter in depth

Sources: https://docs.oracle.com/en/industries/health/millennium-platform-apis/mfrap/op-encounter-get.html, https://docs.oracle.com/en/industries/health/millennium-platform-apis/mfrap/proprietary.html, https://docs.oracle.com/en/industries/health/millennium-platform-apis/mfrap/r4_overview.html, and the live sandbox above.

| Question                               | Answer                                                                                                                                                                                                                                                                                                                                                                                                             | Tag                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| `Encounter.status` values              | Search says "Valid statuses are `planned`, `in-progress`, `finished`, and `cancelled`"                                                                                                                                                                                                                                                                                                                             | CONFIRMED                                            |
| Search params and anchors              | `_id`, `identifier`, `account` (provider/system only, "not available for a patient persona"), `patient`, `subject`; plus `date` (needs `ge/gt/le/lt`), `_lastUpdated` (prefixes eq/ge/gt/le/lt, max two), `_revinclude=Provenance:target`. Docs say `patient` must be combined with `_count` and `status` (the open sandbox did not enforce this).                                                                 | CONFIRMED                                            |
| Sort                                   | "sorted from newest to oldest based on the start of the `Encounter.period`"                                                                                                                                                                                                                                                                                                                                        | CONFIRMED                                            |
| Elements observed in Oracle's examples | id, meta, text, extension, identifier (FIN NBR), status, class, type, serviceType, priority, subject, participant, appointment, period, reasonCode, hospitalization (admitSource, dischargeDisposition, destination), location, serviceProvider. The page has no formal element table.                                                                                                                             | CONFIRMED (observed, not documented as a contract)   |
| `statusHistory` / `classHistory`       | Not on the doc page; not in any sandbox resource sampled                                                                                                                                                                                                                                                                                                                                                           | CONFIRMED absent in samples; UNCERTAIN in production |
| Location history                       | `Encounter.location[]` entries carry `status` (`active`, `completed` seen). Whether production returns every past ED room/bed move as separate entries is not documented; the sandbox had one entry per encounter.                                                                                                                                                                                                 | UNCERTAIN                                            |
| Location detail                        | `location.location` reference to `Location/{id}`, may be a `contained` resource; display string includes building/unit/room/bed. Location search needs `_id` or `-physicalType`. Hierarchy is `partOf`. Code set 222 holds location types (BUILDING, NURSEUNIT, BED). ED-ness is a **custom attribute extension** on Location (example: custom attribute "Core Measure Locations" = "ED"), not a standard element. | CONFIRMED (docs example)                             |
| Priority                               | `Encounter.priority` codes come from "Code Set 3 Encounter Admission Type"; example `309203 "Emergency"`. This is registration-level admission type, **not CTAS**.                                                                                                                                                                                                                                                 | CONFIRMED                                            |
| Class                                  | "prioritizes v3 ActEncounterCodes"; v2-0004 codes only if no v3 mapping. Examples IMP and O. Whether ED visits come back as `EMER` is not documented.                                                                                                                                                                                                                                                              | CONFIRMED (rule); UNCERTAIN (EMER)                   |
| Admit source                           | `hospitalization.admitSource` from Code Set 2; example `309194 "Emergency Room"`                                                                                                                                                                                                                                                                                                                                   | CONFIRMED                                            |
| Hospital service                       | `serviceType` from Code Set 34 Hospital Service ("such as Emergency Medicine")                                                                                                                                                                                                                                                                                                                                     | CONFIRMED                                            |
| VIP                                    | `hospitalization.specialCourtesy` from Code Set 67 VIP (a one-value set: Yes) and Code Set 16 Courtesy. **This is the only FHIR-visible VIP signal found.**                                                                                                                                                                                                                                                        | CONFIRMED                                            |
| Participants                           | `participant[]` with type codes ATND (Attending, Cerner 1119), CON, REF, PPRF (Covering 18883355), PART; each has `period.start/end` and `Practitioner` reference.                                                                                                                                                                                                                                                 | CONFIRMED (observed)                                 |
| Triage level (CTAS)                    | Not in Encounter docs. Triage data would live in Observation/Condition/DocumentReference, or a custom-attribute extension.                                                                                                                                                                                                                                                                                         | UNCERTAIN                                            |
| Security filtering                     | "Encounter or organization security, privileges, and preference may filter data based on the build in the domain." Filtered data is silently absent, not labelled.                                                                                                                                                                                                                                                 | CONFIRMED                                            |
| Paging                                 | Follow `link` values; "you may see the same resource ID on subsequent pages", dedupe by ID and keep latest                                                                                                                                                                                                                                                                                                         | CONFIRMED                                            |

### 2.1 Patient security and deceased

- Patient has `meta.security` only in confidential-gender-identity examples: code `PROCESSINLINELABEL` ("process inline security label") plus an inline label `PRS` ("patient requested information sensitivity") on the gender-identity element. No restricted-patient / VIP / break-glass label is documented. CONFIRMED (https://docs.oracle.com/en/industries/health/millennium-platform-apis/mfrap/op-patient-get.html).
- `deceasedBoolean` shown (false) in examples; `deceasedDateTime` not shown. CONFIRMED (examples only).
- Patient search returns 422 if more than 1000 patients match. Patient search requires `_id` or a combination of identifier/name/birthdate/etc. CONFIRMED.
- FAQs: "Providers, systems, and applications may have data filtered for encounter and organization security reasons and privilege and preference build in the domain." CONFIRMED (https://docs.oracle.com/en/industries/health/millennium-platform-apis/fhir-faqs-common-issues/). Consequence for fail-closed: an _absent_ encounter is ambiguous (discharged vs filtered vs not authorised). INFERRED.
- DiagnosticReport: "The confidentiality feature is supported only for General Laboratory, Microbiology, Anatomic Pathology, and Radiology reports", and lab reports carry Inline Security Labels when a result is confidential. CONFIRMED (op-diagnosticreport-get).

### 2.2 No push, no Flag

Metadata and 404s confirm no Subscription or Flag. I could not read the Oracle developer-forum threads on FHIR Subscriptions (timeouts) so Oracle's roadmap position is UNCERTAIN. A search snippet mentions an app needing "Event Subscriptions" enabled for appointment webhooks, which suggests some per-app event push exists outside FHIR, but this is a single forum post, UNCERTAIN (https://forums.oracle.com/ords/apexds/post/enable-event-subscriptions-for-application-8557).

---

## 3. Order and result status (ServiceRequest, DiagnosticReport)

- **ServiceRequest** (https://docs.oracle.com/en/industries/health/millennium-platform-apis/mfrap/op-servicerequest-get.html), CONFIRMED:
  - Auth: Patient, Provider, System. `patient`, `subject` or `_id` required. `_lastUpdated` must include a time and use `ge` or `le`. `authored` search exists. `category` and `code` cannot be combined; `_lastUpdated` and `authored` cannot be combined.
  - Status values seen in examples: `active`, `completed`, `revoked`, `entered-in-error` (not a full list). Intent seen: `order`. `draft`/`on-hold` not seen in Oracle examples.
  - Categories: `2513` Laboratory, `636063` Consults, `2515` Patient Care, `23276383` Referral (code set 6000). **Radiology is not mentioned** on the page (UNCERTAIN whether imaging orders appear as ServiceRequest).
  - Default count 50.
  - Standard HL7 R4 ServiceRequest.status set is draft | active | on-hold | revoked | completed | entered-in-error | unknown (https://hl7.org/fhir/R4/ServiceRequest.html), CONFIRMED as the standard, not as what Millennium emits.
- **DiagnosticReport** (https://docs.oracle.com/en/industries/health/millennium-platform-apis/mfrap/op-diagnosticreport-get.html), CONFIRMED:
  - Auth: Provider, Patient, System. `patient` or `_id` required. `_count` default 10, max 100. `_lastUpdated` and `date` cannot be combined; `date` needs time component. `encounter` search param exists (useful to tie reports to the ED visit). Category examples `LAB`, `MB`, `RAD` (v2-0074) and LOINC LP29684-5 (radiology).
  - Status values seen: `final`, `corrected`. The full set (registered, partial, preliminary...) is not listed. A DiagnosticReport generally appears only when a result exists, so "ordered but not resulted" must come from ServiceRequest `active`. INFERRED.
  - Lab and micro populate `DiagnosticReport.result`. For VeriCare status-only use, read `status` and ignore `result`.
- **HL7 v2 side** (ORM^O01 order, ORU^R01 result): Vital's public spec for ED vendors says ORM drives step-by-step updates and requires OBR-2 and OBR-4.1 to match between orders and results (https://vital.io/help/en/articles/15863089-hl7v2). ORC-5 (order status) and OBR-25 / OBX-11 (result status F/P/C) are standard HL7 v2 fields; whether Millennium populates them as expected is UNCERTAIN.

---

## 4. HL7 v2 outbound from Millennium

### 4.1 What is public (and what isn't)

- Oracle's HL7 v2 messaging runs through its own engines: "Open Engine (described as supporting HL7, ASTM, and X12) and OPENLink" per a third-party practitioner write-up (https://nirmitee.io/blog/mirth-connect-and-cerner-integration/); another vendor blog says Cerner Open Interface (COI) is the HL7 v2 engine (https://www.tactionsoft.com/blog/cerner-oracle-health-integration-guide/). Both secondary sources. INFERRED.
- **Oracle's own interface/message specifications are not public.** The nirmitee article says explicitly that "Oracle's message specifications are not public" and that interfaces are licensed individually. Searches for Millennium ADT outbound specs, ZPD/ZVI segments, and FirstNet outbound interfaces returned nothing from Oracle. The "ZPD / ZVI" segment names in the task brief are **not confirmed** as Cerner segments; HL7 reserves Z-segments for local use. Only Cerner Z-segments found are German CGM/medico ones (ZBE, ZWL), irrelevant to NS (https://dokuwiki.cerner.com/doku.php?id=cerner%3Amedico%3Adper%3Ahl7v2%3Aexportpatdaten%3Asegmente). UNCERTAIN.
- Oracle's Clinical Data Exchange docs list ADT notifications Oracle emits: **A01, A03, A04, A05, A08**, and say merges (**A34, A40**) and account move (**A44**) are "used internally only and are not shared with payers" (https://docs.oracle.com/en/industries/health/clinical-data-exchange/cdevg/enable-clinical-event-notifications.html). CONFIRMED, but that is the payer-notification product, not the ED outbound feed.

### 4.2 Evidence from a vendor that does exactly this

Vital (an ED wait-time and patient-communication vendor) publishes the feed it needs from any EHR, including Cerner clients. It is the closest public analogue to VeriCare. All CONFIRMED as _Vital's requirements_, UNCERTAIN as _what NS Health will send_:

- Trigger roles (https://vital.io/help/en/articles/16044956-adt-trigger-events-patient-workflow): start visit = A04, A01, A05; keep current = A08, A02, A09, A10, A06, A07; end visit = A03 _or_ admit/transfer out of an in-scope ED location; corrections A11, A12, A13; merges/moves/deletes A40, A41, A42, A43, A44, A45, A23, A29; **deceased = PID-29 / PID-30 with discharge disposition**. "Location changes drive wait-time predictions and step tracking."
- ED filter: "filtering on `PV1.3.1` (assigned location) and `PV1.6.1` (prior location) against in-scope ED department values" (https://vital.io/help/en/articles/15863089-hl7v2).
- Segments/fields they ask for (https://vital.io/help/en/articles/15863092-adt): PID 1,2,3,5,7,8,10,11,13,15,18,29,30; PV1 1,2,3,6,7,10,14,16,17,18,19,36,39,44,45,50; PV2 3,21,22,38 (38 = mode of arrival); PD1-4; ROL; MRG; Zxx. They list PV1-16 and PV2-22 and PV2-21 (publicity) so privacy flags _can_ travel in these fields, but this is their wish list, not proof Millennium fills them.
- **Cerner-specific gotcha (vendor claim):** "Room & Bed Extracts apply to Cerner clients where location information is unavailable via the ADT", delivered as a CSV every 5-15 minutes with MRN, Encounter, Facility, Department, Room, Bed, DateTimeUpdated, covering ED patients for the past hour (https://vital.io/help/en/articles/15863134-ccl-location-information-export). A ready-made Cerner CCL script is implied. So for some Cerner sites the ADT feed gives unit but not room/bed. UNCERTAIN for NS.
- Cerner puts FIN in PV1-19 as the visit number and carries multiple ID types (MRN, FIN, community MRN) in PID-3 (third-party blog; https://nirmitee.io/blog/mirth-connect-and-cerner-integration/ and https://www.tactionsoft.com/blog/cerner-oracle-health-integration-guide/). Secondary. INFERRED.

### 4.3 Standard HL7 v2 fields for the things VeriCare cares about

Field facts from the HL7 v2 (v2.9-style) reference pages at https://hl7.eu/refactored/segPV1.html, segPV2.html, segPD1.html (CONFIRMED as the standard). Whether Millennium uses them this way is INFERRED.

| Need                          | Standard field                                                                                                                                                                                                             | Notes                                                                                          |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Visit is ED                   | PV1-2 Patient Class (table 0004, suggested `E` = Emergency), PV1-4 Admission Type (table 0007, `E`), PV1-10 Hospital Service, PV1-14 Admit Source                                                                          | 0004 `E` is from general HL7 knowledge; the reference page doesn't list values.                |
| ED location                   | PV1-3 Assigned Patient Location (PL: point of care ^ room ^ bed ^ facility ^ status ...), PV1-6 Prior Location                                                                                                             | Primary signal for waiting room vs triage vs room vs ED hallway. Site build decides the codes. |
| Visit id                      | PV1-19 Visit Number (CX), PV1-50 Alternate Visit ID                                                                                                                                                                        | Cerner: FIN in PV1-19 (see above).                                                             |
| Attending / provider assigned | PV1-7 Attending Doctor, PV1-17 Admitting Doctor, PV1-8 Referring, ROL segment                                                                                                                                              | "Seen by provider" is best derived from PV1-7 going from empty to populated. INFERRED.         |
| Arrival / departure time      | PV1-44 Admit Date/Time, PV1-45 Discharge Date/Time, EVN-2/EVN-6                                                                                                                                                            |                                                                                                |
| Triage acuity (CTAS)          | **No dedicated v2 field.** Candidates: PV2-25 Visit Priority Code, PV2-40 Admission Level of Care Code ("acuity level assigned ... at admission"), an OBX segment in ADT, or a Z-segment.                                  | UNCERTAIN. Must be asked of NS Health.                                                         |
| VIP                           | PV1-16 VIP Indicator (table 0099)                                                                                                                                                                                          | Oracle FHIR exposes VIP via Code Set 67 on `specialCourtesy`, so Millennium has a VIP concept. |
| Confidential / protected      | PD1-12 Protection Indicator (Y/N, table 0136) and PV2-22 Visit Protection Indicator; PV2-21 Visit Publicity Code (user-defined). **PD1-12 and PV2-22 are backward-compat only since v2.6; the ARV segment replaces them.** | So a modern interface may use ARV, or none of these. UNCERTAIN.                                |
| Deceased                      | PID-29 Patient Death Date/Time, PID-30 Patient Death Indicator                                                                                                                                                             | Vital uses both to stop messaging.                                                             |
| Discharge disposition         | PV1-36                                                                                                                                                                                                                     |                                                                                                |
| Mode of arrival               | PV2-38 (e.g., ambulance)                                                                                                                                                                                                   |                                                                                                |
| Merge                         | A40 (patient merge, MRG segment), A34/A35/A36 older merge events                                                                                                                                                           | Oracle says A34/A40/A44 are internal in CDX; ED feed may differ.                               |

### 4.4 Trigger events a tracking feed typically uses (standard semantics)

- A04 Register a patient (ED/outpatient arrival; HL7 v2.2 ch.3 says A04 includes ER patients, https://www.hl7.eu/HL7v2x/v22/std22/HL7CHP3.html). A05 pre-admit (pre-arrival/EMS). A08 update. A02 transfer. A03 discharge. A01 admit (inpatient decision/admission). A06/A07 class change (ED -> inpatient and back). A09/A10 patient departing/arriving "tracking" (used for moves to temporary locations; some EHRs use A08 instead). A11/A12/A13 cancel admit/transfer/discharge. A40 merge. CONFIRMED as standard.
- Whether Millennium emits A08 or A02 for ED room moves, and whether it emits A09/A10, is UNCERTAIN (no Cerner-specific source found). Some EHRs send A08 for location changes (https://interfaceware.com/hl7-adt, general). VeriCare's mapper must handle location change on A02, A08, A09, A10 alike (compare PV1-3 to last known).

### 4.5 SAMPLE messages (synthetic, ILLUSTRATIVE ONLY)

These are not an Oracle or NS Health specification. They follow standard HL7 v2.5.1 structure with Cerner-flavoured conventions from the secondary sources (FIN in PV1-19, MRN in PID-3). All names, numbers and facility codes are invented. Carriage returns shown as line breaks. Location codes (`ED^WR`, `ED^TR1`) are invented.

**Message 1: ED arrival (ADT^A04). Patient registers, waiting for triage.**

```
MSH|^~\&|MILLENNIUM|QEII|VERICARE|VC|20261114083212||ADT^A04^ADT_A01|MSG000001|P|2.5.1
EVN|A04|20261114083200
PID|1||7000123^^^QEII^MR~7000123^^^NSHA^PI||TESTPATIENT^ALEX^^^^^L||19840312|F|||1 SAMPLE ST^^HALIFAX^NS^B3H0A0^CAN||^PRN^PH^^^902^5550101
PV1|1|E|ED^WAITROOM^^QEII^^^^ED||||||||||||||||FIN4410023^^^QEII^VN|||||||||||||||||||||||||20261114083200
PV2|||CHEST PAIN^^L
```

Field by field:

- MSH-3/4 sending app and facility (MILLENNIUM / QEII); MSH-9 message type + trigger + structure; MSH-10 control id (for ACK and de-duplication); MSH-11 `P` production; MSH-12 version.
- EVN-1 event (A04); EVN-2 recorded time; EVN-6 (event occurred) is the better "real time" when present.
- PID-3 repeating IDs: MRN (`MR`) and a provincial patient identifier (`PI`; the real NS health card number would be a distinct assigning authority, UNCERTAIN). PID-5 name; PID-7 DOB; PID-8 sex; PID-29/30 empty = not deceased.
- PV1-2 `E` = emergency patient class. PV1-3 `ED^WAITROOM^...` point of care ED, room "WAITROOM", facility QEII. PV1-7 attending empty = no provider yet. PV1-19 FIN visit number. PV1-44 admit/arrival time. PV1-16 empty = no VIP flag.
- PV2-3 reason for visit (free text; sensitive, never relay to family). PV2-38 mode of arrival is not shown.

**Message 2: Triage complete (ADT^A08). CTAS assigned, location now Triage; chief complaint and acuity travel in OBX (INFERRED convention).**

```
MSH|^~\&|MILLENNIUM|QEII|VERICARE|VC|20261114084505||ADT^A08^ADT_A01|MSG000002|P|2.5.1
EVN|A08|20261114084455
PID|1||7000123^^^QEII^MR~7000123^^^NSHA^PI||TESTPATIENT^ALEX^^^^^L||19840312|F
PV1|1|E|ED^TRIAGE^1^QEII^^^^ED|||ED^WAITROOM^^QEII|||||||||||||FIN4410023^^^QEII^VN|||||||||||||||||||||||||20261114083200
PV2|||CHEST PAIN^^L
OBX|1|CWE|CTAS^Canadian Triage and Acuity Scale^L||3^Urgent^L||||||F|||20261114084430
```

- EVN-1 A08 = update, no other trigger event. PV1-3 now `ED^TRIAGE^1`; PV1-6 prior location = waiting room (this is what Vital filters on).
- OBX-3 is a local code for CTAS: **there is no standard v2 field for CTAS**, so this OBX (or a Z-segment, or PV2-25/PV2-40) is an assumption. OBX-5 = level 3. OBX-11 `F` final. VeriCare must treat the CTAS source as configurable per site.

**Message 3: Moved to exam room and provider assigned (ADT^A02).**

```
MSH|^~\&|MILLENNIUM|QEII|VERICARE|VC|20261114101530||ADT^A02^ADT_A02|MSG000003|P|2.5.1
EVN|A02|20261114101520
PID|1||7000123^^^QEII^MR~7000123^^^NSHA^PI||TESTPATIENT^ALEX^^^^^L||19840312|F
PV1|1|E|ED^ROOM5^A^QEII^^^^ED|||ED^TRIAGE^1^QEII|1234567^SAMPLEDOC^PAT^^^DR^^^NSHA^^^^PRN||||||||||||FIN4410023^^^QEII^VN|||||||||||||||||||||||||20261114083200
```

- A02 = transfer. PV1-3 new location (ED room 5, bed A); PV1-6 prior (triage). PV1-7 attending now populated = "being seen" candidate. In Cerner the attending may arrive on a later A08 or via ROL; treat as derived.

**Message 4: Departure / discharge (ADT^A03).**

```
MSH|^~\&|MILLENNIUM|QEII|VERICARE|VC|20261114133040||ADT^A03^ADT_A03|MSG000004|P|2.5.1
EVN|A03|20261114133020
PID|1||7000123^^^QEII^MR~7000123^^^NSHA^PI||TESTPATIENT^ALEX^^^^^L||19840312|F
PV1|1|E|ED^ROOM5^A^QEII^^^^ED|||||1234567^SAMPLEDOC^PAT^^^DR^^^NSHA^^^^PRN||||||||||||FIN4410023^^^QEII^VN||||||||||||||||01^Home or Self Care^L||||||||20261114083200|20261114133020
```

- A03 ends the visit. PV1-36 discharge disposition (code table site-defined; `01` is a UB-04-style "home" example). PV1-44 arrival, PV1-45 departure. VeriCare computes actual time-to-assessment and length of stay from these for the estimate log.

**Message 5: Status-only lab order and result (ORM^O01, ORU^R01). VeriCare should read only the order/result _status_.**

```
MSH|^~\&|MILLENNIUM|QEII|VERICARE|VC|20261114090010||ORM^O01^ORM_O01|MSG000005|P|2.5.1
PID|1||7000123^^^QEII^MR
PV1|1|E|ED^TRIAGE^1^QEII|||||||||||||||FIN4410023^^^QEII^VN
ORC|NW|ORD778899^MILLENNIUM||||||||||1234567^SAMPLEDOC
OBR|1|ORD778899^MILLENNIUM||TROP^Troponin^L|||20261114090000

MSH|^~\&|MILLENNIUM|QEII|VERICARE|VC|20261114094550||ORU^R01^ORU_R01|MSG000006|P|2.5.1
PID|1||7000123^^^QEII^MR
PV1|1|E|ED^ROOM5^A^QEII|||||||||||||||FIN4410023^^^QEII^VN
ORC|RE|ORD778899^MILLENNIUM
OBR|1|ORD778899^MILLENNIUM||TROP^Troponin^L|||20261114090000|||||||||||||||||F
```

- ORC-1 `NW` new order, `RE` observations to follow. OBR-2 ties result to order (Vital requires OBR-2 and OBR-4.1 match). OBR-25 `F` = final result status. **Do not forward OBX values** (OBX segments omitted on purpose). `NW` = "tests ordered", ORU `P` (preliminary) vs `F` = "results in/partial". Mapping to Cerner behaviour is INFERRED.

### 4.6 ACK and transport

MLLP framing (0x0B ... 0x1C 0x0D), receiver replies ACK (MSA-1 `AA`/`AE`/`AR` echoing MSH-10). Vocera-style ED listeners use a configurable TCP port (design doc says default 2575, from the earlier research; 2575 is the conventional HL7 MLLP port in general, not Cerner-specific; I found no source for a Cerner default). INFERRED.

---

## 5. FirstNet tracking board

Sources: Munson Healthcare "Alerts, Icons & Statuses for ED Providers" (Cerner FirstNet education, 2021-08-05; PDF extracted locally from https://www.munsonhealthcare.org/media/file/Alerts%20Icons%20Statuses%20Provider.pdf); Northern Health BC FirstNet overview (https://physicians.northernhealth.ca/sites/physicians/files/physician-resources/safercare/documents/firstnet.pdf); Cerner-vendor quick guides (UNM 2015, https://hsc.unm.edu/medicine/departments/emergency-medicine/_docs/clinical_resources/electronic-health-record/firstnet-quick-reference-2015.pdf).

### 5.1 What the tracking board records (CONFIRMED)

- Throughput status colours/labels on the board (Munson): **Prearrival** (purple), **Need Provider Action** (orange), **Assigned or Evaluation in Progress** (blue), **Patient has already been seen or has orders placed** (green), **Orders Complete** (check mark), **Disposition Order placed for Admit, Transfer or Expired** (dark blue), **Discharged Order Placed** (gray), **Triage Documentation Not Completed** (magenta), **Triage Documentation Complete** (light blue), **Bed Ready** (pink), **Bed Assignment**, **Bed Request**, **Discharge Disposition**.
- Order/result icons: lab Ordered -> Ready for review (normal / critical) -> user reviewed; radiology Exam Ordered -> Exam Complete -> Report available; ECG In Process -> completed and reviewed; Medication ordered/completed; Consult ordered/complete; vitals available/critical/need reassessment.
- Patient icons relevant to confidentiality: **"Opt Out Confidential Registration Status"**, "History of Violence", isolation, fall risk, CSSRS high risk, alerts (Expired Patient, Sepsis, SIRS, Level 1/2 Trauma, STEMI, SANE/Domestic, Restraint Care).
- Workflow: Pre-Arrival form (referrals, trauma, EMS) -> registration -> triage -> assign provider (`Assign Provider`, filters My Patients / Unassigned) -> orders -> **Depart** toolbar: disposition, "Ready for Discharge", Discharge icon. Discharged patients move to an **ED Lookback** tab; discharge can be cancelled and the board updates (Northern Health, Munson, Atrium/WH guides). The ED LaunchPoint list refreshes every 60 seconds (Northern Health BC).
- The Western Health guide (Australia, 403 to my fetcher; snippet only) says staff update status by clicking the patient and selecting an option. UNCERTAIN detail.

### 5.2 Are those statuses emitted as HL7 or FHIR? UNCERTAIN, no public source

- No source found that says FirstNet board status changes are emitted as HL7 events. Vendors consistently describe building ED status from **location changes + ADT class/type + order/result messages** (Vital: location changes drive step tracking, ORM drives steps; https://vital.io/help/en/articles/16044956-adt-trigger-events-patient-workflow). That suggests the tracking-shell statuses ("Need Provider Action", "Bed Ready") are not directly exposed and must be derived. INFERRED.
- FHIR: none of the board statuses have a documented FHIR representation. `Encounter.status` is four values only (section 2). INFERRED derivation is what the design doc already assumes.
- In Cerner, ED "tracking" locations (waiting room, triage, rooms, hallway) are typically Location build in the tracking group, and moves create location history; ADT A02/A08/A09/A10 is where that would surface. UNCERTAIN.

### 5.3 Published integrations found

- **Vital Emergency** (ED patient experience / predicted waits): works from the ADT feed with ED-location filter, plus ORM/ORU, flowsheets, notes; for Cerner clients optionally a CCL "Room & Bed" CSV extract. https://vital.io/help/en/collections/19470958-integration-guide (CONFIRMED vendor documentation).
- **Midmark CareFlow RTLS**: lists Oracle Cerner among EMRs it updates with real-time location via bi-directional interface (https://www.midmark.com/medical/rtls/rtls-solutions/interfaces; search snippet, UNCERTAIN detail).
- **GE HealthCare Command Center / QEII C3**: ingests real-time Cerner Millennium messages (already in the design doc; I did not re-research). UNCERTAIN for OPOR.
- **Vocera / Stryker EASE, TeleTracking, Epic-to-Cerner**: no public integration documentation found for how they pull ED status from Cerner. UNCERTAIN. (The design doc's "default port 2575" claim for Vocera/Stryker was not corroborated by anything I could read.)
- Oracle's patient portal docs say the portal is not intended for emergency medical communications (search snippet of https://docs.oracle.com/en/industries/health/health-patient-portal/ohcsp/index.html; UNCERTAIN, not opened).

---

## 6. Bulk Data, rate limits, auth, registration

### 6.1 Bulk export (CONFIRMED, https://docs.oracle.com/en/industries/health/millennium-platform-apis/mfbda/op-group-group_id-export-get.html and .../op-patient-export-post.html)

- Two kickoffs: `GET [base]/Group/{id}/$export` and `POST [base]/Patient/$export` (Parameters body with `patient` references, up to **20,000**, at least one required). Both **System** auth only. Header `Prefer: respond-async` required; 202 with `Content-Location` job URL under `/bulk-export/jobs/{id}`.
- `_type` allowed: AllergyIntolerance, CarePlan, CareTeam, Condition, Coverage, Device, DiagnosticReport, DocumentReference, **Encounter**, Goal, Immunization, Location, MedicationDispense, MedicationRequest, Patient, Procedure, Observation, Organization, Practitioner, Provenance, RelatedPerson, **ServiceRequest**, Specimen. `_since`, `_outputFormat` (ndjson), `_typeFilter` (e.g. `Encounter?status=planned`; not for Location/Organization/Patient/Practitioner...) supported. `_elements` not supported.
- Constraints: "Only one bulk export request for a client application and tenant combination may be in-progress at a single time." Token must hold **system read scopes for every `_type` requested**; `Group.read` not needed. Older Cerner page said scopes not checked on kickoff (conflict; newest doc wins). JWT client auth (RS384/ES384) "appropriate for Bulk Data Access"; JWKS registered in Cerner Central.
- **Fit for VeriCare training data:** weak. You must already know the patient list (or have a Group built by the site), the export contains Encounter with only the final state and a single/current `location` (no confirmed status or location history), so you cannot reconstruct time-in-triage or time-to-provider from FHIR alone. ED timestamps for estimates would come from NS Health's reporting/data warehouse or from replaying a recorded ADT stream. INFERRED. The AI Application Suite version of Bulk is "pending production deployment for EHR environments" but is a different product (search snippet).
- Local scopes: only for the pilot-phase analysis; synthetic data for the hackathon.

### 6.2 Auth and registration (CONFIRMED, https://docs.oracle.com/en/industries/health/millennium-platform-apis/millennium-authorization-framework/)

- SMART on FHIR backend-style: token endpoint `.../tenants/{tenant}/protocols/oauth2/profiles/smart-v1/token`, discoverable from `{base}/.well-known/smart-configuration`; `grant_type=client_credentials`, `scope=system/Encounter.read system/Patient.read ...`.
- Client auth: Basic with system-account client id/secret (`client-confidential-symmetric`) or signed JWT (`client-confidential-asymmetric`, RS384 or ES384). **Wildcard scopes unsupported**; each scope must be requested. Token lifetime for system tokens is not stated (authorization-grant tokens are 570 s); read `expires_in`.
- Registration steps: (1) free CernerCare account; (2) register the app in **Code Console** with application type **System** or privacy **Confidential**; (3) a system account is auto-issued to that CernerCare account, manage the secret or JWKS in **Cerner Central System Account Management** (https://cernercentral.com/system-accounts); (4) "Oracle Health customers may then enable client applications to access their protected resources."
- What the hospital must do: enable (provision) the app and system account in its own domain/tenant. The official page only says customers "enable client applications" and points to a community topic. A third-party guide says activation is per tenant via a service request (https://forums.oracle.com/ords/apexds/post/how-is-system-account-request-enablement-structured-0285 is in search results but unread). UNCERTAIN on exact steps and on Canadian/NS-specific process (no public evidence NS Health permits third-party FHIR apps).
- Fees: Oracle's "API Access and Fees" page exists (https://www.oracle.com/health/developer/api/) but returned 403; UNCERTAIN.
- Needed scopes for VeriCare's read-only polling (INFERRED from the resource docs): `system/Encounter.read`, `system/Patient.read`, `system/Location.read`, `system/Practitioner.read` (only if provider role is used), `system/ServiceRequest.read`, `system/DiagnosticReport.read`, optionally `system/Provenance.read` (for `_revinclude`). Request exactly these, nothing broader.

### 6.3 Rate limits (CONFIRMED, https://docs.oracle.com/en/industries/health/millennium-platform-apis/fhir-faqs-common-issues/)

- "Yes, we enforce rate limits to preserve performance of the underlying EHR." "Rate limits vary between customers based on agreed usage levels." Exceeding returns **429**; use progressive retry (1 s, 2 s, 4 s, max ~3 retries). No numbers published. Refresh attempts below one minute may be throttled. Cache tokens.
- Implication: per-patient polling for every ED patient every minute is a rate-limit risk; polling a few dozen active ED patients at 1-2 minute intervals is plausible but must be agreed with the customer. INFERRED.

---

## 7. Node / TypeScript tooling (checked against npm registry, 2026-11-11)

| Package                               | Version / last publish | License    | Use                                                           | Notes                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------- | ---------------------- | ---------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@medplum/hl7`                        | 5.2.17, 2026-11-11     | Apache-2.0 | MLLP client (`Hl7Client`) and server (`Hl7Server`), ACK modes | CONFIRMED exports: Hl7Client, Hl7Server, Hl7Connection, ReturnAckCategory. Parsing class `Hl7Message` lives in **`@medplum/core`** (CONFIRMED by running: `Hl7Message.parse(raw)`, `getSegment('PV1').getField(3)`, `buildAck()`). ~27k weekly downloads. **Recommended**: same org as `@medplum/fhirtypes`, actively maintained. |
| `node-hl7-client` / `node-hl7-server` | 4.1.2, 2026-10-29      | MIT        | Pure-Node HL7 client/server, 0 runtime deps                   | CONFIRMED loads; exports Client, Message, Segment, MLLPCodec, version specs 2.1-2.8; Server/Inbound. ~52k weekly. Good alternative with typed segments.                                                                                                                                                                           |
| `simple-hl7`                          | 3.3.0, 2024-06-13      | MIT        | Simple parse/build, TCP server/client                         | Older, less maintained. ~10k weekly.                                                                                                                                                                                                                                                                                              |
| `hl7-standard`                        | 1.0.4, 2022-05-11      | Apache-2.0 | Parse/transform                                               | Stale despite 95k weekly downloads. Avoid for new work.                                                                                                                                                                                                                                                                           |
| `hl7v2`                               | 2.3.2, 2026-11-10      | BSD-3      | Parser/serializer/validator                                   | Active; not evaluated further.                                                                                                                                                                                                                                                                                                    |
| `@medplum/fhirtypes`                  | 5.2.17, 2026-11-11     | Apache-2.0 | R4 TypeScript types (`Encounter`, `ServiceRequest`...)        | 0 deps, ~348k weekly. **Recommended.**                                                                                                                                                                                                                                                                                            |
| `@types/fhir`                         | 0.0.44, 2026-06-09     | MIT        | R4 ambient types                                              | ~635k weekly; works but less rich.                                                                                                                                                                                                                                                                                                |
| `@smile-cdr/fhirts`                   | 8.12.1, 2026-09-15     | Apache-2.0 | Typed models DSTU2-R5                                         | Heavier, runtime classes.                                                                                                                                                                                                                                                                                                         |
| `fhir-kit-client`                     | 2.0.3, 2026-07-27      | MIT        | FHIR client with SMART/OAuth helpers                          | Optional; plain `fetch` is enough for the Oracle token + search.                                                                                                                                                                                                                                                                  |

Mock FHIR servers for the simulator:

- **HAPI FHIR JPA starter**: `docker run -p 8080:8080 hapiproject/hapi:latest`, REST base `http://localhost:8080/fhir`; image `latest` / `v8.12.0-2` pushed 2026-10-02; H2 by default, Postgres supported; REST hook and websocket Subscriptions via `hapi.fhir.subscription.*` (https://github.com/hapifhir/hapi-fhir-jpaserver-starter, CONFIRMED; image tag dates CONFIRMED from Docker Hub API). Public test server `https://hapi.fhir.org/baseR4` returns 200 on `/metadata` but is shared and wipes data, don't use for demos.
- **Medplum** (Apache-2.0 core, `medplum/medplum-server` image pushed 2026-11-11): self-hosted needs Postgres + Redis; has HL7 ADT/ORM/ORU handling, "HL7 to FHIR" bot pattern, On-Prem Agent (https://www.medplum.com/docs/hl7). I could not read the run-the-stack page, so exact compose steps UNCERTAIN. Heavier than HAPI for a 4-day build.
- **Important**: Neither HAPI nor Medplum reproduces Oracle's quirks (anchored searches, 4-value Encounter.status, no Subscription). A tiny Express/Fastify mock that rejects un-anchored Encounter searches and returns Oracle-shaped Bundles is more honest for the demo than a generic server. INFERRED recommendation.
- For tests against real Oracle shape, record JSON from the open sandbox (patient 12724066 etc.) as fixtures. The sandbox has no ED data (UNCERTAIN beyond my sample).

---

## 8. Integration engines and getting a feed approved

- **What NS Health uses is unknown.** No public source names Rhapsody, Cloverleaf, InterSystems/HealthShare, Mirth or Oracle's Open Engine for OPOR. Searches of opor.nshealth.ca and news turned up nothing about integration architecture (UNCERTAIN). Public facts: OPOR is Oracle Health under a 10-year contract (https://www.canhealth.com/2023/02/01/nova-scotia-announces-10-year-contract-with-oracle-cerner/); the Provider Portal is a clinical viewer integrated with the CIS and legacy systems; Enterprise Imaging (PACS) and PowerScribe "remain in place and seamlessly integrate" (https://opor.nshealth.ca/?p=255 and related OPOR pages, from search snippets); private clinic EMRs will have "no interfacing or connection" with OPOR-CIS.
- **Oracle-side engines** (secondary sources): Open Engine and OPENLink; hospital-side engines commonly Mirth/NextGen Connect, Rhapsody, Cloverleaf. A third party normally receives a _routed copy_ from the hospital's engine over MLLP on a VPN or private link, not a direct Millennium connection. INFERRED from https://nirmitee.io/blog/mirth-connect-and-cerner-integration/.
- **Typical approval path** (from the same source plus Vital's published onboarding): (1) identify which interfaces the hospital already licenses (Oracle licenses interfaces individually, often FTE-based; no public price list); (2) get the hospital's outbound ADT/ORM/ORU spec and synthetic sample messages; (3) agree engine, connectivity (VPN, IP allow-list, TLS) and who supports it; (4) a **test domain** with test traffic; (5) network-link approval and a privacy agreement (in NS: PHIA information-sharing/research or service agreement, privacy impact assessment; BAA is the US term). Hospital time, not code, is the bottleneck. Treat as INFERRED.
- **Feed scoping to ask for:** ED facilities only, filtered by location (Vital's model), exclude confidential/VIP/protected patients at source, minimum fields (no diagnoses, no PV2-3 reason, no OBX values), and a de-identified/synthetic test stream first.
- NS-specific pathway: Nova Scotia Health Innovation Hub runs vendor pilots (Virtual Hallway, MDClone, Virtual Emergency NS) (https://innovationhub.nshealth.ca/news-and-updates/nova-scotia-health-launches-pilot-program-virtual-hallway and https://innovationhub.nshealth.ca/projects/virtualemergencyns). I found no OPOR-specific third-party integration process there. UNCERTAIN.

---

## 9. Design implications for VeriCare

1. **Fix the FHIR polling design.** Un-anchored `Encounter?_lastUpdated=ge` is rejected. Poll per known patient (`Encounter?patient={id}&status=in-progress&_count=...`) or per `account`/`identifier`, with the patient set discovered from an ADT feed or a registration event. Realistically **HL7 v2 is the discovery source; FHIR is a verification/enrichment path** (confirm encounter status, practitioner assigned, ServiceRequest/DiagnosticReport status). Update the "Two ways in" paragraph and the FHIR mapper tests accordingly. Make the simulator's FHIR facade reject un-anchored searches.
2. **Treat location as the primary ED-state signal and build a location-change detector** that works on A02, A08, A09, A10 alike (diff PV1-3 against the last known and PV1-6). Config table mapping NS location codes to {waiting, triage, exam room, hallway, resus, fast track, discharge lounge}. Be ready for room/bed to arrive only via a separate extract (Cerner CCL), per Vital's documentation.
3. **CTAS has no standard home.** Make the CTAS source pluggable (OBX code, PV2-25, PV2-40, Z-segment, FHIR Observation) with "CTAS unknown" as a first-class value that suppresses estimates, same as CTAS 1-2. `Encounter.priority` is Code Set 3 admission type ("Emergency"), not CTAS; don't map it.
4. **Confidentiality: fail closed on every available signal.** Treat as restricted if ANY of: PV1-16 set, PD1-12 = Y, PV2-22 = Y, PV2-21 non-default, ARV segment present, FHIR `hospitalization.specialCourtesy` present, `meta.security` present, `deceasedBoolean/DateTime` or PID-29/30, history-of-violence/"Opt Out Confidential Registration" style alerts if the feed carries them, plus _unexpected disappearance_ of an encounter (security filtering is silent in FHIR). Add `A40/A34` merge handling: on merge, freeze the journey and re-verify, never silently join.
5. **Status derivation is ours.** The 13+ FirstNet throughput states are not exposed anywhere public; keep the VeriCare journey states coarse (arrived, triaged, waiting, being seen, tests in progress, decision made/waiting for bed, left) and tolerate missing or reordered messages. "Seen by provider" = first non-empty PV1-7 / ATND participant (INFERRED, validate with NS Health). "Tests in progress" uses ORM/ORU order status only.
6. **Order/result status only.** Strip OBX, `DiagnosticReport.result`, and PV2-3 reason at the adapter boundary so values can never reach the gate. Request the narrowest scopes: `system/Encounter.read`, `Patient.read`, `Location.read`, `ServiceRequest.read`, `DiagnosticReport.read`.
7. **Pilot ask to NS Health, in this order:** (a) ED-only ADT routed copy over MLLP/TLS with PV1-3/6/7/16/19/44/45, PD1-12/ARV, PID-29/30, merge events; (b) ORM/ORU status-only; (c) the CTAS representation; (d) a test domain and synthetic stream; (e) written scope excluding restricted patients at source. Don't ask for FHIR bulk or an Oracle system account until (a) is agreed, since FHIR gives only 4 encounter states and limited history.
8. **Historical data for estimate training** is better sourced from NS Health's ED reporting extract (arrival, triage, provider seen, departure timestamps by CTAS) or by recording the live ADT feed. Bulk `$export` of Encounter has no confirmed per-stage timestamps. For the hackathon, keep the synthetic month.
9. **Engineering stack:** `@medplum/hl7` (MLLP server/client) + `@medplum/core` `Hl7Message` for parsing, `@medplum/fhirtypes` for types; `node-hl7-client/server` as fallback. Build the HL7 simulator as a real MLLP client sending the sample messages in section 4.5 so the receiver path is exercised end-to-end. Use idempotency on MSH-10 and handle out-of-order and duplicate events (A08 floods, A11-A13 reversals).
10. **Rate limiting and retries** for the FHIR path: respect 429 with 1/2/4 s backoff, cache tokens, keep poll set small (active ED encounters only), and stop polling on A03.
11. **Pitch wording:** say "Oracle publishes no public ED-event spec; we implemented the standard HL7 v2 ADT/ORM/ORU and FHIR R4 shapes, mapped location and acuity through site-configurable tables, and the first pilot task is validating the NS Health spec." Do not claim FirstNet statuses are available; claim derivation from location and order events, as Vital does.

## 10. Open questions

1. Which events does Millennium actually emit for an ED visit (A04 vs A01/A05 at arrival, A02 vs A08 vs A09/A10 for room moves)? Is there a distinct "ED" trigger on provider assignment or disposition?
2. Does NS Health's ADT carry room/bed in PV1-3, or is a separate location extract needed?
3. Where is CTAS in the feed (OBX, PV2, Z-segment, FHIR Observation, none)?
4. How are confidential, VIP, "no information" and security-alert patients flagged in HL7 (PV1-16, PD1-12, PV2-22, ARV, Z)? Are restricted patients filtered out of the third-party feed altogether?
5. Does Millennium production return `Encounter.statusHistory`/`classHistory` or multiple `location[]` entries per move? Does an ED visit come back as `class=EMER`?
6. Do imaging orders appear as FHIR ServiceRequest? What is the full ServiceRequest/DiagnosticReport status set in the NS build?
7. Does Millennium offer any push mechanism (FHIR Subscription, per-app Event Subscriptions) to third parties, and is it enabled for NS Health?
8. Which integration engine does NS Health use for outbound routing (Open Engine, Rhapsody, Cloverleaf, other), and who owns approval (NS Health Digital Services, Oracle, or both)? Are interface licence fees charged per feed?
9. Does NS Health allow third-party SMART system accounts in the OPOR domain at all, and what contractual route (Innovation Hub pilot, procurement, PHIA agreement) applies?
10. Oracle API access fees and Canadian data-residency terms for the Oracle Health developer program (the fees page returned 403).
11. Is the real-time feed available for rural zones (Northern, Eastern, Western) on 2026-11-14 go-live, or only QEII first?
12. I could not open the Oracle forum threads on Subscriptions and on bulk-polling encounters (timeouts); worth retrying for Oracle staff answers.
