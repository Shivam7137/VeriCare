"""Snapshot features and labels, computed from the event log alone.

Every feature here is rebuilt in TypeScript by apps/api/src/journey/stage-features.ts
from the same events the OPOR feed delivers. The two must agree: `export.py` writes a
fixture of events with the features expected from them, and the API test recomputes
them. Change a definition here and the same change is needed there.

Times are minutes. "Now" is the snapshot time. Windows are (now - w, now].
"""

from __future__ import annotations

import math

import numpy as np
import pandas as pd

from .sim import DAY, Run

FEATURES = [
    # the patient
    "ctas", "age", "raz", "step", "since_arrival", "since_triage", "since_provider",
    "since_admit", "open_lab", "open_xray", "open_ct", "open_other", "oldest_open",
    "newest_open", "resulted", "since_last_result", "consult",
    # the patient's place in the queue (waiting patients only)
    "ahead_urgent", "ahead_same", "lower_waited_longer", "fluid", "urgent_arrivals_stream_60",
    "boarders_ahead",
    # the department
    "waiting_main", "waiting_raz", "wait_triage", "waiting_median_elapsed",
    "starts_30_main", "starts_60_main", "starts_180_main", "starts_60_raz",
    "triaged_60", "urgent_60", "recent_wait_main", "recent_wait_raz", "dispo_60",
    "in_treatment", "boarding", "moves_240", "moves_1440", "open_lab_dept", "open_img_dept",
    "recent_tat_lab", "recent_tat_img",
    # the clock
    "hour_sin", "hour_cos", "weekday",
]  # fmt: skip
TARGETS = ["triage", "provider", "results", "decision", "bed"]
STEP = {"arrived": 0, "waiting": 1, "being_seen": 2, "boarding": 3}
WINDOW = 6 * DAY  # how far back a still-open visit can have started


def _median(values: np.ndarray) -> float:
    return float(np.median(values)) if values.size >= 3 else math.nan


def snapshots(run: Run, rng: np.random.Generator, every: float = 15.0, keep: float = 0.35,
              warmup_days: int = 3, pids: bool = False,
              at: np.ndarray | None = None) -> pd.DataFrame:  # fmt: skip
    """One row per (active patient, sampled tick) with features, labels and identifiers.

    `at` fixes the snapshot times instead of sampling them.
    """
    p = run.patients
    t_arr, t_tri, t_seen = p.t_arr.to_numpy(), p.t_tri.to_numpy(), p.t_seen.to_numpy()
    t_would, t_dec, t_dispo = p.t_would.to_numpy(), p.t_dec.to_numpy(), p.t_dispo.to_numpy()
    t_end, t_consult = p.t_end.to_numpy(), p.t_consult.to_numpy()
    ctas, age, stream = p.ctas.to_numpy(), p.age.to_numpy(), p.stream.to_numpy()
    admit = p.admit.to_numpy()
    orders = run.orders.sort_values("t_order")
    o_pid, o_type = orders.pid.to_numpy(), orders.type.to_numpy()
    o_at, o_res = orders.t_order.to_numpy(), orders.t_result.to_numpy()

    start = warmup_days * DAY + rng.uniform(0, every)
    ticks = np.arange(start, run.days * DAY, every)
    ticks = ticks + rng.uniform(-every / 3, every / 3, ticks.size)
    if at is not None:
        ticks = np.asarray(at, dtype=float)
    blocks = []
    nan = math.nan
    for t in ticks:
        lo = int(np.searchsorted(t_arr, t - WINDOW))
        hi = int(np.searchsorted(t_arr, t, side="right"))
        if hi <= lo:
            continue
        T, S, D, P, E = t_tri[lo:hi], t_seen[lo:hi], t_dec[lo:hi], t_dispo[lo:hi], t_end[lo:hi]
        C, R = ctas[lo:hi], stream[lo:hi]
        m = hi - lo
        with np.errstate(invalid="ignore"):
            active = ~(E <= t)
            triaged = T <= t
            seen = S <= t
            decided = D <= t
            disposed = P <= t
        waiting = active & triaged & ~seen
        arrived = active & ~triaged
        treating = active & seen & ~disposed
        boarding = active & decided
        if not active.any():
            continue

        # ---- department ----------------------------------------------------------
        main, raz = R == 0, R == 1
        wait_main, wait_raz = waiting & main, waiting & raz
        elapsed_waiting = t - T[waiting]

        def window(times: np.ndarray, minutes: float) -> np.ndarray:
            with np.errstate(invalid="ignore"):
                return (times > t - minutes) & (times <= t)

        started_60 = window(S, 60)
        started_180 = window(S, 180)
        triaged_60 = window(T, 60)
        moved = admit[lo:hi] & seen
        o_lo = int(np.searchsorted(o_at, t - WINDOW))
        o_hi = int(np.searchsorted(o_at, t, side="right"))
        local = o_pid[o_lo:o_hi] - lo
        in_range = local >= 0
        local = local[in_range]
        kinds = o_type[o_lo:o_hi][in_range]
        placed_at = o_at[o_lo:o_hi][in_range]
        result_at = o_res[o_lo:o_hi][in_range]
        is_open = result_at > t
        of_active = active[local]
        recent_result = (result_at > t - 180) & (result_at <= t)
        tat = result_at - placed_at
        dept = {
            "waiting_main": int(wait_main.sum()),
            "waiting_raz": int(wait_raz.sum()),
            "wait_triage": int(arrived.sum()),
            "waiting_median_elapsed": float(np.median(elapsed_waiting))
            if elapsed_waiting.size else nan,
            "starts_30_main": int((window(S, 30) & main).sum()),
            "starts_60_main": int((started_60 & main).sum()),
            "starts_180_main": int((started_180 & main).sum()),
            "starts_60_raz": int((started_60 & raz).sum()),
            "triaged_60": int(triaged_60.sum()),
            "urgent_60": int((triaged_60 & (C <= 2)).sum()),
            "recent_wait_main": _median((S - T)[started_180 & main]),
            "recent_wait_raz": _median((S - T)[started_180 & raz]),
            "dispo_60": int(window(P, 60).sum()),
            "in_treatment": int(treating.sum()),
            "boarding": int(boarding.sum()),
            "moves_240": int((moved & window(E, 240)).sum()),
            "moves_1440": int((moved & window(E, 1440)).sum()),
            "open_lab_dept": int((is_open & of_active & (kinds == 0)).sum()),
            "open_img_dept": int((is_open & of_active & (kinds > 0)).sum()),
            "recent_tat_lab": _median(tat[recent_result & (kinds == 0)]),
            "recent_tat_img": _median(tat[recent_result & (kinds > 0)]),
        }  # fmt: skip

        # ---- per patient ---------------------------------------------------------
        chosen = np.flatnonzero(active & (rng.random(m) < keep))
        if chosen.size == 0:
            continue
        f = {name: np.full(m, nan) for name in FEATURES}
        for name, value in dept.items():
            f[name][:] = value
        f["ctas"] = np.where(triaged, C, nan)
        f["age"] = age[lo:hi].astype(float)
        f["raz"] = np.where(triaged & raz, 1.0, 0.0)
        f["step"] = np.select([arrived, waiting, boarding], [0.0, 1.0, 3.0], 2.0)
        f["since_arrival"] = t - t_arr[lo:hi]
        f["since_triage"] = np.where(triaged, t - T, nan)
        f["since_provider"] = np.where(seen, t - S, nan)
        f["since_admit"] = np.where(decided, t - D, nan)
        with np.errstate(invalid="ignore"):
            f["consult"] = (t_consult[lo:hi] <= t).astype(float)

        open_local = local[is_open]
        for code, name in enumerate(["open_lab", "open_xray", "open_ct", "open_other"]):
            f[name] = np.bincount(local[is_open & (kinds == code)], minlength=m).astype(float)
        oldest = np.full(m, math.inf)
        newest = np.full(m, -math.inf)
        np.minimum.at(oldest, open_local, placed_at[is_open])
        np.maximum.at(newest, open_local, placed_at[is_open])
        last_open = np.full(m, -math.inf)
        np.maximum.at(last_open, open_local, result_at[is_open])
        f["oldest_open"] = np.where(np.isfinite(oldest), t - oldest, nan)
        f["newest_open"] = np.where(np.isfinite(newest), t - newest, nan)
        f["resulted"] = np.bincount(local[~is_open], minlength=m).astype(float)
        last_done = np.full(m, -math.inf)
        np.maximum.at(last_done, local[~is_open], result_at[~is_open])
        f["since_last_result"] = np.where(np.isfinite(last_done), t - last_done, nan)

        for mask, starts in ((wait_main, dept["starts_60_main"]), (wait_raz, dept["starts_60_raz"])):
            who = np.flatnonzero(mask)
            if who.size == 0:
                continue
            level, since = C[who], T[who]
            sicker = level[None, :] < level[:, None]
            same = level[None, :] == level[:, None]
            earlier = since[None, :] < since[:, None]
            f["ahead_urgent"][who] = sicker.sum(axis=1)
            f["ahead_same"][who] = (same & earlier).sum(axis=1)
            f["lower_waited_longer"][who] = ((level[None, :] > level[:, None]) & earlier).sum(axis=1)
            in_stream = triaged_60 & (R == R[who[0]])
            arrivals = np.array([(in_stream & (C < c)).sum() for c in range(7)])
            f["urgent_arrivals_stream_60"][who] = arrivals[level]
            if starts > 0:
                pace = starts / 60
                spare = np.maximum(pace - arrivals[level] / 60, 0.2 * pace)
                f["fluid"][who] = (f["ahead_urgent"][who] + f["ahead_same"][who] + 1) / spare
        who = np.flatnonzero(boarding)
        if who.size:
            f["boarders_ahead"][who] = (D[who][None, :] < D[who][:, None]).sum(axis=1)

        local_minute = t % DAY
        f["hour_sin"][:] = math.sin(2 * math.pi * local_minute / DAY)
        f["hour_cos"][:] = math.cos(2 * math.pi * local_minute / DAY)
        f["weekday"][:] = int(t // DAY) % 7

        # ---- labels: minutes from now to each milestone still ahead -----------------
        block = pd.DataFrame({name: f[name][chosen] for name in FEATURES})
        block["y_triage"] = np.where(arrived, T - t, nan)[chosen]
        block["y_provider"] = np.where(waiting, t_would[lo:hi] - t, nan)[chosen]
        block["y_results"] = np.where(np.isfinite(last_open), last_open - t, nan)[chosen]
        block["y_decision"] = np.where(active & triaged & ~disposed, P - t, nan)[chosen]
        block["y_bed"] = np.where(boarding, E - t, nan)[chosen]
        block["t"] = t
        if pids:
            block["pid"] = chosen + lo
        blocks.append(block)
    out = pd.concat(blocks, ignore_index=True)
    # A walkout's "would have been called" time can fall before the tick that samples them.
    out.loc[out.y_provider <= 0, "y_provider"] = nan
    return out.astype({name: np.float32 for name in FEATURES})
