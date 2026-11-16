"""Is gradient boosting the right model family here? A head-to-head on the same data.

Same training departments, same held-out departments, same three percentiles, same
metric (pinball loss in minutes, before any conformal adjustment) for:

- the shipped model: gradient-boosted quantile trees (the XGBoost / LightGBM family)
- a larger gradient-boosted model, to see how much headroom tuning has
- a neural network trained on the pinball loss, in two set-ups
- a linear quantile model, as the floor

Run from ml/ after training:  python -m vericare_ml.compare_models
Writes artifacts/model_comparison.json.
"""

from __future__ import annotations

import json
import pickle
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor

from .features import FEATURES
from .train import ALPHA, QUANTILES, conformal, pinball

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "artifacts" / "model_comparison.json"
TARGETS = ["provider", "results", "decision"]
TESTS = ["test_reference", "test_regional", "test_surge", "test_unseen"]
Q = np.array(QUANTILES, dtype=np.float32)
RAW = {"hour_sin", "hour_cos"}
ONE_HOT = {"ctas": [1, 2, 3, 4, 5], "step": [0, 1, 2, 3], "weekday": list(range(7))}


class Prep:
    """What a neural net needs and trees do not: log scaling, standardising, missing flags."""

    def fit(self, frame: pd.DataFrame) -> "Prep":
        x = self._scaled(frame)
        self.mean = np.nanmean(x, axis=0)
        self.std = np.nanstd(x, axis=0) + 1e-6
        self.flags = np.flatnonzero(np.isnan(x).any(axis=0))
        return self

    @staticmethod
    def _scaled(frame: pd.DataFrame) -> np.ndarray:
        x = frame[FEATURES].to_numpy(np.float32, copy=True)
        for index, name in enumerate(FEATURES):
            if name not in RAW:
                x[:, index] = np.log1p(np.maximum(x[:, index], 0))
        return x

    def transform(self, frame: pd.DataFrame) -> np.ndarray:
        x = self._scaled(frame)
        missing = np.isnan(x)
        x = np.where(missing, 0, (x - self.mean) / self.std)
        parts = [x, missing[:, self.flags].astype(np.float32)]
        for name, levels in ONE_HOT.items():
            column = frame[name].to_numpy()
            parts.append(np.stack([(column == level) for level in levels], axis=1).astype(np.float32))
        return np.concatenate(parts, axis=1).astype(np.float32)


def train_net(x: np.ndarray, y: np.ndarray, xv: np.ndarray, yv: np.ndarray, hidden: tuple,
              epochs: int = 22, batch: int = 4096, lr: float = 2e-3, seed: int = 0):  # fmt: skip
    """A plain feed-forward net with ReLU, Adam and cosine decay, minimising pinball loss."""
    rng = np.random.default_rng(seed)
    sizes = [x.shape[1], *hidden, len(Q)]
    weights = [rng.normal(0, np.sqrt(2 / a), (a, b)).astype(np.float32)
               for a, b in zip(sizes[:-1], sizes[1:])]  # fmt: skip
    biases = [np.zeros(b, np.float32) for b in sizes[1:]]
    biases[-1][:] = np.quantile(y, Q)
    params = weights + biases
    m = [np.zeros_like(p) for p in params]
    v = [np.zeros_like(p) for p in params]

    def forward(data: np.ndarray):
        acts = [data]
        for index, (w, b) in enumerate(zip(weights, biases)):
            z = acts[-1] @ w + b
            acts.append(np.maximum(z, 0) if index < len(weights) - 1 else z)
        return acts

    def loss(data: np.ndarray, truth: np.ndarray) -> float:
        diff = truth[:, None] - forward(data)[-1]
        return float(np.mean(np.maximum(Q * diff, (Q - 1) * diff)))

    steps = epochs * (len(x) // batch)
    step = 0
    best = (np.inf, None)
    for _ in range(epochs):
        order = rng.permutation(len(x))
        for start in range(0, len(x) - batch + 1, batch):
            rows = order[start : start + batch]
            acts = forward(x[rows])
            diff = y[rows][:, None] - acts[-1]
            grad = np.where(diff > 0, -Q, 1 - Q).astype(np.float32) / (batch * len(Q))
            grads_w, grads_b = [], []
            for index in range(len(weights) - 1, -1, -1):
                grads_w.append(acts[index].T @ grad)
                grads_b.append(grad.sum(axis=0))
                if index:
                    grad = (grad @ weights[index].T) * (acts[index] > 0)
            grads = grads_w[::-1] + grads_b[::-1]
            step += 1
            rate = lr * 0.5 * (1 + np.cos(np.pi * step / steps))
            for index, (p, g) in enumerate(zip(params, grads)):
                m[index] = 0.9 * m[index] + 0.1 * g
                v[index] = 0.999 * v[index] + 0.001 * g * g
                p -= rate * (m[index] / (1 - 0.9**step)) / (np.sqrt(v[index] / (1 - 0.999**step)) + 1e-8)
        score = loss(xv, yv)
        if score < best[0]:
            best = (score, [p.copy() for p in params])
    n = len(weights)
    weights[:], biases[:] = best[1][:n], best[1][n:]
    return lambda data: np.sort(
        np.concatenate([forward(data[i : i + 200_000])[-1] for i in range(0, len(data), 200_000)]),
        axis=1,
    )


def score(truth: np.ndarray, pred: np.ndarray, cal_truth: np.ndarray, cal_pred: np.ndarray) -> dict:
    """Pinball before calibration; coverage and width after the same pooled conformal step."""
    level = 1 - ALPHA / 2
    lower = conformal(cal_pred[:, 0] - cal_truth, level)
    upper = conformal(cal_truth - cal_pred[:, 2], level)
    low, high = np.maximum(0, pred[:, 0] - lower), pred[:, 2] + upper
    return {
        "pinball": round(float(np.mean([pinball(truth, pred[:, i], q)
                                        for i, q in enumerate(QUANTILES)])), 3),
        "median_error_min": round(float(np.mean(np.abs(truth - pred[:, 1]))), 2),
        "coverage": round(float(np.mean((truth >= low) & (truth <= high))), 4),
        "median_width_min": round(float(np.median(high - low)), 1),
    }  # fmt: skip


def main() -> None:
    started = time.time()
    frame = pd.read_parquet(ROOT / "data" / "snapshots.parquet")
    with open(ROOT / "data" / "fitted.pkl", "rb") as handle:
        fitted = pickle.load(handle)
    report: dict = {}
    for target in TARGETS:
        y = f"y_{target}"
        rows = frame[frame[y].notna()]
        train = rows[rows.group == "train"]
        if len(train) > 900_000:
            train = train.sample(900_000, random_state=1)  # the sample the shipped model saw
        cal = rows[rows.group == "calibrate"].sample(frac=1, random_state=2).head(300_000)
        test = rows[rows.group.isin(TESTS)]
        truth, cal_truth = test[y].to_numpy(), cal[y].to_numpy()
        entry: dict = {"train_rows": int(len(train)), "test_rows": int(len(test))}

        def add(name: str, predict, seconds: float) -> None:
            entry[name] = {**score(truth, predict(test), cal_truth, predict(cal)),
                           "train_seconds": round(seconds)}  # fmt: skip
            print(target, name, entry[name], f"({time.time() - started:.0f}s)", flush=True)

        shipped = fitted[target]["models"]
        add("boosted_trees_shipped",
            lambda d: np.stack([shipped[q].predict(d[FEATURES]) for q in QUANTILES], axis=1), 0)  # fmt: skip

        prep = Prep().fit(train)
        x, xc = prep.transform(train), prep.transform(cal)
        cache = {id(cal): xc, id(test): prep.transform(test)}
        scale = float(train[y].std())
        targets = {
            "minutes": (lambda v: v / scale, lambda p: p * scale),
            "log_minutes": (np.log1p, np.expm1),
        }
        for label, hidden in (("linear", ()), ("neural_net", (256, 256, 128))):
            for space, (to, back) in targets.items():
                if label == "linear" and space == "log_minutes":
                    continue
                t0 = time.time()
                net = train_net(x, to(train[y].to_numpy(np.float32)).astype(np.float32),
                                xc[:100_000], to(cal_truth[:100_000]).astype(np.float32), hidden)  # fmt: skip
                add(f"{label}_{space}", lambda d, net=net, back=back: back(net(cache[id(d)])),
                    time.time() - t0)  # fmt: skip
        if target == "provider" and "--quick" not in sys.argv:
            t0 = time.time()
            big = {q: HistGradientBoostingRegressor(
                loss="quantile", quantile=q, max_iter=600, learning_rate=0.06, max_leaf_nodes=63,
                min_samples_leaf=100, l2_regularization=1.0, early_stopping=True,
                validation_fraction=0.1, n_iter_no_change=20, random_state=0,
            ).fit(train[FEATURES], train[y]) for q in QUANTILES}  # fmt: skip
            add("boosted_trees_larger",
                lambda d: np.stack([big[q].predict(d[FEATURES]) for q in QUANTILES], axis=1),
                time.time() - t0)  # fmt: skip
        report[target] = entry
        OUT.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(f"done in {time.time() - started:.0f}s")


if __name__ == "__main__":
    main()
