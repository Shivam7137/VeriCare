# Stage-time models: build record and experiments

Written 2026-11-14. This is the full record of how the wait-time models were built: the data, every experiment that was run (including the ones that failed), the decisions taken, and what the results do and do not show. The generated [model card](../../ml/artifacts/MODEL_CARD.md) holds the current numbers and is rebuilt by the pipeline; this document explains how they came about. How to run the pipeline is in [ml/README.md](../../ml/README.md).

Everything here is synthetic or open data. No Nova Scotia patient record was used, because none is public.

## 1. Summary

- **What exists.** Fifteen models estimate, for every open emergency visit, the minutes left until each milestone: triage, first provider, test results, the decision on next steps, and an inpatient bed. Each estimate is a low / typical / high range. The models run inside the API with no machine-learning runtime, appear on the patient page and the staff Desk, and every estimate is logged and scored against what happened.
- **What they learned from.** 50,258 real US emergency visits (NHAMCS), real lab timestamps from 100 Boston patients (MIMIC-IV demo), published Canadian figures, and a simulated department that supplies the one thing no open dataset has: a shared queue.
- **How they did.** On simulated departments they never trained on, the 80% ranges held 78.5% to 85% of the time for every step. Typical error of the middle estimate on the reference department: triage 6 min, wait to be seen 42 min, test results 34 min, decision 133 min, bed about 6 hours.
- **The caveat that matters.** That accuracy is measured on departments from the same simulator that produced the training data. It shows the method works and the ranges are calibrated. It does not show the simulator resembles a Nova Scotia hospital. On the one out-of-distribution check available, the scripted demo department, the wait range held 56% to 71% of the time.
- **Fit for.** The hackathon demo and pitch, described honestly. Not fit for telling real patients numbers until it has run silently against a real feed and been retrained on it.

## 2. Specification

| Item          | Value                                                                                                                                                      |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Version       | `stage-gbq-1`                                                                                                                                              |
| Models        | 15: five stages × three percentiles (10th, 50th, 90th)                                                                                                     |
| Family        | Gradient-boosted decision trees with quantile (pinball) loss, scikit-learn `HistGradientBoostingRegressor`. Same family as LightGBM and XGBoost            |
| Size          | 160 trees per model, at most 20 leaves, learning rate 0.1, minimum 150 samples per leaf, L2 1.0. 2.35 MB as JSON, 718 KB compressed                        |
| Inputs        | 47 numbers, all computable from the hospital feed (list in `ml/vericare_ml/features.py`)                                                                   |
| Output        | Low / typical / high minutes per stage                                                                                                                     |
| Calibration   | Conformalized quantile regression: the outer two percentiles are widened per triage band × time of day so the range held 80% of the time on held-out sites |
| Serving       | Trees exported as flat arrays; `apps/api/src/journey/stage-model.ts` walks them. No ONNX, no Python at run time                                            |
| Training time | About 15 minutes for data and fitting on a laptop, after about 15 minutes of calibration                                                                   |

The five stages and the feed event that ends each:

| Stage    | Ends at                                       | Estimated while               | Shown to                         |
| -------- | --------------------------------------------- | ----------------------------- | -------------------------------- |
| triage   | `triaged`                                     | arrived, not yet triaged      | patient, staff                   |
| provider | `provider_assigned`                           | waiting                       | patient (published range), staff |
| results  | last `result_available` among orders open now | any lab or imaging order open | patient, staff                   |
| decision | first of `discharged` or `admit_decision`     | waiting or being seen         | patient, staff                   |
| bed      | `moved_to_unit`                               | admitted, waiting for a bed   | staff only                       |

The 47 inputs fall into four groups: the patient (triage level, age, stream, step, minutes since each milestone, open orders by kind, results so far, consult requested); the patient's place in the queue (more-urgent patients ahead, same-level patients ahead, lower-level patients who have waited longer, a queue-formula estimate, recent more-urgent arrivals, boarders ahead); the department (numbers waiting by stream, patients seen in the last 30, 60 and 180 minutes, recent realised waits, patients in treatment and boarding, recent bed moves, open orders, recent lab and imaging turnaround); and the clock (time of day, weekday).

## 3. Data

### 3.1 Sources

| Source                                                                    | Access                                     | Size                                  | Used for                                                                                          |
| ------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| NHAMCS ED public-use files 2018–2022 (US CDC / NCHS)                      | Open, public domain. 5 Stata zips, 14.5 MB | 86,864 visits from 929 hospital-years | Who arrives, what is ordered, how visits end, wait to provider, length of visit, boarding         |
| MIMIC-IV Clinical Database Demo and ED Demo v2.2 (PhysioNet)              | Open, ODbL. 5 tables, 2 MB                 | 100 patients, 222 ED stays            | Real collected-to-resulted times for blood tests                                                  |
| Published figures (NS DHW, Ontario Auditor General, CAEP, journal papers) | Public                                     | Aggregates                            | Calibration targets and turnaround anchors. Taken from `docs/research`; not re-read for this work |

`ml/fetch_data.py` downloads the two datasets into `ml/data/raw/` (git-ignored). `ml/vericare_ml/sources.py` lists every published figure with its source and whether it was confirmed in the source, taken from a summary, or inferred.

### 3.2 What NHAMCS contains and what it lacks

It has, per visit: arrival time of day, weekday and month; age; arrival by ambulance; triage level (ESI 1–5); minutes waited for a provider; minutes in the department; minutes boarded; flags for 21 kinds of lab test, X-ray, CT, MRI, ultrasound, ECG, consult; and how the visit ended. It does not have the date, any intermediate timestamp (when a test was ordered or resulted), or anything about how busy the department was. So it can say how long a visit with a CT ran after the provider saw the patient, but not when the CT came back, and nothing about the queue.

### 3.3 Exploration findings (experiment D1)

All figures are unweighted unless noted. "Post" is minutes from first provider contact to the end of the visit, with boarding removed for admitted patients.

How visits ended: home 81.2%, admitted 12.2%, transferred 3.2%, left without being seen 2.3%, left against advice 0.9%, died 0.2%.

Wait for a provider (US): median 14 min, mean 35. By ESI level 1 to 5 the medians are 9, 12, 14, 15, 17. US waits are far shorter than Nova Scotia's 178-minute average, which is why the wait had to come from a simulator and not from these records.

Post by test pattern, patients sent home:

| Orders            | n      | 10th | Median | 90th |
| ----------------- | ------ | ---- | ------ | ---- |
| None              | 19,132 | 20   | 65     | 198  |
| X-ray only        | 7,629  | 44   | 100    | 230  |
| Bloodwork only    | 12,393 | 52   | 146    | 418  |
| Bloodwork + X-ray | 7,562  | 81   | 175    | 403  |
| Ultrasound        | 2,640  | 87   | 190    | 395  |
| CT or MRI         | 10,970 | 101  | 215    | 488  |

A consult adds roughly an hour at the median (for example bloodwork only: 140 without, 229 with).

Post by outcome (median, 90th): home 128, 356; admitted 197, 549; transferred 276, 1082; left against advice 164, 481. Post by ESI level for patients sent home (median): 206, 212, 158, 83, 59.

Other profiles taken from the data:

- ESI mix (weighted): 1.9%, 15.2%, 50.2%, 29.0%, 3.7%. Admission by ESI: 35%, 32%, 12%, 2%, 5%.
- Share with bloodwork by ESI: 74%, 81%, 69%, 27%, 22%. Share with CT: 39%, 31%, 27%, 7%, 7%.
- Arrivals by hour peak at 6.2% of the day between 13:00 and 14:00 and bottom out at 1.4% between 04:00 and 05:00. Weekday factors, Sunday to Saturday: 0.91, 1.15, 1.07, 1.01, 1.01, 0.96, 0.89.
- Ambulance share is 14–17% in the daytime and 22–27% overnight.
- US boarding among boarded patients: median 109 min, 90th percentile 720.
- Patients who left without being seen had been in the department a median of 142 minutes (90th percentile 438).

### 3.4 Does crowding stretch the time after being seen? (experiment D2)

NHAMCS has no census, so each hospital's average wait among its other sampled visits was used as a crowding proxy. Raw medians of post for patients sent home were flat across crowding bins (141 min where average waits were under 10 minutes; 115 min where they were 90–150). A regression of log post on triage level, outcome, orders, age and the log crowding proxy (49,773 visits) gave an elasticity of −0.065.

**Conclusion:** no evidence that the seen-to-done time grows with crowding in these data. The simulator does not stretch it, apart from a small randomised factor (0 to 0.1) so the model cannot rely on its absence.

Walkouts do rise with crowding: 1.6% of visits at hospitals averaging a 9-minute wait, 4.6% at those averaging 119 minutes.

### 3.5 Do the published turnaround figures agree with NHAMCS? (experiment D3)

A quantile regression of post on order flags, 20,000 visits sent home, gives the extra minutes each order adds:

| Order       | At the median | At the 90th percentile |
| ----------- | ------------- | ---------------------- |
| (no orders) | 65            | 180                    |
| Bloodwork   | +72           | +165                   |
| Troponin    | +19           | +1                     |
| X-ray       | +30           | +34                    |
| CT          | +67           | +99                    |
| Ultrasound  | +64           | +63                    |
| MRI         | +134          | +404                   |
| Consult     | +68           | +269                   |

These line up with the anchors: a blood panel measured at a median of 66 minutes in MIMIC against +72 here; an X-ray assumed at 35–45 minutes against +30. Two unrelated sources agreeing is the main support for the intermediate timestamps.

### 3.6 Lab turnaround from MIMIC (experiment D4)

Blood drawn during an ED stay, minutes from collected to resulted:

| Test                 | n     | Median | 90th |
| -------------------- | ----- | ------ | ---- |
| Hematology, per test | 4,397 | 33     | 77   |
| Chemistry, per test  | 3,505 | 62     | 122  |
| Whole first panel    | 200   | 66     | 185  |
| Troponin             | 72    | 58     | 207  |

The first blood draw came a median of 52 minutes after arrival. Limits: one hospital, 100 patients, and a sicker group than a typical department (150 of 222 stays were admitted).

## 4. The simulator

`ml/vericare_ml/sim.py`. A discrete-event department, 526 lines, about 0.4 seconds per simulated month.

**Patients.** Each simulated patient is a real NHAMCS visit drawn with its survey weight: its triage level, age, arrival mode, orders, consult flag, outcome and its own real post time. Arrivals follow the NHAMCS hourly and weekday curves at a chosen daily volume, with day-to-day noise and occasional surges of urgent ambulance arrivals.

**Queue.** Triage nurses, then two streams (main and rapid assessment), each with providers rostered by hour. A waiting patient's rank is a triage handicap minus minutes waited, so sicker patients go first but a long wait eventually outranks a higher level. Main-stream patients take a treatment space until they leave; past the last space care continues more slowly, and beyond a ceiling only the sickest are brought in. Each waiting patient has a patience drawn from a lognormal; past it they leave. Some tell staff; the rest are discovered only when called.

**After being seen.** Orders are placed inside the visit's real post time using the turnaround figures, squeezed to fit when the real visit was shorter. Some bloodwork and X-rays start in the waiting room, as Waiting Room Care Providers do in Nova Scotia. Turnaround slows mildly when many orders are open.

**Beds.** Admitted patients wait in a queue for inpatient beds that free up mostly in the afternoon, at a rate that drifts from day to day.

**A design choice worth knowing.** A walkout who told nobody stays in the queue until called, which is when the simulator records both the walkout and the time they would have been seen. That gives every waiting patient an uncensored label, which a real feed will not have (section 13).

### 4.1 Development history (experiments S1 to S3)

| Step | What was tried                                                                                   | Result on the reference site                                                                                   | What it showed                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| S1   | First version: near-strict priority, hard treatment-space limit                                  | Average wait 78 min but median 21 and 90th percentile 276; 16.6% walkouts; bed wait averaged 22 hours          | Boarders filled every space and froze the department. Real departments use hallways; the limit had to be soft        |
| S2   | Soft space limit, same priority rule                                                             | Staffing at 100%: average wait 55 min, 10.5% walkouts, of which 91% were CTAS 4–5 and 0.1% CTAS 2              | Low-acuity patients starved while CTAS 2–3 were seen fast. Unlike Nova Scotia, where 46% of walkouts are CTAS 3      |
| S3   | Triage handicap in minutes (0 / 250 / 350 / 400 for CTAS 2 / 3 / 4 / 5), so waits outrank levels | Staffing 110%, patience 700 min: average wait 199, 90th 432, 11.4% walkouts (38% CTAS 3), bed wait 760 / 2,040 | Smooth response to each knob, and the 90th-to-mean ratio (2.17) matched Ontario's published 2.18 without being tuned |

## 5. Calibration to published figures

Three knobs (provider utilisation, patience, inpatient bed supply) against three targets: Nova Scotia's 178-minute average wait and 10.02% walkouts, and Ontario's 780-minute average bed wait (Nova Scotia publishes none).

| Attempt | Method                                                                                                                         | Outcome                                                                                                                  |
| ------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| C1      | One-knob-at-a-time bisection, on simulator version S1                                                                          | **Failed.** Ran to its limits (utilisation 1.23, patience 2,498 min) with a 1,339-minute average wait and 20.5% walkouts |
| C2      | For each staffing level, solve patience for the walkout share; then move staffing until the wait matches. 60-day runs, 2 seeds | Converged on short runs, but on 120-day runs gave 140 min, 7.6%, 646 min. Short runs were too noisy                      |
| C3      | Damped corrections on 150-day runs, 4 seeds, keeping the best                                                                  | Seven iterations: worst miss went 22% → 14% → 9% → 34% → 14% → 6% → **1.8%**                                             |

Final reference site: utilisation 1.025, median patience 704 minutes for CTAS 4, bed ratio 1.145.

| Figure                             | Published                              | Simulated                 | Tuned? |
| ---------------------------------- | -------------------------------------- | ------------------------- | ------ |
| Average wait, triage to clinician  | 178 min (NS 2023-24)                   | 179 min                   | yes    |
| Left without being seen            | 10.0% (NS 2023-24)                     | 10.1%                     | yes    |
| Average wait for an inpatient bed  | 780 min (Ontario 2022/23)              | 794 min                   | yes    |
| 90th percentile wait over the mean | 2.18 (Ontario)                         | 2.35                      | no     |
| 90th percentile bed wait           | 2,100 min (Ontario)                    | 1,924 min                 | no     |
| Share of seen patients admitted    | about 12% of visits (Canada)           | 13.8%                     | no     |
| Door to triage, median             | 13 min (Canadian EDs, to registration) | 9 min                     | no     |
| Seen to going home, median         | 140 min in the source records          | 131 min                   | no     |
| Whole visit for patients sent home | no NS figure found                     | median 5.7 h, 90th 11.2 h | no     |

Known mismatches: about 11% of Nova Scotia walkouts are CTAS 2 and the simulator produces almost none; door-to-triage runs short and its spread is narrower than published. Bed waits vary a lot between runs of the same site: the 60-day held-out run of the reference site averaged 1,427 minutes against the calibrated 794.

Three numbers cannot pin down a simulator with this many parts. Many different departments would match the same three averages.

## 6. Training data

112 simulated departments, split whole: 72 for training, 25 for calibrating the ranges, 15 for testing (the reference site on new days, a 123-visit regional site, the reference with a surge and a half per day, and 12 random sites).

Every field of a training site is randomised: volume 70–280 a day, acuity mix, rapid-assessment share (0 or 5–30%) and hours, staffing 80–106% of the reference, provider speed, treatment spaces, queue rule, patience 0.6–1.6× the reference, share of walkouts who tell staff, how often tests start in the waiting room, lab and imaging speed, how much load slows them, bed supply and its drift, triage staffing, surge frequency. Average waits across training sites ran from 36 to 542 minutes and walkouts from 0.6% to 23.1%.

Each department is snapshotted about every 15 minutes; each open visit is kept with probability 0.35. A snapshot is the 47 inputs plus the minutes until each milestone still ahead. Total 4,457,862 snapshots: 2,714,484 train, 1,017,649 calibration, 725,729 test.

| Stage    | Training snapshots | Calibration snapshots |
| -------- | ------------------ | --------------------- |
| triage   | 70,270             | 23,782                |
| provider | 900,000 (capped)   | 408,292               |
| results  | 435,045            | 161,709               |
| decision | 900,000 (capped)   | 695,337               |
| bed      | 556,226            | 206,588               |

**Experiment T1 (failed run).** The first dataset build used 19 parallel workers and died with "paging file too small" on a 16 GB machine. It now uses 4 workers and writes each department to a shard, so an interrupted run resumes. Building the data takes about 7 minutes and fitting about 6.

## 7. Results on held-out departments

Target: the range holds about 80% of the time and runs over about 10% of the time. "Table" is the baseline a lookup by triage level and step would give.

| Stage    | Site                | Held  | Ran over | Median width | Typical error | Better than table by |
| -------- | ------------------- | ----- | -------- | ------------ | ------------- | -------------------- |
| triage   | reference, new days | 80.7% | 10.7%    | 17 min       | 6 min         | 24%                  |
| triage   | 12 unseen sites     | 79.1% | 11.0%    | 18 min       | 7 min         | 23%                  |
| provider | reference, new days | 84.8% | 8.4%     | 144 min      | 42 min        | 66%                  |
| provider | regional            | 82.0% | 7.5%     | 149 min      | 46 min        | 64%                  |
| provider | repeated surges     | 82.4% | 11.8%    | 137 min      | 45 min        | 68%                  |
| provider | 12 unseen sites     | 78.6% | 10.7%    | 140 min      | 53 min        | 64%                  |
| results  | reference, new days | 81.5% | 7.4%     | 112 min      | 34 min        | 15%                  |
| results  | 12 unseen sites     | 80.5% | 9.8%     | 118 min      | 38 min        | 16%                  |
| decision | reference, new days | 82.2% | 8.5%     | 363 min      | 133 min       | 19%                  |
| decision | 12 unseen sites     | 79.9% | 9.9%     | 357 min      | 139 min       | 18%                  |
| bed      | reference, new days | 78.6% | 12.1%    | 1,098 min    | 372 min       | 43%                  |
| bed      | regional            | 85.0% | 7.3%     | 523 min      | 187 min       | 59%                  |
| bed      | 12 unseen sites     | 80.3% | 10.8%    | 867 min      | 383 min       | 47%                  |

Coverage by calibration cell on the reference site stays between 76% and 87% everywhere except bed waits for CTAS 4–5 in the evening (70.6%) and at night (74.5%). The full table is in the model card.

Reading the numbers:

- The wait-to-be-seen error is about 23% of the average wait. The best published models on real hospitals manage about 35% (Arora et al., in `docs/research/03`). Ours looks better because a simulated queue is tidier than a real one.
- Results and decision gain least over the lookup table (15–19%). Their durations come from real patients and depend mostly on what was ordered, which the table already half-captures.
- The ranges are wide: an honest 80% range for the decision spans six hours.

## 8. Comparison with the usual wait estimators

**Experiment B1 (misleading, replaced).** The first comparison scored every snapshot, with the rolling average reduced by the time already waited. The model's pinball loss came out 89–91% lower than a rolling average and 85–87% lower than the queue formula. That comparison was unfair to the baselines, which are designed to be issued once at triage.

**Experiment B2 (reported).** One estimate at triage (within 15 minutes of it), each method given its own calibrated 80% range. Reference site, 3,481 snapshots:

| Method                                          | Held  | Median width | Typical error | Pinball |
| ----------------------------------------------- | ----- | ------------ | ------------- | ------- |
| This model                                      | 83.4% | 157 min      | 47 min        | 15.1    |
| Rolling median of waits in the last three hours | 78.9% | 726 min      | 140 min       | 57.9    |
| Queue formula (the estimator this replaces)     | 82.8% | 394 min      | 285 min       | 91.3    |

The model's typical error is 66% lower than the rolling average. **This gain should not be quoted.** Published gains on real hospital data are 10–30%. The gap here is inflated because the simulated queue follows its rules more faithfully than a real department does, and because this rolling average is not split by triage level. What the comparison does show is that the model reads the queue, which a rolling average cannot.

## 9. Is gradient boosting the right model family? (experiment M1)

`python -m vericare_ml.compare_models`. Same training departments, same held-out departments, same pinball loss, before any range calibration. The neural network is a three-layer feed-forward net (256, 256, 128) trained on the pinball loss with Adam, with log scaling, standardising, missing-value flags and one-hot encoding of triage level, step and weekday. XGBoost and LightGBM were not installed and were not run; they are the same family as the shipped model.

| Stage    | Model                          | Pinball | Typical error | Against shipped | Training time |
| -------- | ------------------------------ | ------- | ------------- | --------------- | ------------- |
| provider | Boosted trees (shipped)        | 15.44   | 49 min        | baseline        | about 2 min   |
| provider | Boosted trees, 600 × 63 leaves | 14.56   | 46 min        | −5.7%           | 193 s         |
| provider | Neural network                 | 14.58   | 46 min        | −5.6%           | 156 s         |
| provider | Neural network, log target     | 14.77   | 46 min        | −4.4%           | 155 s         |
| provider | Linear quantile model          | 23.73   | 74 min        | +53.7%          | 7 s           |
| results  | Boosted trees (shipped)        | 11.98   | 37 min        | baseline        |               |
| results  | Neural network                 | 12.07   | 37 min        | +0.7%           | 78 s          |
| results  | Linear quantile model          | 12.34   | 38 min        | +3.0%           | 4 s           |
| decision | Boosted trees (shipped)        | 45.67   | 135 min       | baseline        |               |
| decision | Neural network, log target     | 45.55   | 135 min       | −0.3%           | 154 s         |
| decision | Linear quantile model          | 50.03   | 147 min       | +9.6%           | 7 s           |

**Findings.** A neural network and boosted trees tie within a few percent on every stage. A larger tree model recovers the same 6% the neural network gains on the wait to be seen. A linear model is far worse where the queue matters (provider) and nearly as good where it does not (results), which says the results stage is driven by a few simple inputs.

**Decision: keep boosted trees.** Same accuracy; trees take missing values as they come, while the network needs scaling and missing-value flags reproduced exactly in the API (a second place for training and serving to drift apart); and trees hold up better on the small real datasets a pilot would start with. The 6% headroom from a larger tree model was left on the table for now: it makes the model file about ten times larger and is small beside the uncertainty of training on a simulator. A network becomes worth revisiting with months of real feed data, where a sequence model could read the event stream directly.

## 10. Serving, and keeping two languages in step

The features are computed twice: in Python for training (`features.py`) and in TypeScript for serving (`stage-features.ts`). If they drift, the model is fed numbers it was not trained on and nothing fails loudly.

**The guard.** `export_fixture.py` simulates a small department (301 visits), writes it as feed events, and records the 47 features and the calibrated estimates Python computes at five moments (114 open visits, 5,358 feature values). `apps/api/test/stage-model.test.ts` rebuilds both from the events and must match: features to 0.001, estimates to 0.05 minutes. It passes.

**Bug found by this test (experiment X1).** The first export would not load in the API. Twenty-nine tree nodes split on "is this value missing", which scikit-learn stores as a threshold of infinity, and JSON cannot carry infinity. The export now writes 1e300 for those and refuses non-finite numbers.

Other details: inputs are rounded to 32-bit precision before the trees are walked, as in training; a result that arrives after the patient has left still counts toward recent lab turnaround in both languages; the model file's timestamp is the dataset's, so re-exporting the same fit gives the same file.

## 11. Behaviour on the scripted demo

The OPOR Twin plays a scripted visit for one patient, Maya Chen (CTAS 4), in a small scripted department. It is not calibrated to anything, which makes it a useful sanity check and a poor accuracy test.

### 11.1 Estimates along the visit (experiment P1)

Visit starting Monday 08:00 Halifax time, original script with three urgent arrivals at minute 30. Low / typical / high minutes:

| Minute | Wait to be seen | Results       | Decision       | What just happened                            |
| ------ | --------------- | ------------- | -------------- | --------------------------------------------- |
| 9      | 31 / 66 / 139   |               | 97 / 189 / 379 | Triaged; 1 more-urgent and 3 same-level ahead |
| 20     | 12 / 40 / 89    | 32 / 60 / 124 | 84 / 194 / 408 | Bloodwork ordered in the waiting room         |
| 31     | 3 / 28 / 65     | 24 / 49 / 111 | 60 / 164 / 384 | Queue has moved; 1 ahead                      |
| 35     | 32 / 71 / 123   | 17 / 46 / 108 | 90 / 187 / 389 | Three CTAS 2 patients arrive                  |
| 50     | 10 / 37 / 70    |               | 60 / 132 / 336 | Bloodwork back; surge being worked through    |
| 75     | 0 / 8 / 27      |               | 35 / 109 / 317 | Next in line                                  |
| 100    |                 | 10 / 28 / 60  | 29 / 94 / 263  | Seen at 88; X-ray ordered at 95               |
| 140    |                 |               | 3 / 43 / 183   | X-ray back at 135                             |

She was seen at minute 88, inside every range issued. The estimates move in the right direction at each event.

### 11.2 The surge problem (experiment P2)

With the trained model live, two integration tests failed: the three-patient surge no longer produced a "your estimate has changed" message. The first published range (seen by minute 158) already allowed for it, and the publishing rule only sends bad news when the promised time is at risk. The model was right not to alarm the patient.

Peak upper bound on the wait after the surge, by surge size: three patients 126 min, five 185 min, six 202 min. Each urgent arrival adds roughly 25–30 minutes.

**Decision:** the scripted surge was changed from three to five urgent patients, so the message fires for a reason the model supports. Maya is now seen at minute 112 and discharged at 189. The three-patient script is kept at `work/scenario.three-patient-surge.backup.ts`. This is a change to the demo storyline and is the team's call to keep or revert.

### 11.3 Accuracy on the scripted department (experiment P3)

Every estimate the model would log during the five-patient script, scored against what the script does:

| Start (Halifax) | Wait: inside / early / over (of 126) | Decision: inside (of 244) | Triage: inside (of 23) |
| --------------- | ------------------------------------ | ------------------------- | ---------------------- |
| Mon 08:00       | 89 / 33 / 4 (71%)                    | 167 (68%)                 | 18                     |
| Mon 11:00       | 81 / 43 / 2 (64%)                    | 161 (66%)                 | 18                     |
| Mon 14:00       | 79 / 45 / 2 (63%)                    | 159 (65%)                 | 18                     |
| Mon 18:00       | 80 / 46 / 0 (63%)                    | 162 (66%)                 | 18                     |
| Mon 22:00       | 71 / 55 / 0 (56%)                    | 150 (61%)                 | 18                     |
| Tue 03:00       | 79 / 45 / 2 (63%)                    | 160 (66%)                 | 18                     |

Coverage is well below 80%, and almost every miss is a patient seen or finished sooner than the lower bound. The scripted department is faster than anything the model trained on: every scripted patient is discharged exactly 70 minutes after being seen, against a real-data median of 128. The model errs on the safe side here, but this is what "off the simulator" looks like, and a real department will differ from the simulator in ways nobody has measured.

### 11.4 Live replay in the browser (experiment P4)

Replayed at 21:52 Halifax time on a Saturday. Maya's first range was "within about 3 hours 30 minutes" (the same script at 08:00 gives about 2 hours 30: the model expects longer waits at night). After the five-patient surge the page showed "within about 5 hours" with "Several very sick patients arrived, so the wait is longer." The outlook showed test results within about 2 hours and the whole visit within about 8 hours 15 minutes. The Desk listed a model estimate for every patient and, part-way through, accuracy by step: decision 37 of 57, seen 23 of 63, triage 15 of 20.

### 11.5 Local recalibration (experiment P5)

Added 2026-11-18 after a mentor's live test of the public demo. Its accuracy page showed 63% of estimates inside their range, against the 80% target: seen 86%, triage 78%, results 63%, decision 55%, bed 49%. Almost every decision miss was _sooner_ than the range (120 under, none over), so the model was systematically pessimistic for this department, not noisy.

The fix is the mirror image of adaptive widening (`widening.ts`), which stretches a step's upper bound after repeated overruns. `apps/api/src/journey/recalibration.ts` looks at the latest scored estimate of the last 24 visits for each later step (results, decision, bed). When at least 8 are scored and a quarter or more finished below the lower bound, every range for that step is multiplied by the median of _actual ÷ the model's own typical value_. The factor is between 0.35 and 1, so it can shorten a range but never lengthen it; each logged estimate records the factor it was made with (`local_scale`, migration 017), so the next factor is always worked out against the unscaled model and does not drift. Once on, it stays on while the evidence holds, so ranges do not flip back and forth. Recalibration runs first, then widening.

Triage and the wait to be seen are deliberately left alone. The wait to be seen is what patients are told and already met the target in the mentor's run; scaling it also broke the surge story (Maya's range shrank just as five urgent patients arrived).

A 12-hour simulated shift of the demo department, comparing estimates made before the factor switched on with those made after:

| Step     | Inside range, model as trained | Inside range, recalibrated | Mean width, trained → recalibrated |
| -------- | ------------------------------ | -------------------------- | ---------------------------------- |
| Results  | 53% (17 visits)                | 81% (42)                   | 85 → 49 min                        |
| Decision | 50% (54)                       | 95% (91)                   | 294 → 107 min                      |
| Bed      | 74% (19)                       | 88% (17)                   | 330 → 246 min                      |

The accuracy page shows the factor per step ("tightened ×0.35 for this department") and counts tightened and widened steps together under "Ranges adjusted here". The same caveat as everywhere in this document applies: this is a simulated department, and the factor is learnt from it. On a real feed it would be learnt from that hospital's own recent visits, which is the point.

## 12. What changed in the application

| Area                 | Change                                                                                                                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contract             | Imaging orders carry a `modality` (xray, ct, ultrasound, mri, other), because a CT takes several times longer than an X-ray. Result values are still never read                           |
| Feed mapper          | Maps the order's department code to that modality                                                                                                                                         |
| `stage-features.ts`  | Rebuilds the 47 inputs from feed events                                                                                                                                                   |
| `stage-model.ts`     | Loads the model, walks the trees, applies the calibration, rounds ranges for display                                                                                                      |
| `stage-estimates.ts` | Loads a department's events, estimates every open visit, logs estimates every 10 feed-minutes and scores them when the milestone happens                                                  |
| Migration 013        | `ed_stage_estimates`: stage, range, model version, the orders a results estimate covered, actual minutes, and a censored flag for visits that ended first                                 |
| Ingest               | The published wait range now comes from the model. The queue formula is the fallback when no model file is bundled; rounding, the six-hour ceiling and the publishing rules are unchanged |
| Guardian             | `mayShareOutlook`: later-step estimates follow the wait range's rule (never CTAS 1–2, flagged visits, a stale feed or an ended visit) and never include the bed wait                      |
| Patient page         | "Test results" and "Whole visit" / "Next steps decided" under the wait range, with fixed wording                                                                                          |
| Desk                 | A model-estimate column for every patient, including bed waits, and accuracy by step                                                                                                      |
| `widening.ts`        | Adaptive widening: a step's upper bound stretches (up to ×2) after three or more overruns in a row                                                                                        |
| `recalibration.ts`   | Local recalibration (section 11.5): results, decision and bed ranges scale down when this department keeps finishing sooner                                                               |
| Migration 017        | `ed_stage_estimates.local_scale`: the recalibration factor each estimate was made with                                                                                                    |
| Accuracy page        | `/professional/ed/accuracy`: coverage, misses each way, typical error and width per step, and each step's widening or tightening                                                          |
| Twin script          | Surge of five instead of three (section 11.2)                                                                                                                                             |

Tests: 8 new unit tests in `stage-model.test.ts`, one mapper test, one new end-to-end test in `journey.test.ts`. Full suite at the time of writing: 181 unit tests and 220 database tests, all passing.

## 13. Decisions and why

| Decision                                                      | Reason                                                                                                                     |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Simulate the queue, resample real patients into it            | No open dataset has both step timestamps and queue state. Real records carry everything except the queue                   |
| Use each real visit's own seen-to-done time                   | It is the one duration the data actually measures per patient; drawing it from a fitted curve would throw information away |
| scikit-learn boosted trees, not LightGBM                      | Already installed, same algorithm family, no download                                                                      |
| Export trees as JSON, evaluate in TypeScript                  | One process, no ONNX runtime to install or keep in step                                                                    |
| Split by whole department, never by row                       | Snapshots of the same queue are strongly correlated; row splits would leak                                                 |
| Randomise every site parameter in training                    | So the model learns how a queue becomes a wait, not one department's habits                                                |
| Asymmetric conformal adjustment per triage band × time of day | Running over is the harmful miss; cells let busy evenings be wider than quiet mornings                                     |
| Bed wait shown to staff only                                  | The design document's rule; it is also the weakest stage                                                                   |
| Keep the publishing rules for the wait range untouched        | They were designed and tested before this work; only the source of the range changed                                       |
| Keep boosted trees over a neural network                      | Section 9                                                                                                                  |
| Do not retrain larger now                                     | 6% on a simulator is not worth a tenfold larger file and a re-test four days before the deadline                           |
| Recalibrate later steps locally, never the wait to be seen    | Section 11.5: the misses were one-sided and local; the patient-facing wait already met its target                          |

## 14. Limits and threats to validity

1. **Circular validation.** Test departments come from the same simulator as training departments. Good coverage shows calibration, not realism.
2. **American patients.** Mix, orders and seen-to-done times are from US hospitals, 2018–2022, including the pandemic years. ESI levels are treated as CTAS levels.
3. **Under-determined simulator.** Three calibration targets, more than twenty parameters. The queue rule, patience distribution, bed-release curve and staffing rule are design choices with no data behind them.
4. **Bed wait.** One Ontario mean and 90th percentile, used as a stand-in for Nova Scotia, and a simple release model. Run-to-run variation is large.
5. **Assumed turnarounds.** X-ray and ultrasound times have no public source. CT and consult times are from summaries of papers. Lab times are from 100 patients at one hospital.
6. **No censoring in training.** The simulator knows when a walkout would have been seen. A real feed does not. The API marks those estimates censored and counts one as a miss only when the patient had already stayed past the upper bound; a retrained model will need a proper treatment.
7. **Correlated snapshots.** The conformal guarantee assumes exchangeable rows; several snapshots per visit break that, so the guarantee is approximate.
8. **Time of day.** The model lengthens estimates at night because simulated staffing follows demand. Whether a given real department behaves that way is unknown.
9. **Unverified citations.** Published figures were taken from `docs/research` with the tags those notes carry. They were not re-read for this work.
10. **Off-distribution behaviour.** Section 11.3: coverage of 56–71% on a department that does not behave like the simulator.

## 15. Not built

- Admission-likelihood and leave-risk models (M3 and M4).
- Any validation on real feed data.

(Adaptive widening and the staff accuracy page, listed here when this was first written, have since been built; see section 12.)

## 16. Path to a real number

1. Run in shadow mode on a real feed: the API already logs every estimate and its outcome in `ed_stage_estimates`.
2. Read coverage and error by stage from that table. That is the first real accuracy figure.
3. Retrain with the same code on feed history, splitting by week instead of by department, and handle walkouts as censored.
4. Re-run the fixture test and the model comparison. Revisit the neural network once there are months of data.

## 17. Reproducing this

```sh
pip install -r ml/requirements.txt
python ml/fetch_data.py
cd ml
python -m vericare_ml.stage_fit        # sections 3.3 to 3.6
python -m vericare_ml.calibrate        # section 5, attempt C2
python -m vericare_ml.refine           # section 5, attempt C3
python -m vericare_ml.train            # sections 6 to 8
python -m vericare_ml.compare_models   # section 9
python -m vericare_ml.export_fixture   # section 10
python -m vericare_ml.model_card
cd ..
npx tsx --test apps/api/test/stage-model.test.ts
npm run test:backend
```

Outputs: `ml/artifacts/stage_params.json`, `calibration.json`, `metrics.json`, `model_comparison.json`, `MODEL_CARD.md`; `apps/api/models/stage-model.json.gz`; `apps/api/test/fixtures/stage-fixture.json.gz`. Simulated departments are cached in `ml/data/shards/`; delete that folder and `ml/data/snapshots.parquet` to regenerate.

The scripted-demo experiments in section 11 were run with throwaway scripts that replayed `buildDemoScenario` through `mapHl7` and `stagesFromVisits`; they are not kept in the repository.

## 18. Session notes

- The expired local demo sessions were regenerated with `npm run demo:credentials`; the old file is in `work/session-backups/`.
- Migration 013 has been applied to the local development database.
- Nothing from this work, or from the journey work before it, has been committed.
- A live task board for the hackathon is at <https://claude.ai/artifact/Ni1Nw82XDK2EkjB7GFBTDT>.
