# 03. Individual ED wait and next-step estimation, and how to communicate it safely

Research date 2026-11-11. Public web only; no logins. Builds on `docs/design/opor-patient-tracking.md` (not re-researched: QRF > rolling average, Pak 42%, NS LWBS 10.02%).

Tags: **CONFIRMED** = read in the source named (full text, abstract, or a search-result excerpt of it; "excerpt" means I did not open the full paper). **INFERRED** = my reasoning from confirmed facts. **UNCERTAIN** = could not verify, or sources conflict.

---

## 1. Methods literature

### 1.1 Arora, Taylor & Mak (MSOM 2023), quantile regression forest (QRF)

Source: preprint PDF read in full text (extracted locally), https://arxiv.org/pdf/2006.00335 ; published version https://econpapers.repec.org/RePEc:inm:ormsom:v:25:y:2023:i:4:p:1489-1508 (MSOM 25(4):1489-1508).

- **CONFIRMED setting.** One large UK public ED ("Hospital 1"); 334,635 low-acuity patients (about 95% of attendances; minor and major injury streams), after dropping about 23% of 454,983 records for missing fields or bad timestamps. Replicated on a second UK hospital (180,715 records, 2014-2018) with the same ranking of methods. Out-of-sample period is one year.
- **CONFIRMED two-stage forecast.** T1 = registration to start of treatment, issued at registration. T2 = initial assessment to start of treatment, re-issued after initial assessment. The paper shows a patient-facing "John" example where the distribution is updated as he moves through the ED. This is the same "update at each step" pattern VeriCare needs.
- **CONFIRMED features (five groups).** Calendar (hour, weekday, holidays); demographics; staff count (inferred from staff IDs on discharges); ED operations (counts of patients in the ED and in each status such as "registered, not yet assessed", counts for all triage categories not just the target patient's, number of 4-hour and 12-hour breaches in the last 24 h, hourly lagged average waits); patient condition (presenting-problem group, resource group, triage category).
- **CONFIRMED importance.** Age was the top feature, which the authors attribute to a separate children's ward (minors waited 77 vs 90 min mean). Otherwise the top features were ED workload counts and calendar effects, plus rolling-average lags and "fluid-model" features inspired by Ang et al. Staff count did not rank highly, probably because it is collinear with diurnal volume (authors' caution).
- **CONFIRMED accuracy (minutes; T1 / T2).**

| Method                                                       | RMSE T1 / T2    | MAE T1 / T2     |
| ------------------------------------------------------------ | --------------- | --------------- |
| Empirical 4-hour rolling average (the US-practice benchmark) | 60.4 / 57.5     | 42.5 / 40.2     |
| Best empirical (k-hour window)                               | 55.9 / 53.3     | 39.8 / 37.2     |
| Quantile regression (linear)                                 | 50.8 / 49.0     | 36.0 / 33.9     |
| Q-Lasso                                                      | 51.0 / 48.6     | 37.1 / 33.0     |
| k-NN                                                         | 60.7 / 57.4     | 45.1 / 41.9     |
| **QRF**                                                      | **50.1 / 46.6** | **35.1 / 31.5** |

Distributional: CRPS about 20% lower than the 4-hour empirical benchmark and more than 10% lower than the best empirical method; QRF's gain over plain linear quantile regression was "relatively modest". Unconditional quantile coverage (fraction of actuals below the q-th forecast quantile) was close to ideal for QRF, linear quantile regression and the best empirical window, and poor for k-NN and the 4-hour empirical. The paper reports calibration curves, not an interval-coverage percentage or pinball loss.

- **INFERRED, important.** An MAE of about 31-35 minutes on a mean wait of roughly 90 minutes is still a 35% typical error even for the best model with a rich feature set and an in-hospital history. A range is the honest output, and a point is not.
- **CONFIRMED limitation.** Only low-acuity patients were modelled; high-acuity counts enter as features (they are what makes a low-acuity patient wait).

### 1.2 Pak, Gannon & Staib (Int J Med Inform 145:104303, 2021)

Sources (excerpt via search result): https://researchonline.jcu.edu.au/65500/ ; working paper https://econpapers.repec.org/RePEc:osf:osfxxx:d25se

- **CONFIRMED.** ML plus queueing/service-flow variables for low-acuity waiting-room patients; quantile regression chosen because patients perceive under-prediction and over-prediction asymmetrically. Beats the best rolling average by 18% on mean squared prediction error (MSPE) and cuts the number of patients with large under-predicted waits by 42%. The authors advocate reporting the **percentage of under-predicted observations** as a metric. (This is the metric VeriCare's estimate log should lead with.)
- **UNCERTAIN.** I did not read the full text, so I have no per-feature results or interval coverage from it.

### 1.3 Ang, Kwasnick, Bayati, Plambeck & Aratow (Q-Lasso), M&SOM 18(1):141-156, 2016

Sources: https://pubsonline.informs.org/doi/fpi/10.1287/msom.2015.0560 ; https://www.gsb.stanford.edu/insights/why-hospital-er-wait-times-are-often-wrong (excerpts via search results). Note the author list differs from "Ang, Chen, Lam..." in the brief; the search records list the five above.

- **CONFIRMED.** Four US hospitals; Lasso regression whose candidate predictors include **fluid-model estimators** (workload ahead / processing rate, i.e. queue length divided by service rate), so the queueing structure enters as a feature. Over 30% lower MSPE than the best rolling average at San Mateo Medical Center. The commonly used rolling-average method was off by up to about 1.5 hours at one site (Stanford GSB summary).
- **UNCERTAIN.** One secondary source says it errs toward over-estimating; another says its gain comes from fixing under-estimation. These are compatible only if the baseline under-estimated and Q-Lasso is closer to unbiased; I could not verify from the paper.
- **CONFIRMED (via Arora et al.).** Q-Lasso gives a mean forecast only; the Arora authors "were not able to produce probabilistic forecasts from Q-Lasso", which is why it is a point-only baseline in the table above.
- **Relevance.** This is the direct academic precedent for the MVP's "patients ahead / throughput" feature. Arora et al. also use Q-prefixed fluid features, and they ranked high.

### 1.4 Sun et al. (Ann Emerg Med, 2012) and Ding et al. (2010)

- **UNCERTAIN.** I could not retrieve the Sun et al. 2012 paper or abstract. The only trace is a secondary description in an Oxford manuscript (https://users.ox.ac.uk/~mast0315/ED_MSOM.pdf): Sun et al. use triage-time data and quantile regression to predict the median and 95th percentile of triage-to-consultation time. Treat as a pointer, not a finding.
- **CONFIRMED (same secondary).** Ding et al. (2010) used quantile regression for treatment, boarding and waiting-room time at the 10th/50th/90th percentiles. Quantile regression for ED waits predates the 2021-23 papers.

### 1.5 Calibration-first / vendor evidence from Canada: ERstat

Source (read): https://erstat.ca/how-predictions-work . This is a live, public Canadian ED wait nowcast, so it is the closest public analogue. Vendor-style page; self-reported.

- **CONFIRMED method.** LightGBM quantile regression ensemble (lower, median, upper), refreshed every 15 min, retrained daily; **Mondrian split conformal prediction** widens intervals by province group and rurality, falling back to a global widening when a cell has fewer than 5 calibration hospitals. Features are only structural plus hour-of-week (no current-state data, because the hospitals it covers publish nothing). If the interval is wider than 360 min it shows "Wait is unpredictable right now" instead of a range. A classifier abstains on about 17% of hospitals.
- **CONFIRMED, the key finding for us.** The conformal target was 80% coverage of _published_ waits, and the page reports about 83% on that. But against **finished visits** at hospitals with no feed, the interval covered about **22%** of 155 visits (November 2026), and patients waited "roughly half again as long" as posted figures. The page itself says published-wait coverage "does not describe an individual's experience".
- **INFERRED lesson.** Conformal coverage guarantees hold only relative to the label you calibrate on. If the label is the facility's published average rather than each patient's actual remaining time to first assessment, the interval is calibrated to the wrong quantity. VeriCare must calibrate on **per-patient realised remaining wait**.
- **CONFIRMED.** ERstat converts whole-visit durations (NB, QC) to time-to-physician with a ratio of 0.492 measured from 507,811 paired readings at 12 BC hospitals, with a range of 0.258-0.649 by hospital. Definition mismatches (what "wait" means) are a first-order error source.

### 1.6 Conformal prediction for calibrated intervals

- **CONFIRMED.** Conformalized Quantile Regression (CQR; Romano, Patterson & Candes 2019, https://arxiv.org/abs/1905.03222): fit quantile regressors, then use a held-out calibration set to widen or narrow the interval so that finite-sample marginal coverage holds regardless of the base model's accuracy, while keeping interval width adaptive.
- **CONFIRMED.** Adaptive Conformal Inference (Gibbs & Candes 2021, https://arxiv.org/abs/2106.00170): tracks one parameter online, adjusting the miscoverage level after each hit or miss, to achieve long-run coverage under distribution shift (data need not be exchangeable). Relevant because ED load regimes shift within a day.
- **CONFIRMED (search excerpt).** A 72-ED study in Ile-de-France used conformal post-processing for arrivals and hospitalisations (https://hal-cnrs.archives-ouvertes.fr/hal-04539380v1), so conformal in ED forecasting is not exotic, but I found **no peer-reviewed conformal paper for individual ED waiting time**. ERstat is the only deployed example.
- **INFERRED caveats.** Marginal coverage is an average over patients; it does not guarantee 80% for CTAS 3 at 9 pm. Hence stratify (Mondrian) by CTAS band and time block, as ERstat does, and monitor coverage per stratum.

### 1.7 Queueing models

- **CONFIRMED (search excerpt).** Exact mean per-class response times exist for preemptive-resume M/M/m priority queues (https://pubsonline.informs.org/doi/10.1287/opre.31.3.456), and Cobham's (1954 / 1953) formulas cover the non-preemptive (head-of-line) case, including M/M/c with several classes. A thesis notes that in a preemptive queue "waiting time" is ambiguous because a patient can be bumped back repeatedly, so one should model response time per class (https://thesis.eur.nl/pub/16543/vanVianen.pdf). I did not retrieve explicit formulas.
- **INFERRED.** ED first assessment is closer to non-preemptive for the _start_ of assessment (no one is bumped out of an exam room by a later arrival for first assessment), but a higher-acuity arrival does jump the waiting line. So "non-preemptive priority; later higher-priority arrivals jump ahead" is the right mental model for time-to-first-assessment. M/M/c assumptions (Poisson arrivals, exponential service, known c) are weak here: staffing, fast tracks and bed blocking all break them, which is why the literature uses queue-derived quantities as _features_ (Ang; Arora's Q-features) rather than as the forecast. For a 4-day MVP the fluid approximation in section 5 is the practical choice.

### 1.8 Which features matter (synthesis)

| Feature                                                                                  | Evidence                                                                                                                                                                                                                                                | Status                                            |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Number of patients waiting ahead / in each status; workload counts for all acuity levels | Top features in Arora; basis of Ang's fluid estimators; Pak uses queueing/service-flow variables                                                                                                                                                        | CONFIRMED                                         |
| Recent throughput (assessments started in last hour); lagged average waits               | Rolling/lag features ranked high in Arora                                                                                                                                                                                                               | CONFIRMED                                         |
| Hour of day / day of week / holidays                                                     | Waits peak about 8pm-2am and at weekends/Mondays at the UK site                                                                                                                                                                                         | CONFIRMED                                         |
| Acuity (triage category)                                                                 | Used by Arora, Pak; essential for priority                                                                                                                                                                                                              | CONFIRMED                                         |
| Staff count                                                                              | Not a top feature once volume is in (collinear)                                                                                                                                                                                                         | CONFIRMED (authors caution)                       |
| Boarding count / admitted-held patients                                                  | Not in Arora's top list. Arora's ops features include counts in different statuses and 4h/12h breach counts as proxies. Boarding as a direct feature is **UNCERTAIN**; mechanism (boarders consume beds and nurses so slow the front end) is plausible. | INFERRED                                          |
| Arrivals in the last hour                                                                | Used in Pak/Ang-type feature sets; Arora's workload features.                                                                                                                                                                                           | INFERRED (exact variable not verified in Pak/Ang) |
| Age                                                                                      | Top feature at a site with a separate paediatric stream; site-specific                                                                                                                                                                                  | CONFIRMED                                         |

### 1.9 Next-step estimation: admission probability and test turnaround

- **Admission at triage (CONFIRMED).** Hong, Haimovich & Taylor, PLOS ONE 2018, 560,486 visits at 3 hospitals, admission rate 29.7%: triage-only variables give AUC 0.87 (logistic regression, XGBoost, DNN alike); adding history gives 0.91-0.92 (https://www.ncbi.nlm.nih.gov/pmc/articles/PMC6054406/). A Dutch multi-centre study (de Hond et al.) reports AUC 0.84 at triage, 0.86 at about 30 min and after about 2 h (https://scholarlypublications.universiteitleiden.nl/access/item%3A3643736/view, excerpt). **INFERRED:** a simple logistic model on CTAS + age + arrival mode + complaint is nearly as good as deep models, so it suits the MVP; but VeriCare should not tell patients "you will probably be admitted" (see section 7). Use it internally to suppress estimates or to route to staff, not as patient-facing prediction.
- **Troponin / lab turnaround (CONFIRMED).** Multicentre US study at five academic EDs: median troponin turnaround 107 min (IQR 73-148); each doubling of ED occupancy lengthened it (https://scholars.mssm.edu/en/publications/emergency-department-patient-volume-and-troponin-laboratory-turna-2/ , excerpt). Canadian root-cause study of patients discharged after serial troponins: median lab processing 44 min; median second-order-to-discharge 90 min (IQR 65-120) (https://cambridge.org/core/journals/canadian-journal-of-emergency-medicine/article/root-cause-analysis-of-delays-to-discharge-for-patients-held-for-serial-cardiac-troponin-levels/A66ED83F9409BCCF2A9F7FD861F740E9). A lab that met its 60-min troponin target about 90% of the time met the ED order-to-report target only 31% of the time; the interval _before_ ordering predicted length of stay (mlo-online summary, https://www.mlo-online.com/home/article/13004003/changing-viewpoints-of-lab-turnaround-timespreanalytical-factors-take-precedence-in-ed-los-of-chest-pain-patients). **INFERRED:** "test turnaround" must be measured order-to-result-available _as seen by the ED_ (ORM -> ORU in the event log), not lab-internal time, and it depends on census. I found nothing usable on CT/imaging turnaround or on LOS-after-results; that stays **UNCERTAIN**.
- **MIMIC-IV-ED and LLM/ML, 2022-2026 (CONFIRMED via excerpts).** The public MIMIC-IV-ED benchmark (Xie et al., Sci Data 2022; https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9610299/) defines hospitalisation, critical-outcome and 72-hour reattendance tasks, **not wait time**. A 2025 Frontiers paper on MIMIC-IV-ED length of stay (short <=4.5 h vs long) got best AUC 0.730 with gradient boosting (https://www.ncbi.nlm.nih.gov/pmc/articles/PMC11861435/). ClinicalBench (https://arxiv.org/pdf/2411.06469) finds traditional ML (e.g. XGBoost) beat LLM/transformer baselines on MIMIC-IV length-of-stay prediction. ED-Copilot (https://arxiv.org/html/2402.13448v1) uses a language model plus RL to choose which tests to order to cut wait time; it is about test selection, not forecasting a patient's wait. I found **no 2023-2026 paper that forecasts individual time-to-provider with an LLM**, and **no quantile-gradient-boosting ED wait paper** beyond ERstat's LightGBM. Note MIMIC-IV-ED is a US single-system dataset and has no staffing/census-by-status feed, so it is a poor stand-in for NS history anyway.
- **INFERRED.** The data say: gradient boosting or QRF on structured queue features is the state of the art; LLMs add nothing for the number and add risk. This supports the existing design rule that code, not the model, computes the range.

---

## 2. Evaluation methodology

- **Primary metrics (CONFIRMED as used in literature):** pinball (quantile) loss per quantile; CRPS (Arora); calibration/unconditional coverage curves (Arora); MAE/RMSE of the median (Arora); **percentage of under-predicted observations and large under-predictions** (Pak). For an _interval_ product, report empirical coverage of the shown [lo, hi] plus the split of misses (actual > hi vs actual < lo).
- **Pinball loss definition (INFERRED, standard):** for quantile tau and forecast q, loss = max(tau*(y-q), (tau-1)*(y-q)). Average over patients for tau = 0.1, 0.5, 0.9.
- **Why under-prediction rate matters most (CONFIRMED rationale in Pak):** patients experience under-prediction as a broken promise. Track `P(actual > hi)` separately and target it at <= 10% (for an 80% interval), and watch it per CTAS and hour.
- **Backtesting with an event log (INFERRED procedure).**
  1. Replay events in time order; at each recompute trigger, produce the estimate **using only events with timestamp <= t** (no look-ahead; use event-ingest time, not corrected timestamps).
  2. Label = `assessmentStart - t` for that snapshot (remaining wait), not arrival-to-assessment, so the label matches what was shown.
  3. Evaluate both at triage and at later snapshots (e.g. every 30 min after arrival). Evaluating only at arrival hides the bias that patients who have already waited a long time behave differently.
  4. Time-ordered split: calibrate on days 1..d, test on d+1..; never random-split rows (queue state is autocorrelated).
  5. Report coverage and under-prediction by CTAS, hour block, and census tercile; report the **LWBS-censored** cases separately (see below).
  6. Compare against two baselines: the 4-hour rolling average of recent first-assessment waits (Arora's practice benchmark) and "NS-style" hourly facility median. Beating them by about 10-20% on pinball loss is in line with the literature (Arora CRPS; Pak/Ang MSPE).
- **Censoring (INFERRED).** Patients who leave without being seen have no assessment time. Dropping them biases waits downward (the long waiters vanish). Keep their elapsed time as a right-censored lower bound; at minimum count a patient whose LWBS time already exceeds `hi` as a miss.
- **Priority jumps (CONFIRMED mechanism, INFERRED handling).** Arora's features include counts for all triage categories "because the waiting time depends on the number of high-acuity patients currently in the ED queue". For the tagged patient, only _future_ higher-priority arrivals are unknown, and they are the main source of under-prediction. Handle by (a) including a term for the expected arrival rate of more urgent patients in the denominator (section 5), (b) stratified quantile widening so that busy-and-high-acuity-heavy hours get wider upper bounds, (c) an overrun trigger (section 5.6) that fires when the clock passes the shown upper bound, (d) ACI-style adaptation of the miscoverage level when recent misses cluster.
- **Synthetic-data honesty (INFERRED).** If the simulator generates waits from the same model used to estimate, nominal coverage will look perfect by construction. For the MVP, say "coverage on synthetic data validates the pipeline, not accuracy", and inject a regime shift (surge in the replayed shift) to show the adaptive widening and overrun logic. Pilot numbers must come from real OPOR history.

---

## 3. Communicating uncertainty (evidence)

### 3.1 Ranges vs point estimates

- **CONFIRMED.** van der Bles et al., PNAS 2020, five experiments, 5,780 participants plus a BBC field study: communicating a numeric range slightly lowered trust in the number and did not significantly change trust in the source; verbal "this is uncertain" statements lowered trust more (https://research.rug.nl/en/publications/the-effects-of-communicating-uncertainty-on-public-trust-in-facts/ ; summary excerpt). Participants noticed the uncertainty.
- **CONFIRMED (excerpt).** Joslyn & LeClerc, J Exp Psychol Appl 2012: uncertainty forecasts led to better decisions than deterministic forecasts and softened the damage from forecast errors; trust went up when uncertainty was acknowledged; categorical advice plus uncertainty worked best (https://www.sci.utah.edu/~kpotter/Library/Papers/joslyn:2012:UFID/index.html). Weather decisions, not clinical, so transfer is **INFERRED**.
- **INFERRED design rule.** Numeric range plus a decision cue ("tell the nurse if you feel worse") is better supported than a point estimate or a purely verbal hedge.

### 3.2 Does wait information improve satisfaction, anxiety or LWBS?

| Study                                                                                                                     | Design                                                                           | Finding                                                                                                                                               | Tag                                |
| ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| McCarthy et al., Acad Emerg Med 2011 (fast track, Johns Hopkins-affiliated, N=1,011) https://read.qxmd.com/read/21762230/ | RCT: usual care vs process information vs process info + predicted service times | **No effect on any satisfaction outcome.** Satisfaction tracked actual waiting-room time (each +10 min: OR 0.92 for "very good") and individual staff | CONFIRMED                          |
| Alrajhi et al., Saudi Med J 2020 (N=100) https://smj.researchcommons.org/journal/vol41/iss8/16                            | RCT: wait estimate vs none                                                       | No difference in wait satisfaction (5.92 vs 5.45 /10, p=0.476); about 70% said they wanted estimates. Anxiety and LWBS not reported                   | CONFIRMED                          |
| Thompson et al., Ann Emerg Med 1996 (N=1,631, phone survey) https://pubmed.ncbi.nlm.nih.gov/8953956/                      | Observational                                                                    | Actual wait did not predict satisfaction; perceived wait, information delivery and staff expressiveness did                                           | CONFIRMED (excerpt)                |
| Calder-Sprackman et al., 2021 needs assessment (Emerg Med Int) https://doaj.org/article/57d546968b6842a081379986bda25544  | Survey                                                                           | 81.3% wanted to know ED wait times before arriving                                                                                                    | CONFIRMED (excerpt)                |
| Shah et al. 2015 (pre-post)                                                                                               | Pre-post                                                                         | Patients given wait info more satisfied; delay-communication itself not significant                                                                   | UNCERTAIN (secondary excerpt only) |
| Ehrler et al., JMIR Med Inform 2022 (Geneva, N=110) https://medinform.jmir.org/2022/9/e34488/PDF                          | Survey of an SMS "wait outside, get recalled" system for low-acuity patients     | 97 of 100 patients satisfied; staff saw added workload; LWBS not reported                                                                             | CONFIRMED                          |

- **INFERRED summary.** Trial evidence that _giving an estimate_ raises satisfaction is negative or null in the two RCTs I found (one large, one small); satisfaction follows the actual wait and the quality of staff interaction. Patients nevertheless want the information. Evidence on anxiety and LWBS from estimates is **absent** in what I found. So claim "patients want to know" (supported), not "estimates reduce LWBS" (unsupported). The pilot should _measure_ it.

### 3.3 Posted wait times: behaviour and accuracy

- **CONFIRMED.** Strobel et al., Ann Emerg Med 2021;78(4):465-473 (Hamilton, Canada; 7 sites): after a public wait-time website launched, a 60-minute rise in a site's wait was associated with about 10% fewer arrivals there over the next hour, stronger at community hospitals and urgent-care centres; waits at one site were associated with more arrivals at others; effect appears only when waits are very high (https://hamiltonhealthsciences.ca/?p=38584 ; authors/abstract via Europe PMC record of DOI 10.1016/j.annemergmed.2021.04.009). **This measures facility choice by people at home, not LWBS and not individual patients in the waiting room.** It is often miscited as a satisfaction/LWBS study.
- **CONFIRMED.** Jouriles et al., Acad Emerg Med 2013;20(4):421-3 (8,889 patients, 4 EDs, one system): posted vs actual differed by mean 31.5 min (SD 61.2) at the busy teaching ED and 1.3-8.6 min at small EDs. Accuracy worsens with volume and flow complexity.
- **CONFIRMED (excerpt).** Rathagirishnan et al., CJEM 2022;24(5), "About time!" scoping review: 60 of 647 Canadian EDs (9.3%) had real-time public displays; most show an average wait; effectiveness and optimal content "need to be determined" (https://link.springer.com/article/10.1007/s43678-022-00301-4 ; abstract via Europe PMC). This is the CJEM source on posted waits that the brief points at.
- **CONFIRMED (excerpt).** Ovens, Affleck & Letovsky, "On posting wait times: an alternate view", CJEM 2014;16(1) argues against posting (https://www.cambridge.org/core/journals/canadian-journal-of-emergency-medicine/article/on-posting-wait-times-an-alternate-view/10D8B482B58BAB2C0210104D20B55B9E). I could not read the body; the argument is only known from a table-of-contents description and a commentary (https://canadiem.org/publishing-wait-times-for-good-or-evil/) that raises self-triage misinterpretation and strain on EDs as a safety net.
- **CONFIRMED (excerpt, US).** A legal commentary warns that publicly or verbally sharing estimates may push patients to self-triage and leave before the medical screening exam required by EMTALA; recommends accuracy, regular updates and disclaimers (https://www.hortyspringer.com/?p=79920). US law, not Canadian; I found no Canadian equivalent statement. **UNCERTAIN transfer.**
- **CONFIRMED (excerpt).** Patients' own waiting-time guesses are inaccurate (Thompson et al. companion, "How accurate are waiting time perceptions...", Ann Emerg Med 1996), and predicted vs actual waits in one Emerg Med J study differed by an average of 29 min on a 64.6-min mean (https://www.beckershospitalreview.com/care-coordination/study-how-accurate-are-predicted-ed-waiting-times/ ; study not directly read).

### 3.4 Harms

- **False reassurance and over-promise (INFERRED from sources above).** Posted figures run low at busy sites (Jouriles), rolling averages under-predict (Pak 42% large under-predictions; Stanford summary of Ang), and ERstat's own check showed patients wait "half again as long". An over-short range makes patients feel lied to and may erode trust; an over-long range may drive LWBS.
- **Delaying care / self-triage (CONFIRMED mechanism in commentaries, no outcome data):** Horty Springer EMTALA piece; Kwok commentary at canadiem.org.
- **LWBS outcomes (CONFIRMED).** Ontario 2003-2007 (Guttmann et al., BMJ 2011): LWBS patients were not at higher risk of short-term adverse events (https://pubmed.ncbi.nlm.nih.gov/21632665/). Ontario 2014-2023 (McNaughton et al., JACEP Open 2024): 7-day death or hospitalisation 3.4% vs 2.9% baseline (aRR 1.14), with confounding caveats (https://doaj.org/article/b7fd202f220f41b9af9d5ea1d28bc840). So the harm of LWBS is uncertain and probably small for most, but may be rising, and the ones at risk are the sicker patients VeriCare suppresses estimates for anyway.

### 3.5 Update frequency

- **UNCERTAIN, no direct evidence.** I found no study of the optimal frequency of ED wait updates. Related facts: ERstat refreshes its estimate every 15 min (CONFIRMED); Arora's pattern is to update at _state changes_ (registration, assessment) (CONFIRMED); the Geneva SMS system sent up to four recall texts, with follow-up if the patient did not return within 20 min (CONFIRMED, excerpt). Thompson 1996 suggests _information delivery and perceived wait_ matter, which supports a "we have not forgotten you" cadence (INFERRED).
- **Recommendation (INFERRED).** Event-driven pushes, a "still waiting, no change" touch at 60-90 min, and pull-on-demand for everything else.

### 3.6 Evidence on interventions that reduce LWBS

- **CONFIRMED (excerpts).** Systematic reviews rate **fast track / streaming**, **provider-in-triage / team triage** and rapid assessment as the interventions with the most consistent LWBS reductions: Grant et al., CJEM 2020 (https://www.cambridge.org/core/services/aop-cambridge-core/content/view/AB1FA3D762D2FE9A771840AB84526ACC/S1481803520004261a.pdf/throughput-interventions-to-reduce-emergency-department-crowding-a-systematic-review.pdf); Alenezi et al. 2023 (team triage effect on LWBS "relatively strong", other interventions limited; https://zenodo.org/records/8314755/files/Systematic%20review%20of%20triage-04092023-1.pdf); Youssef et al., Acad Emerg Med 2024 meta-analysis of 20 RCTs (triage liaison physicians and point-of-care testing); a rapid-assessment-zone review in which the one RCT showed no significant LWBS reduction (RR 0.93, 95% CI 0.77-1.12) while non-randomised studies showed RR 0.68 (https://pubmed.ncbi.nlm.nih.gov/21515880/). Most evidence is observational.
- **No randomised or controlled trial of texting/waiting-room updates with LWBS as the outcome was found.** Evidence for texting is: the Geneva satisfaction survey above; a 2025 urgent-care poster where automated post-LWBS texts reached 5,720 encounters, 76.8% opened the link, but only 10 patients (6.3% of those reached) rebooked (https://urgentcareassociation.org/wp-content/uploads/POSTER-Mangas-HuntDont-Lose-the-Patient-Amplifying-Access.pdf; excerpt); and **vendor** case studies (Vital: West Tennessee Healthcare 36% LWBS decrease, Allina reduction; uncontrolled; https://vital.io/resources/case-study/west-tennessee-healthcare-slashes-lwbs-rates-generating-3x-on-investment). Treat vendor numbers as UNCERTAIN.
- **INFERRED.** The strongest plausible VeriCare LWBS lever is not the estimate itself but the **LEAVING -> nurse alert -> reassessment** loop, which acts like a mini "triage reassessment" intervention. That is testable in the pilot and has a clear outcome.

---

## 4. Precedent products (what they show)

| Product                                                     | What the patient sees                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Source                                                                                                                                                                                                                                                              | Tag                                                                          |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **Vital** (ER Advisor; CHLA; Allina)                        | Patient-specific estimate, text-invited web page, no app download. Shows an individual estimate for waits of **0-2 h**; for **>3 h shows a live "how busy" picture instead of a number**; acknowledges delays automatically when a patient waits too long. Inputs: ESI, chief complaint, vitals, free-text triage notes, fast-track open?, triage bays, bed availability, arrivals/departures, other patients' severity, time-of-day. Estimates stages: triage, bed, treatment start, tests, disposition. Claims >90% accuracy (94% "in the wild"), 10% higher likely-to-recommend. Range vs point not stated | https://vital.io/solutions/wait-times ; https://www.allinahealth.org/about-us/news-releases/2022/allina-health-introduces-eradvisor-to-improve-patient-experience-in-emergency-room-wait-times (excerpt)                                                            | Product behaviour CONFIRMED; accuracy claims UNCERTAIN (vendor, undefined)   |
| **MyChart "Your Emergency Visit" (Epic; UCLA Health)**      | Text/email link after arrival; page shows reason for visit, **care-progress steps** ("Waiting for Treatment Area", "Provider Assessment"), care team, results, meds; **no wait estimate mentioned**                                                                                                                                                                                                                                                                                                                                                                                                           | https://www.uclahealth.org/emergency/mychart/edvisit/tipsheet                                                                                                                                                                                                       | CONFIRMED                                                                    |
| **Epic "On My Way" (Hartford, Houston Methodist, Sentara)** | Pre-arrival: nearest ED with approximate wait; patient taps "on my way" so the trackboard shows an inbound patient. Sentara defines the estimate as arrival to provider. Hartford pilot reported a **13-minute drop in median wait** at one site (hospital-reported)                                                                                                                                                                                                                                                                                                                                          | https://epic.com/epic/post/epic-way-reduces-ed-wait-times-13-minutes (title only; page body not retrievable); https://hmslnews.houstonmethodist.org/on-my-way-all-eds ; https://www.sentara.com/aboutus/news/articles/sentara-posts-emergency-department-wait-times | Features CONFIRMED (excerpts); 13-min figure UNCERTAIN (not read in primary) |
| **NHS apps (WaitLess, NHSquicker, Hull)**                   | Site-level live wait and number waiting, not an individual place in line; reviews mixed ("wait times unknown")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | https://www.shropshiretelfordandwrekin.nhs.uk/wp-content/uploads/WaitLess-Factsheet.pdf ; https://apps.apple.com/gb/app/nhsquicker/id1312817040                                                                                                                     | CONFIRMED (excerpts)                                                         |
| **NHS App waiting-list position; St George's queue pilot**  | Officials said the NHS App would **not** show an exact queue number because factors alter where a patient sits; St George's got a 2019 grant to pilot a visible electronic queue (number on screen) to ease worry; no results found                                                                                                                                                                                                                                                                                                                                                                           | https://www.cityam.com/?p=2326289 ; https://healthinnovationnetwork.com/blogs/improving-patient-and-staff-experience-and-safety-with-queue-management-software-in-the-emergency-department/                                                                         | CONFIRMED stated intent; outcome UNCERTAIN                                   |
| **Australian apps (WA Perth, ACT, Qld Open Hospitals)**     | Site-level waits; WA combines posted waits with travel time; ACT's app now shows only expected wait before being seen and no longer shows treatment time                                                                                                                                                                                                                                                                                                                                                                                                                                                      | https://www.itnews.com.au/news/wa-govt-launches-hospital-waiting-times-app-for-perth-419540 ; https://region.com.au/canberra-health-services-overhauls-app-changes-how-emergency-wait-times-are-displayed/991901/                                                   | CONFIRMED (excerpts)                                                         |
| **ERstat**                                                  | Range, "most likely" anchor, abstain text when too wide (>360 min)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | https://erstat.ca/how-predictions-work                                                                                                                                                                                                                              | CONFIRMED                                                                    |
| **Hamilton wait-time site**                                 | Current wait per site for 7 EDs/UCCs, hourly volume graphs, type of care                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | https://hamiltonhealthsciences.ca/?p=38584                                                                                                                                                                                                                          | CONFIRMED                                                                    |

- **INFERRED patterns worth copying:** (1) an upper display cap, with a "busy, can't give you a number" fallback (Vital >3 h, ERstat >6 h); (2) progress **steps** as the backbone, with the estimate secondary (MyChart); (3) stage-specific estimates (Vital, Arora's T1->T2); (4) abstaining when the model has little to go on (ERstat).
- **INFERRED gap.** No public product I found does what VeriCare proposes for a **consented family member** through voice/SMS with a conformal-style range. Epic/MyChart proxies exist but I did not verify wait features for them.

---

## 5. A concrete 4-day MVP algorithm (TypeScript)

Design choice: **queue-derived point estimate x empirical (conformal) quantile multipliers**. It uses the strongest known feature (patients ahead / throughput, Ang; Arora's Q-features), turns it into a calibrated range with a split-conformal quantile (CQR-style logic, ERstat-style Mondrian strata), and needs no ML library.

### 5.1 Scope and suppression (before any maths)

Estimate only the **wait from now to first provider assessment** for CTAS 3-5 (INFERRED scope: CTAS 1-2 is already suppressed in the design doc, and no literature supports estimates for them; Vital and the UK/US papers estimate low-acuity patients). Suppress and say nothing if: flagged/confidential, feed older than 15 min, fewer than 6 assessment starts in the last 60 min, or `spare` throughput below 20% of throughput (below).

### 5.2 Step 1: queue snapshot at time t for patient p with CTAS k

- `ahead` = patients still waiting with (CTAS < k) or (CTAS = k and arrived earlier). (Non-preemptive priority: more urgent waiting patients are seen first.)
- `mu` = assessment starts per minute over the last 60 min, optionally blended with the last 3 h by EWMA (half-life 30 min) to smooth noise.
- `lamH` = arrivals per minute over the last 60 min with CTAS < k (the stream that will jump ahead of p).
- Fluid estimate (Ang-style workload / rate, with higher-priority inflow removed from capacity):

  `W0 = (ahead + 1) / (mu - lamH)` (minutes; require `mu - lamH >= 0.2*mu`, else abstain)

  Why: in a priority queue, capacity left for p's class and those ahead is the total service rate minus the rate at which more urgent patients arrive; p needs `ahead + 1` service slots. The 0.2 floor stops the estimate blowing up when the department is saturated. This is a first-order approximation (**INFERRED**; it ignores service-time variability and tail behaviour, which the calibration step absorbs).

### 5.3 Step 2: calibration multipliers from a replayed month

For each resolved snapshot i (patient i was waiting at snapshot time, and the realised remaining wait `y_i` is known), compute score `s_i = y_i / max(W0_i, 5)`. Group into strata `g` = (CTAS band {3, 4-5}) x (time block {00-08, 08-16, 16-24}). For stratum g with n >= 30 snapshots (else fall back to the pooled set; if pooled n < 30, abstain), take empirical quantiles of `s`:

- `lo = Q_s(alpha/2)`, `hi = Q_s(1 - alpha/2)` using the finite-sample conformal index `ceil((n+1)*q)` for the upper quantile (and `floor((n+1)*q)` for the lower), with `alpha = 0.20` (an 80% interval; see recommendation in section 7).
- Displayed range = `[lo*W0, hi*W0]`.

Because it is a split-conformal procedure on a multiplicative nonconformity score, **coverage is guaranteed (marginally, per stratum) if calibration and test snapshots are exchangeable**, i.e. similar regimes; it is not guaranteed across a regime shift (**INFERRED from CQR theory, https://arxiv.org/abs/1905.03222**). Refit the multipliers on a rolling window of the last 14 days (or 500 resolved snapshots) of real or replayed history.

### 5.4 Step 3: drift guard (Adaptive Conformal Inference)

Keep a running `alpha_t` (init 0.20). After each resolved patient: `err = 1` if `y` fell outside the shown `[lo, hi]` else 0; update `alpha_{t+1} = alpha_t + gamma*(0.20 - err)` with `gamma = 0.02`, clipped to [0.02, 0.40]; use `alpha_t` in place of 0.20 in step 2 (Gibbs & Candes 2021 rule, https://arxiv.org/abs/2106.00170). Effect: after a surge produces consecutive misses, intervals widen automatically. In the demo, a staff-console "three CTAS 2 arrivals" event should visibly raise `lamH` and widen/shift the range.

### 5.5 Step 4: make it safe to read

- Round to 15 min: `loR = floor(lo*W0/15)*15`, `hiR = ceil(hi*W0/15)*15`. Enforce a minimum width of 30 min and `loR >= 0`.
- Lean conservative: for patient-facing text use the **upper bound as the headline** ("usually seen within about X") and soft-pedal the lower bound, because under-prediction is the harmful error (Pak).
- Abstain text instead of a range if `hiR > 360`, `hiR/max(loR,15) > 5`, or any suppression rule fires (copying ERstat's 360-min rule and Vital's >3 h rule). Say: "It's very busy and I can't give you a reliable estimate. A nurse can tell you more."
- Store absolute clock times for the published window (`publishedLoAt = now + loR`, `publishedHiAt = now + hiR`) so that elapsed time does not itself count as a "change".

### 5.6 Step 5: recompute triggers and hysteresis (anti-jitter)

Recompute internally on: any arrival (CTAS < k, or any CTAS for the stratum count), any assessment start, any LWBS/discharge/cancel of a patient ahead, any step change for p (triaged, being seen, tests ordered, results back, admitted), and a 10-min timer. Recompute is free; **publishing** is gated:

| Rule             | Condition                                                                                                                                                   | Action                                                                                                                                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worse, material  | new `hiAt` is later than published `hiAt` by >= max(30 min, 25% of published remaining) on **two consecutive** recomputes, or on one recompute if >= 60 min | Push update (bad news is not held back)                                                                                                                                      |
| Better, material | new `hiAt` is earlier by >= max(45 min, 40% of published remaining) on **three consecutive** recomputes (about 30 min)                                      | Push update (good news is confirmed first, to avoid false reassurance)                                                                                                       |
| Overrun          | now >= published `hiAt` and p not yet assessed                                                                                                              | Push "taking longer than we said; we have asked the triage nurse to check on you"; re-estimate from `W0` with `alpha` widened; if still overrun, repeat at most every 30 min |
| Step change      | any journey-step change                                                                                                                                     | Push the step update with the current range                                                                                                                                  |
| Rate limit       | otherwise                                                                                                                                                   | At most one proactive range text per 30 min; a "still waiting, nothing has changed" touch at 90 min; patients can pull any time by texting STATUS or calling                 |

Asymmetric thresholds (quick on worse, slow on better) and the two/three-confirmation rule are **INFERRED** design choices from the harms analysis in section 3.4; no study tested them. Tune on the replayed month by counting texts per patient-hour; target < 1 range text per hour on average.

### 5.7 Reference sketch (pure functions, no I/O)

```ts
type Ctas = 1 | 2 | 3 | 4 | 5;
interface Waiting {
  id: string;
  ctas: Ctas;
  arrivedAt: number;
} // epoch ms
interface Snapshot {
  now: number;
  waiting: Waiting[];
  starts: number[];
  arrivals: { t: number; ctas: Ctas }[];
}
interface Resolved {
  w0: number;
  y: number;
  stratum: string;
} // y = realised remaining wait (min)
const MIN = 60_000;

export function fluidWait(p: Waiting, s: Snapshot, winMin = 60): number | null {
  const since = s.now - winMin * MIN;
  const nStarts = s.starts.filter((t) => t >= since).length;
  if (nStarts < 6) return null; // too little data
  const mu = nStarts / winMin; // starts per minute
  const lamH = s.arrivals.filter((a) => a.t >= since && a.ctas < p.ctas).length / winMin;
  const ahead = s.waiting.filter(
    (w) => w.id !== p.id && (w.ctas < p.ctas || (w.ctas === p.ctas && w.arrivedAt < p.arrivedAt)),
  ).length;
  const spare = mu - lamH;
  if (spare < 0.2 * mu) return null; // saturated: abstain
  return (ahead + 1) / spare; // minutes
}

export const stratum = (c: Ctas, hour: number) =>
  `${c === 3 ? "3" : "45"}|${hour < 8 ? "n" : hour < 16 ? "d" : "e"}`;

function q(sorted: number[], p: number): number {
  // conformal-style index
  const n = sorted.length;
  const k = Math.min(n, Math.max(1, Math.ceil((n + 1) * p)));
  return sorted[k - 1];
}

export function multipliers(res: Resolved[], key: string, alpha: number) {
  let r = res.filter((x) => x.stratum === key);
  if (r.length < 30) r = res; // pooled fallback
  if (r.length < 30) return null; // abstain
  const sc = r.map((x) => x.y / Math.max(x.w0, 5)).sort((a, b) => a - b);
  return { lo: q(sc, alpha / 2), hi: q(sc, 1 - alpha / 2) };
}

export function range(w0: number, m: { lo: number; hi: number }) {
  const lo = Math.max(0, Math.floor((m.lo * w0) / 15) * 15);
  let hi = Math.ceil((m.hi * w0) / 15) * 15;
  if (hi - lo < 30) hi = lo + 30;
  return { lo, hi, abstain: hi > 360 || hi / Math.max(lo, 15) > 5 };
}

export const acuUpdate = (alpha: number, miss: boolean, target = 0.2, gamma = 0.02) =>
  Math.min(0.4, Math.max(0.02, alpha + gamma * (target - (miss ? 1 : 0))));
```

Publishing gate: keep `{publishedLoAt, publishedHiAt, worseStreak, betterStreak, lastPushAt}` per patient; apply the table in 5.6; write every computed and every published range, with inputs (`ahead, mu, lamH, W0, alpha, stratum`), to `estimate_log`; when the patient is assessed, stamp `actual` and compute `inside`, `over` (actual > hi) and `under` flags.

### 5.8 What to put on the staff console and in the pitch

Plot, per CTAS: coverage (target 80%), `over` rate (target <= 10%), median absolute error vs the 4-hour rolling-average baseline, and texts per patient-hour. Report the baseline comparison as "directionally like Arora/Pak/Ang on real data, to be proven on OPOR history" rather than claiming accuracy from synthetic data.

### 5.9 Pilot upgrade path (INFERRED)

Replace the fluid x multiplier with a QRF or LightGBM quantile model over the features in section 1.8 (queue counts by status, throughput, lags, calendar, CTAS, arrival mode, boarding count), keep the same conformal wrapper and ACI loop, keep suppression and hysteresis unchanged. ERstat already ships LightGBM + Mondrian conformal; Arora shows QRF is best on MAE/CRPS but only modestly better than linear quantile regression, so start with quantile regression on 5-8 features if time is short.

---

## 6. Plain-language templates (INFERRED drafting; apply the evidence in section 3)

Rules: lead with the step, then the range as "about A to B hours" (rounded), then why it can change, then the escalation line. Never a single time, never "you will be seen at". Use absolute clock times only where the patient can compare to their watch ("between about 3:30 and 4:45 pm"). Provide the range in minutes up to 90, then hours.

| Moment                              | Template                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Waiting to be seen (initial)        | "Hi Sam, you are checked in at the [Hospital] emergency department and a nurse has assessed you. People with a similar level of urgency are usually seen by a doctor or nurse practitioner within about 1 to 3 hours from now. Sicker patients are seen first, so this can change. If you feel worse, tell the triage nurse right away or call 911. Reply STATUS for an update." |
| Range worsened                      | "Update: it has got busier and your likely wait is now about 2 to 4 hours. We are sorry. Sicker patients were seen first. If you feel worse, tell the triage nurse right away."                                                                                                                                                                                                  |
| Range improved (after confirmation) | "Update: things have eased. Your likely wait is now about 45 minutes to 2 hours. This can still change."                                                                                                                                                                                                                                                                         |
| Overrun                             | "It is taking longer than we told you earlier. We have asked the triage nurse to check on you. If you feel worse, tell them right away."                                                                                                                                                                                                                                         |
| Tests pending                       | "Your tests are being processed. Blood tests often take about 1 to 2 hours once taken, and scans can vary. We will tell you when results are in." (Range from section 1.9 turnaround data; **lab only, never values**.)                                                                                                                                                          |
| Abstain                             | "It is very busy and I cannot give you a reliable wait estimate right now. A nurse can update you. If you feel worse, tell the triage nurse right away or call 911."                                                                                                                                                                                                             |
| LEAVING                             | "I have told the triage nurse that you are thinking of leaving so someone can check on you. You are currently waiting to be seen; people at your level are usually seen within about X to Y hours. Please stay if you can. If you do leave and feel worse, call 911 or come back."                                                                                               |

Voice and family versions use the same sentence with "your family member" and require the `estimates` consent scope (existing design).

---

## 7. Design implications for VeriCare

1. **Interval/wording mismatch in the current doc.** The doc says "most people ... are seen within about 1 to 3 hours" but plans the **25th-75th percentile**. That interval is designed to miss half of patients; "most" needs about 80%+ coverage. ERstat's measured 22% coverage on real visits shows how bad this gets. Use an **80% interval (10th-90th)** and wording like "usually within about A to B hours", with the upper bound doing the work.
2. **Calibrate on the thing you show.** Label = per-patient remaining time to first assessment from the snapshot, not facility averages (ERstat's published-wait vs finished-visit gap). Define "wait" explicitly (arrival or triage -> first provider contact) and keep the same definition as the NS Health facility display if it is stated.
3. **Lead the metrics with under-prediction.** Report `P(actual > hi)` and large-under-prediction rate (Pak), plus coverage and pinball loss, per CTAS and time block. Do not report only MAE.
4. **Do not claim satisfaction or LWBS gains from estimates.** The two RCTs found nothing for satisfaction, and no controlled evidence exists for LWBS. Claim: patients want it (81.3%; ~70%), it is low-risk when ranged and safety-netted, and the pilot will measure LWBS, coverage and satisfaction. The strongest LWBS lever to pitch is the **LEAVING -> nurse alert -> reassessment** loop, which sits next to the interventions with the best evidence (provider/team triage, fast track).
5. **Steps first, numbers second.** Progress steps are what MyChart shows and what every estimate paper updates at; the range is secondary and can disappear (abstain) without breaking the product.
6. **Abstain more than feels comfortable.** Copy Vital's >3 h rule and ERstat's 360-min rule; add: no estimate when throughput is low, spare capacity is small, the feed is stale, or the calibration stratum has < 30 resolved cases. Treat "can't tell you" as a feature.
7. **Hysteresis asymmetry.** Push worse news quickly (two confirmations), confirm good news before sending (three), always push on overrun, cap at one range text per 30 min. Store windows as absolute clock times.
8. **Priority jumps are the main under-prediction risk.** Put `lamH` (recent more-urgent arrivals) in the denominator, widen by stratum, adapt with ACI, and trigger on overrun. Demonstrate it live with the "three CTAS 2 arrivals" scene.
9. **Admission probability stays internal.** AUC 0.84-0.87 at triage is strong enough to prioritise staff attention, but a patient-facing "you will probably be admitted" is a harm risk with no evidence of benefit. Use it only to suppress estimates or flag for staff. Bed-wait estimates stay excluded (already in the doc).
10. **Test turnaround ranges should come from the ED's own order->result timestamps** (ORM->ORU), by test type and census band, with a note that the pre-order interval is often the biggest delay.
11. **Keep LLMs out of the number.** Evidence shows gradient boosting/QRF beats LLMs on MIMIC-IV length-of-stay (ClinicalBench) and no paper does LLM-based individual wait forecasting. This reinforces code-owned ranges and templated voice.
12. **Synthetic-data honesty.** State that synthetic coverage tests the pipeline only, and inject a regime shift in the demo to show the guardrails working.
13. **Legal/regulatory framing.** The US EMTALA self-triage worry does not apply directly in Nova Scotia, but the same harm (leaving before assessment because of a number) is why the escalation line, the LEAVING flow and the "sicker patients first" sentence are non-negotiable in every message.

---

## 8. Open questions

- Does OPOR's event feed expose **triage time, CTAS, and the "provider assigned / first contact" timestamp** with enough fidelity to label "first assessment"? Without it, the estimate has no ground-truth label.
- What definition of wait does YourHealthNS use (arrival, triage or registration -> first provider)? Aligning definitions avoids a ERstat-style conversion error.
- Is a daily/weekly **history extract** from OPOR available for calibration pre-launch (the pilot method needs it), or only live data from 2026-11-14? Zones that went live earlier (QEII, 2026-05-09) may have history; Eastern, Western, Northern do not.
- Does the feed include **boarding/admitted-held counts** and **staffing**? Their value as features is uncertain (staff count not top in Arora; boarding not tested in sources I read).
- Does a Canadian/NS **privacy or professional-standards** position exist on giving individuals wait estimates? I found only US EMTALA commentary.
- Optimal **message cadence and wording**: no direct evidence; plan an A/B in the pilot (frequency, upper-bound-only vs range) with satisfaction and LWBS outcomes.
- Sun et al. 2012 (Ann Emerg Med) could not be retrieved; and I could not read the Ovens et al. 2014 CJEM editorial body or Epic's "On My Way" page body. If these are cited in the pitch, read them first.
- Vital's accuracy definitions ("90%", "94% in the wild") are undefined in public pages; do not quote them.
- Whether **boarding/unusual events (mass-casualty, ambulance surge)** should force a system-wide abstain state; no evidence either way.
- Equity and accessibility: language, health literacy, patients without phones; no study found on how ranges are understood across literacy levels in an ED context.
