# 00 · Initial findings (first research pass, 2026-11-11)

Condensed from three earlier research agents (web search; some claims came from search snippets, not full pages). CONFIRMED = stated in a source; INFERRED/UNKNOWN = not found or our reading. Verify dates before quoting them on stage.

## OPOR program

- CONFIRMED: Oracle Health Canada holds a 10-year, ~$365M contract; OPOR replaces or integrates 50+ systems. https://news.novascotia.ca/en/2026/05/07/one-person-one-record-launch-across-central-health-zone
- CONFIRMED: Joint program of IWK Health, NS Health and the NS Department of Health and Wellness, with Oracle as vendor. https://opor.nshealth.ca/?p=196
- CONFIRMED: IWK went live 2025-12-06; Central Zone (incl. QEII) 2026-05-09; Northern, Eastern and Western zones ("Wave Three") 2026-11-14. https://news.novascotia.ca/en/2025/12/04/one-person-one-record-launch-iwk · https://physicians.nshealth.ca/topics/nova-scotia-provider-digital-health-toolkit/one-person-one-record-opor/implementation
- CONFIRMED: Components include a shared clinical record, CPOE, clinical decision support and barcode medication verification. https://www.hospitalnews.com/nova-scotia-prepares-for-provincewide-expansion-of-electronic-patient-records/
- CONFIRMED (via search summary): OPOR supports "patient flow through the department"; glossary lists an ED electronic whiteboard. https://opor.nshealth.ca/?p=255 · https://opor.nshealth.ca/?p=348
- CONFIRMED: Provider Portal will replace SHARE. https://opor.nshealth.ca/provider-portal/
- CONFIRMED: EHS paramedic record integrates with the CIS. https://opor.nshealth.ca/?p=3475
- CONFIRMED: "Patient portal access point" listed as a digital initiative, no product named. https://opor.nshealth.ca/?p=1520
- CONFIRMED (search summary): Oracle says the platform runs on Oracle Cloud Infrastructure. https://www.oracle.com/news/announcement/nova-scotia-advances-provincewide-health-transformation-2026-05-28/
- UNKNOWN: FirstNet, CareAware, HealtheLife or the Oracle Clinical AI Agent named in NS; public API/FHIR/sandbox/marketplace for OPOR; Canadian data residency; OPOR handling of confidential patients.
- CONFIRMED: NSGEU survey of 260 IWK staff: ~91% rated preparedness ≤5/10; reported delayed care, documentation errors, 83 medication errors. https://globalnews.ca/news/11829704/nova-scotia-one-person-one-record-concerns/ · https://nsgeu.ca/wp-content/uploads/2026/04/opor-member-report.pdf

## QEII Care Coordination Centre (C3)

- CONFIRMED: Aggregates patient location and needs, bed/capacity, tests and scans, transfers; tiles include ED waiting-to-be-admitted and "ED Expediter". https://nshealth.ca/care-coordination-centre-c3
- CONFIRMED (2023): GE HealthCare Command Centre platform ingesting real-time messages from STAR, Meditech, Cerner Millennium and others. https://www.canhealth.com/2023/03/03/ns-improves-care-by-deploying-command-centres/
- INFERRED: C3 likely consumes OPOR feeds now.

## YourHealthNS and NS digital health

- CONFIRMED: Residents 16+ got record access July 2024. https://news.novascotia.ca/en/2024/07/03/province-expands-access-electronic-health-records
- CONFIRMED: "Patient summary" sharing with a provider or trusted person, Nov 2025. https://news.novascotia.ca/en/2025/11/28/patient-summary-now-available-yourhealthns
- CONFIRMED: ~350–400k users in 2024; meds, labs, imaging, immunizations, visit details, mostly ~7-day delay. https://www.canhealth.com/2024/09/30/provinces-in-atlantic-canada-are-giving-patients-access-to-their-own-records/
- CONFIRMED: ED wait-time tool is facility-level, based on lower-acuity patients, hourly, 12-hour forecast, 10 large EDs. https://www.nshealth.ca/edwaittimes
- NOT FOUND: ED status, caregiver/proxy access or notifications in any public plan.
- CONFIRMED: Innovation Hub industry intake form; no OPOR-specific call found. https://innovationhub.nshealth.ca/partnering-nova-scotia-health-innovation-hub/industry-opportunities
- CONFIRMED: DHW AI scribe guidance: patient notice, express consent for recording scribes, delete streaming notes within 7 days, clinician review. https://novascotia.ca/dhw/publications/ai-scribe-for-health.pdf

## Oracle Health Millennium FHIR R4

- CONFIRMED: Open sandbox, no auth, read-only: `https://fhir-open.cerner.com/r4/ec2458f2-1e24-41c8-b71b-0e701af7583d` (tested 2026-11-11: `/metadata` 200, Encounter search returns data). https://docs.oracle.com/en/industries/health/millennium-platform-apis/mfrap/r4_overview.html
- CONFIRMED: No Flag or Subscription resource in R4; Encounter.status only planned/in-progress/finished/cancelled; Encounter search supports `_lastUpdated`, `date`, `patient`, `status`, `_count`, `identifier`, `account`; system authorization supported.
- CONFIRMED: `Patient.deceased[x]` returned if valued; `meta.security` documented only for confidential gender identity; sensitive fields filtered for patient and proxy access.
- UNCERTAIN: whether Millennium emits `class = EMER`; how CTAS, VIP and security alerts appear; ED tracking-board data model.
- Secure endpoint pattern `https://fhir-ehr-code.cerner.com/r4/{tenant}` needs Code Console registration and SMART/system scopes. https://docs.oracle.com/en/industries/health/millennium-platform-apis/millennium-authorization-framework/
- CONFIRMED: Vocera requires a real-time ADT feed (listener default port 2575). https://pubs.vocera.com/vcts/vcts_2.5.1/help/vcts_config_help/topics/vcts_hl7_overview.html
- CONFIRMED: Oracle's AI patient portal GA in the US (Oct 2026), record explainer, not family status. https://www.fiercehealthcare.com/ai-and-machine-learning/oracle-health-debuts-revamped-ai-powered-patient-portal

## Policy and precedent

- CONFIRMED: NS Health may confirm admission, room, extension and general condition to family on the day asked; patients can opt out at admission. https://www.nshealth.ca/healthinfo
- CONFIRMED: Connected Care for Canadians Act (C-72) died Jan 2025, reintroduced 2026-02-04 as Bill S-5; obligations mainly on vendors (anti-data-blocking). https://www.mccarthy.ca/en/insights/publications/legislative-update-federal-government-re-introduces-the-connected-care-for-canadians-act-as-bill-s-5
- CONFIRMED: Infoway's Shared Pan-Canadian Interoperability Roadmap; CA Core+ FHIR profiles (Encounter profile draft). https://www.infoway-inforoute.ca/en/what-we-do/connected-care/interoperability · https://simplifier.net/guide/ca-core
- CONFIRMED: CHUM caregiver SMS: 75.6% opt-in across 8,129 surgeries, 4.5/5 satisfaction (34% survey response). https://periop.jmir.org/2022/1/e36208
- CONFIRMED: Alberta MyAHS Connect proxy access needs the trusted person's own account. https://www.albertahealthservices.ca/cis/Page17840.aspx
- CONFIRMED: BC Cerner rollout had cost growth and go-live ambulance diversions. https://bc.ctvnews.ca/ambulance-diversions-underway-as-royal-columbian-hospital-attempts-smoother-tech-transition-1.7027379
- CONFIRMED: ON, BC and AB regulators issued AI scribe guidance Jan 2026 (PIAs, consent, voice data is personal information). https://iapp.org/news/a/canada-s-provincial-dpas-discuss-approach-to-medical-ai-scribe-guidance

## Wait-time prediction (first pass)

- Arora, Taylor & Mak (MSOM 2023): quantile regression forests beat rolling averages for individual ED waits. https://pubsonline.informs.org/doi/fpi/10.1287/msom.2023.1210
- Pak, Gannon & Staib (2021): ML beat rolling average by >20% MSPE; quantile regression cut large under-predictions 42%. https://pesquisa.bvsalud.org/perinatal/resource/pt/mdl-34148660
- Hamilton posts ED waits every 15 minutes. https://www.hamiltonhealthsciences.ca/?p=24616
- Ontario AG: LWBS averaged 5.3% in 2022/23. https://www.auditor.on.ca/en/content/annualreports/arreports/en23/AR_emergencydepts_en23.pdf
- NOT FOUND: Canadian precedent for individual patient-facing ED estimates.
