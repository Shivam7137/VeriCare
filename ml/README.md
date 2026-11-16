# Stage-time models

Estimates how long each remaining step of an emergency visit will take: triage, the wait to be seen, test results, the decision on next steps, and an inpatient bed. Each estimate is a calibrated low / typical / high range in minutes.

Results, data sources and limits are in the generated [model card](artifacts/MODEL_CARD.md). The full build record, with every experiment and decision, is in [docs/stage-time-model.md](../docs/stage-time-model.md). Read its last section before quoting any number: the models are trained on real open patient records placed in a simulated department, and have never seen Nova Scotia data.

## How it fits together

```
NHAMCS 2018-2022 (real US ED visits) ─┐
MIMIC-IV demo (real lab timestamps) ──┼─> stage_fit.py ─> patient pool + stage parameters
Published NS / Ontario figures ───────┘                          │
                                                                 v
              calibrate.py + refine.py ─> sim.py  (a department with a real queue)
                                                                 │  100+ randomised departments
                                                                 v
                           features.py  (snapshots: 47 inputs, 5 labels)
                                                                 │
                                                                 v
        train.py  (quantile gradient boosting + conformal ranges + evaluation)
                                                                 │
                 ┌───────────────────────────────────────────────┤
                 v                                               v
 apps/api/models/stage-model.json.gz             artifacts/metrics.json, MODEL_CARD.md
                 │
                 v
 apps/api/src/journey/stage-model.ts      evaluates the trees, no ML runtime
 apps/api/src/journey/stage-features.ts   rebuilds the 47 inputs from feed events
```

| File                            | What it does                                                                                                                                    |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `fetch_data.py`                 | Downloads the two open datasets into `data/raw/` (about 17 MB, git-ignored)                                                                     |
| `vericare_ml/nhamcs.py`         | Reads and cleans the NHAMCS public-use files                                                                                                    |
| `vericare_ml/stage_fit.py`      | Builds the pool of real visits; fits lab turnaround, arrival curves, the crowding effect; cross-checks published turnaround figures             |
| `vericare_ml/sources.py`        | Every published figure used, with its source and whether it was confirmed, secondary or inferred                                                |
| `vericare_ml/sim.py`            | Discrete-event department: triage, two streams, providers, treatment spaces, walkouts, tests, inpatient beds                                    |
| `vericare_ml/calibrate.py`      | Tunes the reference department to Nova Scotia's published wait and walkout share and Ontario's bed wait; `refine.py` tightens it on longer runs |
| `vericare_ml/features.py`       | Model inputs and labels from the event log. **Mirrored in TypeScript**: change both or the fixture test fails                                   |
| `vericare_ml/train.py`          | Simulates randomised departments, trains, calibrates, evaluates against baselines, exports the model                                            |
| `vericare_ml/export_fixture.py` | Writes the fixture that proves the Python and TypeScript feature code agree                                                                     |
| `vericare_ml/model_card.py`     | Generates the model card from the pipeline's own output                                                                                         |

## Run it

Python 3.11 or later. From the repository root:

```sh
pip install -r ml/requirements.txt
python ml/fetch_data.py
cd ml
python -m vericare_ml.stage_fit
python -m vericare_ml.calibrate
python -m vericare_ml.refine
python -m vericare_ml.train
python -m vericare_ml.export_fixture
python -m vericare_ml.model_card
cd ..
npx tsx --test apps/api/test/stage-model.test.ts
```

Calibration takes about fifteen minutes and training about fifteen more on a laptop. `train` caches simulated departments in `ml/data/shards/` and the assembled dataset in `ml/data/snapshots.parquet`; delete both to regenerate. The trained model is deterministic for a given dataset.

## Retraining on real feed history

Nothing in `features.py` or `train.py` depends on the simulator beyond the column names of the event log. For a pilot, replace the simulated runs with OPOR history in the same shape (one timestamp per event kind per visit, plus an order table), keep the split by whole weeks instead of whole departments, and rerun from `train`. The API already logs every estimate with its outcome in `ed_stage_estimates`, which is the evaluation set for shadow mode.

## Data licences

- NHAMCS: US government work, public domain. <https://www.cdc.gov/nchs/nhamcs/>
- MIMIC-IV Clinical Database Demo and MIMIC-IV-ED Demo v2.2: Open Database License v1.0. <https://physionet.org/content/mimic-iv-demo/2.2/>

Raw files are not committed. The trained model contains tree thresholds only, no records.
