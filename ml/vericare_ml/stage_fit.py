"""What the open patient records say about each stage of a visit.

Outputs
- data/patient_pool.parquet: real NHAMCS visits the simulator resamples. Each
  keeps its real triage level, age, arrival mode, orders, outcome and the real
  minutes from first provider contact to the end of the visit.
- artifacts/stage_params.json: arrival curves, lab turnaround fitted on MIMIC
  demo timestamps, the crowding effect, and cross-checks of the published
  turnaround figures against NHAMCS.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.linear_model import LinearRegression, QuantileRegressor

from . import nhamcs

ROOT = Path(__file__).resolve().parents[1]
POOL = ROOT / "data" / "patient_pool.parquet"
PARAMS = ROOT / "artifacts" / "stage_params.json"
MIMIC = ROOT / "data" / "raw" / "mimic-demo"

POOL_COLUMNS = ["esi", "age", "ems", "lab", "troponin", "xray", "ct", "us", "mri", "consult",
                "outcome", "post", "weight"]  # fmt: skip


def _lognormal(sample: pd.Series) -> dict:
    """Median and log-sd from the quartiles, which ignores the long add-on-test tail."""
    q1, q2, q3 = sample.quantile([0.25, 0.5, 0.75])
    return {
        "n": int(sample.size),
        "median": round(float(q2), 1),
        "sigma": round(float(np.log(q3 / q1) / 1.349), 3),
        "p90_observed": round(float(sample.quantile(0.9)), 1),
    }


def lab_turnaround() -> dict:
    """Collected-to-resulted minutes for blood tests drawn during an ED stay (MIMIC demo)."""
    lab = pd.read_csv(MIMIC / "labevents.csv.gz", parse_dates=["charttime", "storetime"])
    items = pd.read_csv(MIMIC / "d_labitems.csv.gz")[["itemid", "label", "fluid", "category"]]
    stays = pd.read_csv(MIMIC / "edstays.csv.gz", parse_dates=["intime", "outtime"])
    lab = lab.merge(items, on="itemid").merge(
        stays[["subject_id", "stay_id", "intime", "outtime"]], on="subject_id"
    )
    lab = lab[(lab.charttime >= lab.intime) & (lab.charttime <= lab.outtime)]
    lab["tat"] = (lab.storetime - lab.charttime).dt.total_seconds() / 60
    lab = lab[(lab.tat > 0) & (lab.tat < 24 * 60) & (lab.fluid == "Blood")]
    routine = lab[lab.category.isin(["Chemistry", "Hematology"])]
    # A "panel" is what one bloodwork order returns: every routine test from the first draw.
    first = routine.groupby("stay_id").charttime.transform("min")
    panel = routine[routine.charttime <= first + pd.Timedelta(minutes=15)]
    # The slowest routine analyte decides when the order is complete; the 90th percentile of
    # tests inside the draw drops rare send-outs that would not hold up a decision.
    panel_done = panel.groupby("stay_id").tat.quantile(0.9)
    troponin = lab[lab.label.str.contains("Troponin", case=False)]
    return {
        "stays_with_bloodwork": int(panel.stay_id.nunique()),
        "hematology_test": _lognormal(lab[lab.category == "Hematology"].tat),
        "chemistry_test": _lognormal(lab[lab.category == "Chemistry"].tat),
        "panel": _lognormal(panel_done),
        "troponin": _lognormal(troponin.tat),
    }


def crowding_effect(visits: pd.DataFrame) -> dict:
    """How much longer the seen-to-done time runs in departments with longer waits.

    NHAMCS has no census, so a hospital's average wait among its other sampled visits is
    the crowding proxy. The coefficient is an elasticity: d log(post) / d log(1 + wait).
    """
    seen = visits[visits.outcome.isin(["home", "admit", "transfer", "ama"])
                  & visits.post.notna() & visits.esi.notna()].copy()  # fmt: skip
    by_hospital = visits.groupby("hospital").wait.agg(["sum", "count"])
    seen = seen.join(by_hospital, on="hospital")
    seen = seen[seen["count"] >= 30]
    own = seen.wait.fillna(seen["sum"] / seen["count"])
    seen["crowd"] = np.log1p((seen["sum"] - own) / (seen["count"] - 1))
    design = pd.get_dummies(
        seen[["esi", "outcome"]].astype({"esi": int}).astype(str), drop_first=True
    ).astype(float)
    for column in ["lab", "troponin", "xray", "ct", "us", "mri", "consult", "ems", "crowd"]:
        design[column] = seen[column].astype(float)
    design["age"] = seen.age / 10
    model = LinearRegression().fit(design, np.log(seen.post.clip(lower=5)))
    beta = float(model.coef_[list(design.columns).index("crowd")])
    return {
        "elasticity": round(beta, 4),
        "n": int(len(seen)),
        "baseline_wait_min": round(float(np.expm1(seen.crowd.mean())), 1),
    }


def order_increments(visits: pd.DataFrame) -> dict:
    """Median extra minutes a visit runs when each kind of order is present (home discharges).

    A cross-check on the published turnaround figures: two unrelated sources should agree.
    """
    home = visits[(visits.outcome == "home") & visits.post.notna() & visits.esi.notna()]
    home = home.sample(n=min(len(home), 20000), random_state=7)
    columns = ["lab", "troponin", "xray", "ct", "us", "mri", "consult"]
    design = home[columns].astype(float)
    result = {"n": int(len(home))}
    for quantile in (0.5, 0.9):
        model = QuantileRegressor(quantile=quantile, alpha=0.0, solver="highs")
        model.fit(design, home.post.clip(upper=1440))
        result[f"q{int(quantile * 100)}"] = {
            "no_orders": round(float(model.intercept_), 0),
            **{name: round(float(value), 0) for name, value in zip(columns, model.coef_)},
        }
    return result


def build() -> dict:
    visits = nhamcs.load()
    pool = visits[
        visits.esi.notna()
        & visits.age.notna()
        & visits.outcome.isin(["home", "admit", "transfer", "ama"])
        & visits.post.notna()
    ][POOL_COLUMNS].copy()
    # A handful of multi-day observation and psychiatric holds would dominate a simulated
    # department. Cap the seen-to-decision time at 24 hours.
    pool["post"] = pool.post.clip(lower=5, upper=1440)
    pool["esi"] = pool.esi.astype(int)
    pool["admit"] = (pool.outcome == "admit").astype(int)
    pool = pool.drop(columns=["outcome"]).reset_index(drop=True)
    POOL.parent.mkdir(parents=True, exist_ok=True)
    pool.to_parquet(POOL)

    timed = visits.dropna(subset=["hour"])
    hourly = timed.groupby("hour").weight.sum()
    weekday = visits.groupby("weekday").weight.sum()
    left = visits[visits.outcome == "lwbs"]
    by_hospital = visits.groupby("hospital").agg(
        wait=("wait", "mean"), n=("wait", "size"), left=("outcome", lambda s: (s == "lwbs").mean())
    )
    by_hospital = by_hospital[by_hospital.n >= 30]
    bins = pd.cut(by_hospital.wait, [0, 15, 30, 60, 90, 1000])
    walkout_curve = by_hospital.groupby(bins, observed=True).agg(
        hospitals=("n", "size"), mean_wait=("wait", "mean"), left_share=("left", "mean")
    )
    params = {
        "pool": {
            "visits": int(len(pool)),
            "from_visits": int(len(visits)),
            "admit_share_weighted": round(float(np.average(pool.admit, weights=pool.weight)), 4),
            "post_median_min": round(float(pool.post.median()), 0),
            "post_p90_min": round(float(pool.post.quantile(0.9)), 0),
        },
        "arrival_hour_share": [round(float(x), 5) for x in (hourly / hourly.sum()).tolist()],
        "arrival_weekday_factor": [round(float(x), 4) for x in (7 * weekday / weekday.sum())],
        "ems_share_by_hour": [round(float(x), 3) for x in timed.groupby("hour").ems.mean()],
        "lab_turnaround": lab_turnaround(),
        "crowding": crowding_effect(visits),
        "order_increments_home": order_increments(visits),
        "walkouts_us": {
            "share": round(float((visits.outcome == "lwbs").mean()), 4),
            "left_after_min": {
                "median": float(left.lov.median()),
                "p90": float(left.lov.quantile(0.9)),
            },
            "by_hospital_wait": [
                {"mean_wait_min": round(float(r.mean_wait), 1),
                 "left_share": round(float(r.left_share), 4), "hospitals": int(r.hospitals)}
                for r in walkout_curve.itertuples()
            ],  # fmt: skip
        },
        "boarding_us_min": {
            "median": float(visits.boarded[visits.boarded > 0].median()),
            "p90": float(visits.boarded[visits.boarded > 0].quantile(0.9)),
        },
    }
    PARAMS.parent.mkdir(parents=True, exist_ok=True)
    PARAMS.write_text(json.dumps(params, indent=2) + "\n")
    return params


if __name__ == "__main__":
    print(json.dumps(build(), indent=2))
