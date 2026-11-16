"""Second calibration pass: damped corrections on long runs, where the first pass's
short runs were too noisy to land within tolerance."""

from __future__ import annotations

import json
from dataclasses import replace

from .calibrate import OUT, TARGETS, load, measure
from .sim import site_dict

SEEDS = (11, 12, 13, 14)


def refine(rounds: int = 8) -> None:
    site = load()
    best = None
    for step in range(rounds):
        got = measure(site, days=150, seeds=SEEDS)
        miss = {key: got[key] / TARGETS[key] for key in TARGETS}
        error = max(abs(value - 1) for value in miss.values())
        print(step, {k: round(got[k], 3) for k in TARGETS}, "worst miss", round(error, 3), flush=True)
        if best is None or error < best[0]:
            best = (error, site, got)
        if error < 0.04:
            break
        # Longer waits need busier providers; more walkouts need less patience; longer bed
        # waits need fewer beds. Exponents are damped sensitivities seen in earlier probes.
        site = replace(
            site,
            staffing_util=site.staffing_util * miss["wait_mean"] ** -0.12,
            patience_min=site.patience_min * miss["lwbs_share"] ** 0.9 * miss["wait_mean"] ** -0.5,
            bed_ratio=site.bed_ratio * miss["bed_wait_mean"] ** 0.06,
        )
    _, site, got = best
    OUT.write_text(json.dumps({
        "site": site_dict(site),
        "targets": TARGETS,
        "achieved": {key: round(value, 4) for key, value in got.items()},
        "measured_on": {"days_per_run": 150, "runs": len(SEEDS)},
    }, indent=2) + "\n")  # fmt: skip


if __name__ == "__main__":
    refine()
