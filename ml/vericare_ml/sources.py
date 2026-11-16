"""Published figures the simulator is anchored to, with where each came from.

`status` follows docs/research: "confirmed" was read in the source, "secondary"
came from a summary of it, "inferred" is our own assumption with no source.
Anything inferred is a tuning knob, not evidence.
"""

from __future__ import annotations

NS_REPORT = "https://novascotia.ca/dhw/publications/emergency-departments-accountability-report-2023-24.pdf"
ONTARIO_AG = "https://www.auditor.on.ca/en/content/annualreports/arreports/en23/AR_emergencydepts_en23.pdf"

ANCHORS: dict[str, dict] = {
    # Calibration targets for the Nova Scotia reference department.
    "ns_mean_wait_min": {
        "value": 178, "status": "confirmed", "source": NS_REPORT,
        "note": "NS Health 2023-24: average 2.96 h from triage to an ED clinician.",
    },
    "ns_lwbs_share": {
        "value": 0.1002, "status": "confirmed", "source": NS_REPORT,
        "note": "52,521 of 519,310 visits left without being seen.",
    },
    "ns_ctas_1_3_share": {
        "value": 0.65, "status": "confirmed", "source": NS_REPORT,
        "note": "65% CTAS 1-3, 35% CTAS 4-5. The split inside each band is inferred.",
    },
    "ns_lwbs_ctas_split": {
        "value": {"ctas2": 0.11, "ctas3": 0.459}, "status": "secondary",
        "source": "https://www.iedm.org/too-many-canadians-are-leaving-emergency-rooms-untreated/",
        "note": "Share of NS walkouts by triage level, citing CIHI.",
    },
    "ontario_wait_min": {
        "value": {"mean": 118, "p90": 257}, "status": "confirmed", "source": ONTARIO_AG,
        "note": "Ontario 2022/23 time to physician initial assessment, all triage levels.",
    },
    "ontario_bed_wait_min": {
        "value": {"mean": 780, "p90": 2100}, "status": "confirmed", "source": ONTARIO_AG,
        "note": "Ontario 2022/23 wait for an inpatient bed: average 13 h, 90th percentile 35 h. "
                "Nova Scotia publishes no figure, so this stands in for it.",
    },
    "admit_share": {
        "value": 0.12, "status": "confirmed",
        "source": "https://globalnews.ca/news/11938222/emergency-room-wait-times-cihi-report/",
        "note": "12% of Canadian ED visits end in admission (CIHI, via news coverage).",
    },
    "site_volume_per_day": {
        "value": {"halifax_infirmary": 200, "dartmouth_general": 123}, "status": "secondary",
        "source": "https://pmc.ncbi.nlm.nih.gov/articles/PMC10756006",
        "note": "Halifax about 200/day from one paper (uncertain); Dartmouth about 45,000/yr (NS Health).",
    },
    "raz_share": {
        "value": 0.30, "status": "confirmed",
        "source": "https://nshealth.ca/news-and-notices/six-rapid-assessment-zones-enhancing-access-and-reducing-wait-times-emergency-care",
        "note": "Up to 30% of patients at Rapid Assessment Zone sites; open 8-16 h a day.",
    },
    # Stage timings.
    "door_to_triage_min": {
        "value": {"median": 13, "q1": 2.9, "q3": 27.6}, "status": "confirmed",
        "source": "https://doi.org/10.1017/cem.2016.398",
        "note": "Arrival to registration, Canadian EDs (Betz et al., CJEM 2017).",
    },
    "ct_order_to_done_min": {
        "value": {"median": 108, "q1": 57, "q3": 182}, "status": "secondary",
        "source": "https://westjem.com/articles/root-cause-analysis-of-delayed-emergency-department-computed-tomography-scans.html",
        "note": "Boston tertiary ED, CT order to completion. Reporting time is added on top (inferred).",
    },
    "troponin_door_to_result_min": {
        "value": {"median": 107, "q1": 73, "q3": 148}, "status": "secondary",
        "source": "https://scholars.mssm.edu/en/publications/emergency-department-patient-volume-and-troponin-laboratory-turna-2/",
        "note": "Five US academic EDs; longer when the department is fuller.",
    },
    "consult_request_to_arrival_min": {
        "value": {"median": 55, "q1": 21, "q3": 115}, "status": "secondary",
        "source": "https://www.cambridge.org/core/journals/canadian-journal-of-emergency-medicine/article/assessment-of-consultation-impact-on-emergency-department-operations-through-novel-metrics-of-responsiveness-and-decisionmaking-efficiency/37BFD3C9C7DD952AD88F8A2D11293B6C",
        "note": "Three Canadian tertiary EDs (Lee et al., CJEM 2014).",
    },
    "xray_order_to_result_min": {
        "value": {"median": 45}, "status": "inferred", "source": None,
        "note": "No usable public source. Cross-checked against the NHAMCS increment for an X-ray-only visit.",
    },
    "ultrasound_order_to_result_min": {
        "value": {"median": 110}, "status": "inferred", "source": None,
        "note": "No usable public source. Cross-checked against the NHAMCS increment for ultrasound visits.",
    },
}

DATASETS = {
    "nhamcs": {
        "name": "NHAMCS emergency department public-use files 2018-2022",
        "publisher": "US CDC / National Center for Health Statistics",
        "licence": "US government public domain",
        "url": "https://ftp.cdc.gov/pub/Health_Statistics/NCHS/Dataset_Documentation/NHAMCS/stata/",
        "used_for": "Who arrives (age, triage level, arrival mode, hour, weekday), what is ordered, "
                    "how the visit ends, and the real time from first provider contact to the end "
                    "of the visit for each of those patients.",
    },
    "mimic_demo": {
        "name": "MIMIC-IV Clinical Database Demo and MIMIC-IV-ED Demo v2.2",
        "publisher": "PhysioNet / MIT Laboratory for Computational Physiology",
        "licence": "Open Database License (ODbL) v1.0",
        "url": "https://physionet.org/content/mimic-iv-demo/2.2/",
        "used_for": "Real specimen-collected to result-available times for ED blood tests "
                    "(100 patients, one Boston hospital).",
    },
}
