"""Train, calibrate, evaluate and export the stage-time models.

Five targets, each the minutes from now until a milestone the feed will report:
triage, first provider, results back (for the orders open now), the decision
(discharge or admission), and the move to an inpatient bed. Each target gets
three gradient-boosted quantile models (10th, 50th, 90th percentile), then the
outer two are adjusted on held-out departments so the range covers 80% of what
happened there (conformalized quantile regression, per stratum).

Departments are split, never rows: a department used for training is never used
for calibration or testing.

Run from ml/:  python -m vericare_ml.train
"""

from __future__ import annotations

import gzip
import json
import math
import time
from dataclasses import replace
from pathlib import Path

import numpy as np
import pandas as pd
from joblib import Parallel, delayed
from sklearn.ensemble import HistGradientBoostingRegressor

from . import calibrate
from .features import FEATURES, TARGETS, snapshots
from .sim import Site, simulate, site_dict

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "artifacts"
QUANTILES = (0.1, 0.5, 0.9)
ALPHA = 0.2
VERSION = "stage-gbq-1"
# The API only ever looks at ranges for these combinations; training rows follow suit.
MIN_STRATUM = 300
SHARDS = ROOT / "data" / "shards"
WORKERS = 4


def random_site(reference: Site, rng: np.random.Generator, index: int) -> Site:
    """A department unlike the reference in every respect the model should not rely on."""
    mix = rng.dirichlet(np.array(reference.ctas_mix) * 60)
    raz = 0.0 if rng.random() < 0.2 else float(rng.uniform(0.05, 0.3))
    return replace(
        reference,
        name=f"random-{index}",
        volume=float(np.exp(rng.uniform(np.log(70), np.log(280)))),
        ctas_mix=tuple(float(x) for x in mix),
        raz_share=raz,
        raz_open=(int(rng.integers(7, 11)), int(rng.integers(18, 25))),
        staffing_util=reference.staffing_util * float(rng.uniform(0.8, 1.06)),
        service_min=float(rng.uniform(24, 36)),
        raz_service_min=float(rng.uniform(14, 22)),
        bed_factor=float(rng.uniform(1.1, 1.6)),
        aging=float(rng.uniform(0.6, 1.6)),
        patience_min=reference.patience_min * float(np.exp(rng.uniform(np.log(0.6), np.log(1.6)))),
        tell_staff=float(rng.uniform(0.1, 0.6)),
        pre_order=float(rng.uniform(0.3, 1.3)),
        lab_speed=float(rng.uniform(0.75, 1.35)),
        imaging_speed=float(rng.uniform(0.7, 1.5)),
        load_kappa=float(rng.uniform(0, 0.35)),
        stretch=float(rng.uniform(0, 0.1)),
        bed_ratio=reference.bed_ratio + float(rng.uniform(-0.03, 0.08)),
        bed_noise=float(rng.uniform(0.08, 0.18)),
        bed_bank=int(rng.integers(0, 5)),
        triage_util=float(rng.uniform(0.7, 0.95)),
        surge_per_day=float(rng.uniform(0, 0.4)),
        seed=int(rng.integers(1, 2**31)),
    )


def _one(site: Site, days: int, group: str) -> dict:
    """Simulates one department and writes its snapshots to a shard, so a rerun can resume."""
    shard = SHARDS / f"{site.name}.parquet"
    stats_path = SHARDS / f"{site.name}.json"
    if shard.exists() and stats_path.exists():
        return json.loads(stats_path.read_text())
    run = simulate(site, days)
    rows = snapshots(run, np.random.default_rng(site.seed + 1))
    rows["site"] = site.name
    rows["group"] = group
    rows.to_parquet(shard)
    stats = {"site": site.name, "group": group, "config": site_dict(site), **run.stats}
    stats_path.write_text(json.dumps(stats))
    return stats


def build_dataset(reference: Site, seed: int = 2026) -> tuple[pd.DataFrame, list[dict]]:
    rng = np.random.default_rng(seed)
    jobs: list[tuple[Site, int, str]] = []
    for index in range(72):
        jobs.append((random_site(reference, rng, index), 24, "train"))
    for index in range(72, 96):
        jobs.append((random_site(reference, rng, index), 24, "calibrate"))
    jobs.append((replace(reference, name="ns-reference-cal", seed=501), 45, "calibrate"))
    # Held out: the Nova Scotia reference on fresh days, a smaller regional site, a week of
    # repeated surges, and departments the model has never seen.
    jobs.append((replace(reference, name="test-ns-reference", seed=901), 60, "test_reference"))
    regional = replace(
        reference, name="test-regional", volume=123.0, ctas_mix=(0.01, 0.15, 0.49, 0.28, 0.07),
        raz_share=0.12, seed=902,
    )  # fmt: skip
    jobs.append((regional, 60, "test_regional"))
    jobs.append((replace(reference, name="test-surge", surge_per_day=1.5, seed=903), 45, "test_surge"))
    for index in range(96, 108):
        jobs.append((random_site(reference, rng, index), 24, "test_unseen"))
    SHARDS.mkdir(parents=True, exist_ok=True)
    # A few workers only: each holds pandas and a simulated department in memory.
    sites = Parallel(n_jobs=WORKERS)(delayed(_one)(*job) for job in jobs)
    frame = pd.concat(
        [pd.read_parquet(SHARDS / f"{site.name}.parquet") for site, _, _ in jobs],
        ignore_index=True,
    )
    return frame, sites


# ---- strata -----------------------------------------------------------------------------


def strata(frame: pd.DataFrame, target: str) -> pd.Series:
    """Calibration cell: triage band x time of day (x step for the decision outlook)."""
    ctas = frame.ctas.to_numpy()
    band = np.select([np.isnan(ctas), ctas <= 2, ctas == 3], ["u", "12", "3"], "45")
    hour = (np.degrees(np.arctan2(frame.hour_sin, frame.hour_cos)) % 360) / 15
    block = np.select([hour < 8, hour < 16], ["n", "d"], "e")
    key = pd.Series(band, index=frame.index) + "|" + block
    if target == "decision":
        key = np.where(frame.step.to_numpy() == 1, "w|", "s|") + key
    return pd.Series(key, index=frame.index)


def conformal(scores: np.ndarray, level: float) -> float:
    n = scores.size
    k = min(n, math.ceil((n + 1) * level))
    return float(np.partition(scores, k - 1)[k - 1])


# ---- models -----------------------------------------------------------------------------


def fit_target(frame: pd.DataFrame, target: str) -> dict:
    y = f"y_{target}"
    train = frame[(frame.group == "train") & frame[y].notna()]
    cal = frame[(frame.group == "calibrate") & frame[y].notna()]
    if len(train) > 900_000:
        train = train.sample(900_000, random_state=1)
    models = {}
    for quantile in QUANTILES:
        model = HistGradientBoostingRegressor(
            loss="quantile", quantile=quantile, max_iter=160, learning_rate=0.1,
            max_leaf_nodes=20, min_samples_leaf=150, l2_regularization=1.0,
            early_stopping=True, validation_fraction=0.1, n_iter_no_change=12, random_state=0,
        )  # fmt: skip
        models[quantile] = model.fit(train[FEATURES], train[y])
    low = models[0.1].predict(cal[FEATURES])
    high = models[0.9].predict(cal[FEATURES])
    truth = cal[y].to_numpy()
    keys = strata(cal, target).to_numpy()
    level = 1 - ALPHA / 2
    pooled = [conformal(low - truth, level), conformal(truth - high, level)]
    cells = {}
    for key in np.unique(keys):
        mask = keys == key
        if mask.sum() >= MIN_STRATUM:
            cells[key] = [conformal((low - truth)[mask], level),
                          conformal((truth - high)[mask], level)]  # fmt: skip
    # Static typical range: what a lookup table by triage level and step would say.
    static = (
        train.assign(k=strata(train, target).str.replace(r"\|[nde]$", "", regex=True))
        .groupby("k")[y].quantile(list(QUANTILES)).unstack()
    )  # fmt: skip
    return {
        "models": models,
        "conformal": {"pooled": pooled, "cells": cells},
        "static": {key: [float(v) for v in row] for key, row in static.iterrows()},
        "rows": {"train": int(len(train)), "calibrate": int(len(cal))},
    }


def predict(fitted: dict, frame: pd.DataFrame, target: str) -> pd.DataFrame:
    """Calibrated low / typical / high minutes for every row."""
    raw = {q: fitted["models"][q].predict(frame[FEATURES]) for q in QUANTILES}
    keys = strata(frame, target).to_numpy()
    cells, pooled = fitted["conformal"]["cells"], fitted["conformal"]["pooled"]
    adjust = np.array([cells.get(key, pooled) for key in keys])
    low = np.maximum(0, raw[0.1] - adjust[:, 0])
    high = np.maximum(raw[0.9] + adjust[:, 1], low + 1)
    middle = np.clip(raw[0.5], low, high)
    return pd.DataFrame({"low": low, "mid": middle, "high": high}, index=frame.index)


# ---- evaluation -------------------------------------------------------------------------


def pinball(truth: np.ndarray, guess: np.ndarray, q: float) -> float:
    diff = truth - guess
    return float(np.mean(np.maximum(q * diff, (q - 1) * diff)))


def score(truth: np.ndarray, low: np.ndarray, mid: np.ndarray, high: np.ndarray) -> dict:
    return {
        "n": int(truth.size),
        "coverage": round(float(np.mean((truth >= low) & (truth <= high))), 4),
        "ran_over": round(float(np.mean(truth > high)), 4),
        "came_early": round(float(np.mean(truth < low)), 4),
        "median_width_min": round(float(np.median(high - low)), 1),
        "mae_min": round(float(np.mean(np.abs(truth - mid))), 1),
        "pinball": round(
            (pinball(truth, low, 0.1) + pinball(truth, mid, 0.5) + pinball(truth, high, 0.9)) / 3, 2
        ),
    }


def evaluate(fitted: dict, frame: pd.DataFrame) -> dict:
    report: dict = {}
    for target in TARGETS:
        y = f"y_{target}"
        report[target] = {}
        static = fitted[target]["static"]
        for group in ["test_reference", "test_regional", "test_surge", "test_unseen"]:
            rows = frame[(frame.group == group) & frame[y].notna()]
            if len(rows) < 50:
                continue
            truth = rows[y].to_numpy()
            ranges = predict(fitted[target], rows, target)
            entry = {"model": score(truth, ranges.low.to_numpy(), ranges.mid.to_numpy(),
                                    ranges.high.to_numpy())}  # fmt: skip
            keys = strata(rows, target).str.replace(r"\|[nde]$", "", regex=True)
            fallback = np.array(next(iter(static.values())))
            table = np.array([static.get(key, fallback) for key in keys])
            entry["typical_range_table"] = score(truth, table[:, 0], table[:, 1], table[:, 2])
            if target == "provider":
                entry.update(provider_baselines(fitted, frame, rows))
            entry["pinball_gain_vs_table"] = round(
                1 - entry["model"]["pinball"] / entry["typical_range_table"]["pinball"], 3
            )
            by_cell = {}
            cells = strata(rows, target).to_numpy()
            for key in np.unique(cells):
                mask = cells == key
                if mask.sum() >= 200:
                    by_cell[key] = round(float(np.mean(
                        (truth[mask] >= ranges.low.to_numpy()[mask])
                        & (truth[mask] <= ranges.high.to_numpy()[mask]))), 3)  # fmt: skip
            entry["coverage_by_cell"] = by_cell
            report[target][group] = entry
    return report


def provider_baselines(fitted: dict, frame: pd.DataFrame, rows: pd.DataFrame) -> dict:
    """What the wait-to-be-seen estimate is up against: a rolling average and the queue formula."""
    cal = frame[(frame.group == "calibrate") & frame.y_provider.notna()]
    truth = rows.y_provider.to_numpy()
    out = {}

    def rolling(data: pd.DataFrame) -> np.ndarray:
        recent = np.where(data.raz == 1, data.recent_wait_raz, data.recent_wait_main)
        recent = np.where(np.isnan(recent), np.nanmedian(recent), recent)
        return np.maximum(recent - data.since_triage.to_numpy(), 5)

    def fluid(data: pd.DataFrame) -> np.ndarray:
        point = data.fluid.to_numpy()
        return np.where(np.isnan(point), np.nanmedian(point), point)

    for name, point_of in (("rolling_average", rolling), ("queue_formula", fluid)):
        ratio = cal.y_provider.to_numpy() / np.maximum(point_of(cal), 5)
        lo, hi = np.quantile(ratio, [ALPHA / 2, 1 - ALPHA / 2])
        mid = float(np.median(ratio))
        point = np.maximum(point_of(rows), 5)
        out[name] = score(truth, lo * point, mid * point, hi * point)
    model = score(truth, *[predict(fitted["provider"], rows, "provider")[c].to_numpy()
                           for c in ("low", "mid", "high")])  # fmt: skip
    out["pinball_gain_vs_rolling"] = round(1 - model["pinball"] / out["rolling_average"]["pinball"], 3)
    out["pinball_gain_vs_formula"] = round(1 - model["pinball"] / out["queue_formula"]["pinball"], 3)

    # The comparison the literature makes: one estimate issued at triage, with the rolling
    # average used as posted (no allowance for time already waited).
    def posted(data: pd.DataFrame) -> np.ndarray:
        recent = np.where(data.raz == 1, data.recent_wait_raz, data.recent_wait_main)
        return np.where(np.isnan(recent), np.nanmedian(recent), recent)

    cal_t = cal[cal.since_triage <= 15]
    rows_t = rows[rows.since_triage <= 15]
    truth_t = rows_t.y_provider.to_numpy()
    at_triage = {"model": score(truth_t, *[predict(fitted["provider"], rows_t, "provider")[c]
                                           .to_numpy() for c in ("low", "mid", "high")])}  # fmt: skip
    for name, point_of in (("rolling_average", posted), ("queue_formula", fluid)):
        ratio = cal_t.y_provider.to_numpy() / np.maximum(point_of(cal_t), 5)
        lo, hi = np.quantile(ratio, [ALPHA / 2, 1 - ALPHA / 2])
        point = np.maximum(point_of(rows_t), 5)
        at_triage[name] = score(truth_t, lo * point, float(np.median(ratio)) * point, hi * point)
        at_triage[f"pinball_gain_vs_{name}"] = round(
            1 - at_triage["model"]["pinball"] / at_triage[name]["pinball"], 3)  # fmt: skip
        at_triage[f"mae_gain_vs_{name}"] = round(
            1 - at_triage["model"]["mae_min"] / at_triage[name]["mae_min"], 3)  # fmt: skip
    out["at_triage"] = at_triage
    return out


# ---- export -----------------------------------------------------------------------------


def pack(model: HistGradientBoostingRegressor) -> dict:
    """Trees as flat arrays. Leaves have feature -1."""
    trees = []
    for (predictor,) in model._predictors:  # noqa: SLF001 - no public tree accessor exists
        nodes = predictor.nodes
        leaf = nodes["is_leaf"].astype(bool)
        trees.append({
            "f": np.where(leaf, -1, nodes["feature_idx"]).astype(int).tolist(),
            # A split on "is the value missing" has an infinite threshold, which JSON cannot
            # carry; any finite value compares the same way against 1e300.
            "t": [0 if is_leaf else min(float(x), 1e300)
                  for x, is_leaf in zip(nodes["num_threshold"], leaf)],
            "l": nodes["left"].astype(int).tolist(),
            "r": nodes["right"].astype(int).tolist(),
            "m": nodes["missing_go_to_left"].astype(int).tolist(),
            "v": [round(float(x), 5) for x in nodes["value"]],
        })  # fmt: skip
    return {"base": float(np.ravel(model._baseline_prediction)[0]), "trees": trees}  # noqa: SLF001


def unpacked_predict(packed: dict, rows: np.ndarray) -> np.ndarray:
    """Reference evaluator for the exported format; the TypeScript one is a line-by-line port."""
    out = np.full(len(rows), packed["base"])
    for tree in packed["trees"]:
        f, t, left, right, miss, v = (tree[k] for k in "ftlrmv")
        for index, row in enumerate(rows):
            node = 0
            while f[node] >= 0:
                x = row[f[node]]
                go_left = bool(miss[node]) if math.isnan(x) else x <= t[node]
                node = left[node] if go_left else right[node]
            out[index] += v[node]
    return out


def export(fitted: dict, report: dict, calibration: dict) -> dict:
    document = {
        "version": VERSION,
        # The dataset's timestamp, so re-exporting the same fit gives the same file.
        "createdAt": time.strftime(
            "%Y-%m-%dT%H:%M:%SZ", time.gmtime((ROOT / "data" / "snapshots.parquet").stat().st_mtime)
        ),
        "features": FEATURES,
        "alpha": ALPHA,
        "targets": {},
    }
    for target in TARGETS:
        document["targets"][target] = {
            "quantiles": {str(q): pack(fitted[target]["models"][q]) for q in QUANTILES},
            "conformal": fitted[target]["conformal"],
            "static": fitted[target]["static"],
        }
    payload = json.dumps(document, separators=(",", ":"), allow_nan=False).encode()
    target_path = ROOT.parent / "apps" / "api" / "models" / "stage-model.json.gz"
    target_path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.GzipFile(target_path, "wb", mtime=0) as handle:
        handle.write(payload)
    (ARTIFACTS / "metrics.json").write_text(json.dumps({
        "version": VERSION,
        "rows": {target: fitted[target]["rows"] for target in TARGETS},
        "trees": {target: {str(q): len(fitted[target]["models"][q]._predictors)  # noqa: SLF001
                           for q in QUANTILES} for target in TARGETS},
        "calibration": calibration,
        "evaluation": report,
    }, indent=2) + "\n")  # fmt: skip
    return {"path": str(target_path), "bytes": target_path.stat().st_size,
            "json_bytes": len(payload)}  # fmt: skip


def main() -> None:
    started = time.time()
    reference = calibrate.load()
    calibration = json.loads(calibrate.OUT.read_text())
    cache = ROOT / "data" / "snapshots.parquet"
    if cache.exists():
        frame = pd.read_parquet(cache)
        sites = json.loads((ROOT / "data" / "sites.json").read_text())
    else:
        frame, sites = build_dataset(reference)
        frame.to_parquet(cache)
        (ROOT / "data" / "sites.json").write_text(json.dumps(sites, indent=1))
    print(f"dataset: {len(frame):,} rows from {frame.site.nunique()} departments "
          f"({time.time() - started:.0f}s)")  # fmt: skip
    print(frame.groupby("group").size().to_string())
    import pickle
    import sys

    saved = ROOT / "data" / "fitted.pkl"
    if "--reuse" in sys.argv and saved.exists():
        # Re-score and re-export the models already fitted, without fitting them again.
        with open(saved, "rb") as handle:
            fitted = pickle.load(handle)
    else:
        fitted = {}
        for target in TARGETS:
            fitted[target] = fit_target(frame, target)
            print(f"fitted {target}: {fitted[target]['rows']} ({time.time() - started:.0f}s)",
                  flush=True)  # fmt: skip
        with open(saved, "wb") as handle:
            pickle.dump(fitted, handle)
    # The exported trees must give the same numbers as scikit-learn.
    sample = frame[frame.y_provider.notna()].sample(300, random_state=3)[FEATURES].to_numpy(float)
    ours = unpacked_predict(pack(fitted["provider"]["models"][0.9]), sample)
    theirs = fitted["provider"]["models"][0.9].predict(pd.DataFrame(sample, columns=FEATURES))
    assert np.allclose(ours, theirs, atol=1e-3), float(np.abs(ours - theirs).max())
    report = evaluate(fitted, frame)
    report["site_wait_range"] = {
        "train_mean_wait_min": [round(min(s["wait_mean"] for s in sites if s["group"] == "train")),
                                round(max(s["wait_mean"] for s in sites if s["group"] == "train"))],
        "train_lwbs_share": [round(min(s["lwbs_share"] for s in sites if s["group"] == "train"), 3),
                             round(max(s["lwbs_share"] for s in sites if s["group"] == "train"), 3)],
        "test_sites": {s["site"]: {k: s[k] for k in ("visits_per_day", "wait_mean", "wait_p90",
                                                     "lwbs_share", "bed_wait_mean")}
                       for s in sites if s["group"].startswith("test")},
    }  # fmt: skip
    info = export(fitted, report, calibration)
    print(json.dumps(info))
    for target in TARGETS:
        for group, entry in report[target].items():
            print(target, group, entry["model"], "gain vs table", entry["pinball_gain_vs_table"],
                  {k: v for k, v in entry.items() if k.startswith("pinball_gain_vs_r")
                   or k.startswith("pinball_gain_vs_f")})  # fmt: skip
    print(f"done in {time.time() - started:.0f}s")


if __name__ == "__main__":
    main()
