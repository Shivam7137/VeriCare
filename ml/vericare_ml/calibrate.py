"""Tune the reference department until it reproduces Nova Scotia's published figures.

Three knobs, three targets:
- provider utilisation  -> average wait from triage to a clinician (NS: 178 min)
- patience              -> share who leave without being seen (NS: 10.02%)
- inpatient bed supply  -> average wait for a bed (Ontario stand-in: 780 min)

Everything else about the reference site is fixed in `sim.Site`. The result is
written to artifacts/calibration.json with the simulated value beside each target.
"""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

import numpy as np

from .sim import Site, simulate, site_dict
from .sources import ANCHORS

OUT = Path(__file__).resolve().parents[1] / "artifacts" / "calibration.json"
TARGETS = {
    "wait_mean": ANCHORS["ns_mean_wait_min"]["value"],
    "lwbs_share": ANCHORS["ns_lwbs_share"]["value"],
    "bed_wait_mean": ANCHORS["ontario_bed_wait_min"]["value"]["mean"],
}


def measure(site: Site, days: int = 90, seeds: tuple = (11, 12, 13)) -> dict:
    runs = [simulate(replace(site, seed=seed), days).stats for seed in seeds]
    keys = [key for key, value in runs[0].items() if isinstance(value, (int, float))]
    return {key: float(np.mean([run[key] for run in runs])) for key in keys}


def _bisect(evaluate, target: float, low: float, high: float, rising: bool, steps: int) -> float:
    for _ in range(steps):
        middle = (low + high) / 2
        if (evaluate(middle) < target) == rising:
            low = middle
        else:
            high = middle
    return (low + high) / 2


def _quick(site: Site) -> dict:
    return measure(site, days=60, seeds=(11, 12))


def calibrate(base: Site | None = None, rounds: int = 2) -> tuple[Site, dict]:
    site = base or Site(name="ns-reference")
    for _ in range(rounds):
        # Bed waits depend almost only on admissions against bed supply, so they go first.
        site = replace(site, bed_ratio=_bisect(
            lambda x: _quick(replace(site, bed_ratio=x))["bed_wait_mean"],
            TARGETS["bed_wait_mean"], 0.95, 1.3, rising=False, steps=8))  # fmt: skip

        # Waits and walkouts are coupled: for each staffing level, find the patience that
        # gives the published walkout share, then move staffing until the wait matches too.
        def patience_for(util: float) -> float:
            return _bisect(
                lambda x: _quick(replace(site, staffing_util=util, patience_min=x))["lwbs_share"],
                TARGETS["lwbs_share"], 150, 1600, rising=False, steps=7)  # fmt: skip

        def wait_at(util: float) -> float:
            trial = replace(site, staffing_util=util, patience_min=patience_for(util))
            return _quick(trial)["wait_mean"]

        util = _bisect(wait_at, TARGETS["wait_mean"], 0.9, 1.25, rising=True, steps=7)
        site = replace(site, staffing_util=util, patience_min=patience_for(util))
    return site, measure(site, days=120)


def load() -> Site:
    return Site(**json.loads(OUT.read_text())["site"])


if __name__ == "__main__":
    site, achieved = calibrate()
    report = {
        "site": site_dict(site),
        "targets": TARGETS,
        "achieved": {key: round(value, 4) for key, value in achieved.items()},
    }
    OUT.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
