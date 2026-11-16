"""A discrete-event emergency department that turns real patients into event logs.

Every simulated patient is a resampled real NHAMCS visit: the triage level, age,
arrival mode, orders, outcome and the minutes from first provider contact to the
end of the visit are that patient's own. The simulator supplies what no open
dataset has: a shared queue. Waits to be seen come from priority queues with
provider, treatment-space and inpatient-bed limits, so they respond to load the
way a department does. Intermediate timestamps (order placed, result back) are
placed inside each visit using the turnaround figures in `stage_fit` and
`sources`.

The output mirrors what the OPOR feed delivers: one timestamp per event kind per
visit plus an order table. Nothing here is a real Nova Scotia record.
"""

from __future__ import annotations

import heapq
import json
import math
from dataclasses import asdict, dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
PARAMS = json.loads((ROOT / "artifacts" / "stage_params.json").read_text())
HOUR_SHARE = np.array(PARAMS["arrival_hour_share"])
WEEKDAY_FACTOR = np.array(PARAMS["arrival_weekday_factor"])  # index 0 = Sunday
LAB = PARAMS["lab_turnaround"]

DAY = 1440.0
ORDER_TYPES = ("lab", "xray", "ct", "other_imaging")
# Order to result, minutes: (median, log-sd). Lab comes from MIMIC demo timestamps plus about
# ten minutes from order to collection; imaging from the anchors in sources.py.
TURNAROUND = {
    "lab": (LAB["panel"]["median"] + 8, 0.45),
    "troponin": (LAB["troponin"]["median"] + 10, 0.5),
    "xray": (35.0, 0.55),
    "ct": (115.0, 0.7),
    "us": (100.0, 0.6),
    "mri": (170.0, 0.6),
}
# When inpatient beds free up through the day: ward discharges cluster in the afternoon.
BED_RELEASE_SHARE = np.array(
    [1, 1, 1, 1, 1, 1, 1, 1, 3, 3, 3, 7, 7, 7, 10, 10, 10, 10, 5, 5, 5, 2.4, 2.3, 2.3]
)
BED_RELEASE_SHARE = BED_RELEASE_SHARE / BED_RELEASE_SHARE.sum()
# How much longer than a CTAS 4 patient each level is prepared to wait before walking out.
PATIENCE_RATIO = {1: math.inf, 2: 2.0, 3: 1.2, 4: 1.0, 5: 0.9}
# Queue rank in minutes of waiting: a CTAS 4 patient outranks a newly triaged CTAS 3 once
# they have waited about 100 minutes longer (scaled by Site.aging). Sicker first, not only.
LEVEL_HANDICAP = {2: 0.0, 3: 250.0, 4: 350.0, 5: 400.0}


@dataclass
class Site:
    """One department's shape. Training randomises every field."""

    name: str = "reference"
    volume: float = 200.0  # visits per day
    ctas_mix: tuple = (0.015, 0.19, 0.46, 0.27, 0.065)
    raz_share: float = 0.25  # of all visits, while the zone is open
    raz_open: tuple = (8, 22)
    staffing_util: float = 0.9  # how tightly rostered providers match expected demand
    service_min: float = 30.0  # provider minutes one main-stream patient consumes
    raz_service_min: float = 18.0
    bed_factor: float = 1.3  # treatment spaces relative to expected occupancy
    aging: float = 1.0  # how fast a long wait outranks a higher triage level
    patience_min: float = 550.0  # median minutes a CTAS 4 patient waits before leaving
    tell_staff: float = 0.3  # share of walkouts the department learns of at once
    pre_order: float = 1.0  # how often bloodwork and X-rays start in the waiting room
    lab_speed: float = 1.0
    imaging_speed: float = 1.0
    load_kappa: float = 0.2  # how much open orders slow turnaround
    stretch: float = 0.0  # extra seen-to-decision time when the department is slow
    bed_ratio: float = 1.0  # inpatient beds freed per ED admission, long run
    bed_noise: float = 0.12
    bed_bank: int = 2
    triage_util: float = 0.85
    surge_per_day: float = 0.15
    seed: int = 0


@dataclass
class Run:
    site: Site
    days: int
    patients: pd.DataFrame
    orders: pd.DataFrame
    stats: dict = field(default_factory=dict)


class _Pool:
    """Real visits grouped by triage level for weighted resampling."""

    def __init__(self) -> None:
        frame = pd.read_parquet(ROOT / "data" / "patient_pool.parquet")
        self.frame = frame
        self.columns = {name: frame[name].to_numpy() for name in frame.columns}
        self.by_level = {}
        for level in range(1, 6):
            index = np.flatnonzero(frame.esi.to_numpy() == level)
            weights = frame.weight.to_numpy()[index]
            self.by_level[level] = (index, np.cumsum(weights) / weights.sum())

    def draw(self, level: int, u: float) -> int:
        index, cumulative = self.by_level[level]
        return int(index[min(np.searchsorted(cumulative, u), len(index) - 1)])


_POOL: _Pool | None = None


def pool() -> _Pool:
    global _POOL
    if _POOL is None:
        _POOL = _Pool()
    return _POOL


def _staff(demand_per_hour: np.ndarray, service_min: float, util: float) -> np.ndarray:
    """Providers on duty each hour: smoothed expected workload over a target utilisation."""
    smooth = (np.roll(demand_per_hour, 1) + demand_per_hour + np.roll(demand_per_hour, -1)) / 3
    return np.maximum(1, np.round(smooth * service_min / 60 / util)).astype(int)


# Event kinds.
ARRIVE, TRIAGED, PREORDER, FREE_MAIN, FREE_RAZ, LEAVE_ED, DECIDE, BED, MOVED, HOUR, RESULT = range(
    11
)


def simulate(site: Site, days: int, drain_days: int = 6) -> Run:
    rng = np.random.default_rng(site.seed)
    real = pool()
    col = real.columns
    mix = np.array(site.ctas_mix) / sum(site.ctas_mix)

    # ---- arrivals -------------------------------------------------------------------
    times: list[float] = []
    surge_flags: list[bool] = []
    for day in range(days):
        day_level = site.volume * WEEKDAY_FACTOR[day % 7] * rng.lognormal(0, 0.08)
        counts = rng.poisson(day_level * HOUR_SHARE)
        for hour, count in enumerate(counts):
            for minute in rng.uniform(0, 60, count):
                times.append(day * DAY + hour * 60 + minute)
                surge_flags.append(False)
        if rng.random() < site.surge_per_day:
            start = day * DAY + rng.uniform(8 * 60, 23 * 60)
            for minute in rng.uniform(0, 30, rng.integers(4, 11)):
                times.append(start + minute)
                surge_flags.append(True)
    order_index = np.argsort(times)
    t_arr = np.array(times)[order_index]
    surge = np.array(surge_flags)[order_index]
    n = len(t_arr)
    ctas = rng.choice(5, size=n, p=mix) + 1
    ctas[surge] = rng.choice([2, 3], size=int(surge.sum()), p=[0.6, 0.4])
    source = np.array([real.draw(int(level), u) for level, u in zip(ctas, rng.random(n))])
    age = col["age"][source]
    ems = col["ems"][source].copy()
    ems[surge] = 1
    admit = col["admit"][source].astype(bool)
    post = col["post"][source].astype(float)

    # ---- capacity -------------------------------------------------------------------
    hourly = site.volume * HOUR_SHARE
    raz_hours = np.array([site.raz_open[0] <= h < site.raz_open[1] for h in range(24)])
    eligible_share = float(mix[2:].sum()) * 0.83  # CTAS 3-5 who walked in
    raz_p = min(1.0, site.raz_share / max(eligible_share * float(HOUR_SHARE[raz_hours].sum()), 1e-6))
    raz_demand = hourly * raz_hours * eligible_share * raz_p
    # The roster is sized for 85% utilisation; `staffing_util` then sets how busy the
    # providers really are by scaling the time each patient takes.
    main_staff = _staff(hourly - raz_demand, site.service_min, 0.85)
    raz_staff = np.where(raz_hours, _staff(raz_demand, site.raz_service_min, 0.85), 0)
    pace = site.staffing_util / 0.85
    main_service = site.service_min * pace
    raz_service = site.raz_service_min * pace
    triage_staff = np.maximum(1, np.ceil(hourly * 7.6 / 60 / site.triage_util)).astype(int)
    admits_per_day = site.volume * float(np.average(col["admit"], weights=col["weight"]))
    main_per_hour = (site.volume * (1 - site.raz_share * 0.6)) / 24
    expected_occupancy = main_per_hour * 3.6 + admits_per_day * 13 / 24
    beds = max(6, int(round(site.bed_factor * expected_occupancy)))
    typical_open = {
        "lab": site.volume / DAY * 0.6 * 80,
        "img": site.volume / DAY * 0.5 * 75,
    }

    # ---- inpatient bed releases -----------------------------------------------------
    bed_times: list[float] = []
    level = 0.0
    for day in range(days + drain_days):
        level = 0.7 * level + rng.normal(0, site.bed_noise)
        count = rng.poisson(admits_per_day * site.bed_ratio * math.exp(level))
        for hour in rng.choice(24, size=count, p=BED_RELEASE_SHARE):
            bed_times.append(day * DAY + hour * 60 + rng.uniform(0, 60))

    # ---- state ----------------------------------------------------------------------
    nan = math.nan
    t_tri = np.full(n, nan)
    t_seen = np.full(n, nan)
    t_would = np.full(n, nan)  # when the patient was, or would have been, called
    t_left = np.full(n, nan)  # walkout as the feed reports it
    t_dec = np.full(n, nan)  # admit decision
    t_dispo = np.full(n, nan)  # first of discharge or admit decision
    t_end = np.full(n, nan)  # left the department
    t_consult = np.full(n, nan)
    stream = np.zeros(n, dtype=np.int8)  # 1 = rapid assessment
    gone_at = np.full(n, math.inf)  # when the patient gives up, known only to the simulator
    told = np.zeros(n, dtype=bool)
    o_pid: list[int] = []
    o_type: list[int] = []
    o_at: list[float] = []
    o_res: list[float] = []
    placed = [set() for _ in range(n)]
    last_result = np.zeros(n)

    events: list[tuple] = []
    seq = 0

    def push(at: float, kind: int, who: int = -1, extra: int = 0) -> None:
        nonlocal seq
        seq += 1
        heapq.heappush(events, (at, seq, kind, who, extra))

    for i in range(n):
        push(float(t_arr[i]), ARRIVE, i)
    for at in bed_times:
        push(at, BED)
    for hour in range((days + drain_days) * 24):
        push(hour * 60.0, HOUR)

    triage_queue: list[tuple] = []
    triage_busy = 0
    main_queue: list[tuple] = []
    raz_queue: list[tuple] = []
    main_busy = raz_busy = beds_used = 0
    boarders: list[int] = []
    bank = 0
    open_orders = {"lab": 0, "img": 0}
    recent_waits: list[tuple] = []

    def lognormal(median: float, sigma: float) -> float:
        return median * math.exp(sigma * rng.standard_normal())

    def turnaround(kind: str) -> float:
        median, sigma = TURNAROUND[kind]
        group = "lab" if kind in ("lab", "troponin") else "img"
        speed = site.lab_speed if group == "lab" else site.imaging_speed
        typical = max(typical_open[group], 1.0)
        load = min(3.0, max(-1.0, (open_orders[group] - typical) / typical))
        return lognormal(median, sigma) * speed * math.exp(site.load_kappa * load)

    def place(i: int, kind: str, at: float, minutes: float) -> float:
        code = {"lab": 0, "troponin": 0, "xray": 1, "ct": 2, "us": 3, "mri": 3}[kind]
        group = "lab" if code == 0 else "img"
        o_pid.append(i)
        o_type.append(code)
        o_at.append(at)
        o_res.append(at + minutes)
        last_result[i] = max(last_result[i], at + minutes)
        open_orders[group] += 1
        push(at + minutes, RESULT, -1, 0 if group == "lab" else 1)
        return at + minutes

    def wanted(i: int) -> list[str]:
        s = source[i]
        out = []
        if col["lab"][s]:
            out.append("troponin" if col["troponin"][s] else "lab")
        for name in ("xray", "ct", "us", "mri"):
            if col[name][s]:
                out.append(name)
        return out

    def start_care(i: int, now: float) -> None:
        """The provider picks the patient up: lay out the rest of the visit."""
        t_seen[i] = t_would[i] = now
        recent_waits.append((now, now - t_tri[i]))
        assess = min(lognormal(12, 0.5), 0.5 * post[i])
        # Baseline: every order placed after the provider, as in the source records.
        baseline_latest = 0.0
        latest = now
        drawn = []
        for kind in wanted(i):
            delay = lognormal(10, 0.6) + (lognormal(8, 0.5) if kind in ("ct", "us", "mri") else 0)
            drawn.append((kind, delay, turnaround(kind)))
            baseline_latest = max(baseline_latest, delay + drawn[-1][2])
        # A real visit that ended sooner than the drawn turnarounds had faster tests.
        room = 0.9 * post[i]
        squeeze = min(1.0, room / baseline_latest) if baseline_latest > 0 else 1.0
        for kind, delay, minutes in drawn:
            group = "lab" if kind in ("lab", "troponin") else kind
            if group in placed[i]:
                continue
            latest = max(latest, place(i, kind, now + delay * squeeze, minutes * squeeze))
        # Tests started in the waiting room may already be back, or still be running.
        latest = max(latest, float(last_result[i]))
        baseline_ready = max(assess, baseline_latest * squeeze)
        rest = max(5.0, 0.1 * post[i], post[i] - baseline_ready)
        # Serial troponin: a second draw two to three hours after the first, when it fits.
        if col["troponin"][source[i]] and rng.random() < 0.4:
            again = now + rng.uniform(120, 180)
            minutes = turnaround("troponin")
            if again + minutes - now <= room:
                latest = max(latest, place(i, "troponin", again, minutes))
                rest = max(5.0, post[i] - (again + minutes - now))
        slow = 1.0
        if site.stretch > 0 and recent_waits:
            window = [w for at, w in recent_waits[-40:] if at >= now - 240]
            if window:
                slow = ((1 + float(np.mean(window))) / 36.0) ** site.stretch
        ready = max(now + assess, latest)
        decided = ready + rest * max(1.0, slow)
        if col["consult"][source[i]]:
            t_consult[i] = ready + rng.uniform(0, 0.25) * rest
        t_dispo[i] = decided
        push(decided, DECIDE if admit[i] else LEAVE_ED, i)

    def call_next(now: float) -> None:
        nonlocal main_busy, raz_busy, beds_used
        hour = int(now // 60) % 24
        while raz_queue and raz_busy < max(raz_staff[hour], 1 if raz_queue else 0):
            _, i = heapq.heappop(raz_queue)
            if gone_at[i] <= now:
                t_would[i] = now
                if not told[i]:
                    t_left[i] = t_end[i] = now
                continue
            raz_busy += 1
            push(now + lognormal(raz_service, 0.4), FREE_RAZ)
            start_care(i, now)
        while main_queue and main_busy < main_staff[hour]:
            _, i = main_queue[0]
            # Past the last treatment space, care moves to hallways and chairs: slower, and
            # beyond a hard ceiling only the sickest are brought in.
            if gone_at[i] > now and ctas[i] >= 3 and beds_used >= beds * 1.35:
                break
            heapq.heappop(main_queue)
            if gone_at[i] <= now:
                t_would[i] = now
                if not told[i]:
                    t_left[i] = t_end[i] = now
                continue
            crowded = 1.0 + 0.6 * min(1.0, max(0.0, (beds_used - beds) / (0.35 * beds) + 0.3))                 if beds_used >= beds else 1.0
            main_busy += 1
            beds_used += 1
            push(now + lognormal(main_service * crowded, 0.4), FREE_MAIN)
            start_care(i, now)

    def triage_next(now: float) -> None:
        nonlocal triage_busy
        hour = int(now // 60) % 24
        while triage_queue and triage_busy < triage_staff[hour]:
            _, i = heapq.heappop(triage_queue)
            triage_busy += 1
            push(now + rng.uniform(0, 2) + lognormal(4.5, 0.8), TRIAGED, i)

    horizon = (days + drain_days) * DAY
    while events:
        now, _, kind, i, extra = heapq.heappop(events)
        if now > horizon:
            break
        if kind == ARRIVE:
            if ctas[i] == 1:
                push(now + rng.uniform(1, 4), TRIAGED, i, 1)
            else:
                heapq.heappush(triage_queue, (now - (30 if ems[i] else 0), i))
                triage_next(now)
        elif kind == TRIAGED:
            if not extra:
                triage_busy -= 1
            t_tri[i] = now
            level = int(ctas[i])
            if level == 1:
                # Resuscitation is immediate and takes a space whether or not one is free.
                main_busy += 1
                beds_used += 1
                push(now + lognormal(main_service, 0.4), FREE_MAIN)
                start_care(i, now + rng.uniform(0, 3))
            else:
                walk_in = level >= 3 and not ems[i] and age[i] >= 2
                hour = int(now // 60) % 24
                if walk_in and raz_hours[hour] and rng.random() < raz_p:
                    stream[i] = 1
                patience = lognormal(site.patience_min * PATIENCE_RATIO[level], 0.9)
                gone_at[i] = now + patience
                told[i] = rng.random() < site.tell_staff
                key = LEVEL_HANDICAP[level] + now * site.aging
                heapq.heappush(raz_queue if stream[i] else main_queue, (key, i))
                # Waiting Room Care Providers start bloodwork and X-rays under directives.
                chance = (0.6 if level <= 3 else 0.25) * site.pre_order
                for kind_name in wanted(i):
                    group = "lab" if kind_name in ("lab", "troponin") else kind_name
                    limit = chance if group == "lab" else 0.5 * chance if group == "xray" else 0
                    if rng.random() < limit:
                        code = ("lab", "troponin", "xray").index(kind_name)
                        push(now + rng.uniform(5, 45), PREORDER, i, code)
            triage_next(now)
            call_next(now)
        elif kind == PREORDER:
            if math.isnan(t_seen[i]) and gone_at[i] > now:
                name = ("lab", "troponin", "xray")[extra]
                placed[i].add("lab" if extra < 2 else "xray")
                place(i, name, now, turnaround(name))
        elif kind == RESULT:
            open_orders["lab" if extra == 0 else "img"] -= 1
        elif kind == FREE_MAIN:
            main_busy -= 1
            call_next(now)
        elif kind == FREE_RAZ:
            raz_busy -= 1
            call_next(now)
        elif kind == LEAVE_ED:
            t_end[i] = now
            if not stream[i]:
                beds_used -= 1
                call_next(now)
        elif kind == DECIDE:
            t_dec[i] = now
            if bank > 0:
                bank -= 1
                push(now + lognormal(40, 0.5) + lognormal(25, 0.4), MOVED, i)
            else:
                boarders.append(i)
        elif kind == BED:
            if boarders:
                pick = 0 if rng.random() < 0.65 else int(rng.integers(len(boarders)))
                push(now + lognormal(25, 0.4), MOVED, boarders.pop(pick))
            else:
                bank = min(site.bed_bank, bank + 1)
        elif kind == MOVED:
            t_end[i] = now
            if not stream[i]:
                beds_used -= 1
            call_next(now)
        elif kind == HOUR:
            # Walkouts who told a nurse leave the board at once.
            call_next(now)
            triage_next(now)
            if len(recent_waits) > 400:
                del recent_waits[:200]

    # Walkouts who told staff are reported when they leave, not when they are called.
    leavers = told & np.isnan(t_seen) & np.isfinite(gone_at)
    t_left[leavers] = t_end[leavers] = gone_at[leavers]
    # A walkout nobody noticed is only found when the name is called.
    patients = pd.DataFrame(
        {
            "t_arr": t_arr, "t_tri": t_tri, "t_seen": t_seen, "t_would": t_would,
            "t_left": t_left, "t_dec": t_dec, "t_dispo": t_dispo, "t_end": t_end,
            "t_consult": t_consult, "ctas": ctas, "age": age, "ems": ems, "stream": stream,
            "admit": admit, "gone_at": gone_at, "post": post,
        }
    )  # fmt: skip
    orders = pd.DataFrame(
        {"pid": o_pid, "type": o_type, "t_order": o_at, "t_result": o_res}
    ).astype({"pid": np.int64, "type": np.int8})
    run = Run(site=site, days=days, patients=patients, orders=orders)
    run.stats = summarise(run)
    return run


def summarise(run: Run, warmup_days: int = 3) -> dict:
    p = run.patients
    p = p[(p.t_arr >= warmup_days * DAY) & (p.t_arr < run.days * DAY)]
    triaged = p[p.t_tri.notna()]
    seen = p[p.t_seen.notna()]
    wait = seen.t_seen - seen.t_tri
    left = triaged[triaged.t_seen.isna()]
    boarded = seen[seen.admit & seen.t_end.notna()]
    bed_wait = boarded.t_end - boarded.t_dec
    home = seen[~seen.admit & seen.t_end.notna()]
    stay = home.t_end - home.t_arr
    after = home.t_end - home.t_seen
    low = seen[seen.ctas >= 3]
    low_wait = low.t_seen - low.t_tri

    def q(series: pd.Series, level: float) -> float:
        return round(float(series.quantile(level)), 1) if len(series) else math.nan

    return {
        "visits_per_day": round(len(p) / max(run.days - warmup_days, 1), 1),
        "wait_mean": round(float(wait.mean()), 1),
        "wait_median": q(wait, 0.5),
        "wait_p90": q(wait, 0.9),
        "wait_mean_ctas345": round(float(low_wait.mean()), 1),
        "wait_median_by_ctas": {
            int(level): q(group.t_seen - group.t_tri, 0.5) for level, group in seen.groupby("ctas")
        },
        "lwbs_share": round(len(left) / max(len(triaged), 1), 4),
        "lwbs_by_ctas": {
            int(level): round(len(group) / max(len(left), 1), 3)
            for level, group in left.groupby("ctas")
        },
        "door_to_triage_median": q(triaged.t_tri - triaged.t_arr, 0.5),
        "door_to_triage_q1_q3": [q(triaged.t_tri - triaged.t_arr, 0.25),
                                 q(triaged.t_tri - triaged.t_arr, 0.75)],  # fmt: skip
        "admit_share_of_seen": round(float(seen.admit.mean()), 4),
        "bed_wait_mean": round(float(bed_wait.mean()), 1) if len(bed_wait) else math.nan,
        "bed_wait_median": q(bed_wait, 0.5),
        "bed_wait_p90": q(bed_wait, 0.9),
        "seen_to_home_median": q(after, 0.5),
        "seen_to_home_p90": q(after, 0.9),
        "home_stay_median": q(stay, 0.5),
        "home_stay_p90": q(stay, 0.9),
        "raz_share": round(float(triaged.stream.mean()), 3),
        "unfinished": int(p.t_end.isna().sum()),
    }


def site_dict(site: Site) -> dict:
    return asdict(site)


if __name__ == "__main__":
    import time

    started = time.time()
    result = simulate(Site(seed=1), days=30)
    print(json.dumps(result.stats, indent=2))
    print(f"{len(result.patients)} patients, {len(result.orders)} orders, "
          f"{time.time() - started:.1f}s")  # fmt: skip
