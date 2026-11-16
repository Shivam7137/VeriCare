"""Write the fixture that holds the Python and TypeScript feature code together.

A small simulated department is exported as feed events, with the features and
calibrated estimates the Python side computes at a few moments. The API test
(apps/api/test/stage-model.test.ts) rebuilds both from the events and must match.

Run from ml/ after training:  python -m vericare_ml.export_fixture
"""

from __future__ import annotations

import gzip
import json
import math
import pickle
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

from . import calibrate
from .features import FEATURES, snapshots
from .sim import DAY, simulate
from .train import predict
from dataclasses import replace

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT.parent / "apps" / "api" / "test" / "fixtures" / "stage-fixture.json.gz"
# Minute 0 of the simulation is a Sunday midnight in Halifax (AST, UTC-4).
BASE = datetime(2026, 11, 8, 4, 0, 0, tzinfo=timezone.utc)
MODALITY = {1: "xray", 2: "ct", 3: "ultrasound"}


def iso(minutes: float) -> str:
    stamp = BASE + timedelta(seconds=round(minutes * 60))
    return stamp.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def stages_for(row) -> list[str]:
    has_open = row.open_lab + row.open_xray + row.open_ct + row.open_other > 0
    if row.step == 0:
        return ["triage"]
    if row.step == 1:
        return ["provider", "results", "decision"] if has_open else ["provider", "decision"]
    if row.step == 2:
        return ["results", "decision"] if has_open else ["decision"]
    return ["bed"]


def main() -> None:
    with open(ROOT / "data" / "fitted.pkl", "rb") as handle:
        fitted = pickle.load(handle)
    site = replace(calibrate.load(), name="fixture", volume=75.0, seed=4242)
    run = simulate(site, days=7)
    # Whole seconds, so both languages see exactly the same instants.
    for column in ["t_arr", "t_tri", "t_seen", "t_would", "t_left", "t_dec", "t_dispo",
                   "t_end", "t_consult"]:  # fmt: skip
        run.patients[column] = np.round(run.patients[column] * 60) / 60
    for column in ["t_order", "t_result"]:
        run.orders[column] = np.round(run.orders[column] * 60) / 60
    order = np.argsort(run.patients.t_arr.to_numpy(), kind="stable")
    assert (order == np.arange(len(order))).all()

    # Half a second off the grid: no event can tie with a snapshot.
    ticks = np.array([4 * DAY + 3 * 60, 4 * DAY + 11.5 * 60, 4 * DAY + 16 * 60,
                      4 * DAY + 21 * 60, 5 * DAY + 14 * 60]) + 0.5 / 60  # fmt: skip
    rows = snapshots(run, np.random.default_rng(0), keep=1.1, pids=True, at=ticks)

    visits = []
    p = run.patients
    horizon = float(ticks.max())
    orders_by = run.orders.groupby("pid")
    for pid in range(len(p)):
        r = p.iloc[pid]
        if r.t_arr > horizon or (not math.isnan(r.t_end) and r.t_end < ticks.min() - 2 * DAY):
            continue
        events = []

        def add(kind: str, at: float, **detail) -> None:
            if not math.isnan(at):
                events.append({"kind": kind, "occurredAt": iso(at), "source": "hl7v2",
                               "sourceEventId": f"v{pid}-{len(events):02d}", "detail": detail})  # fmt: skip

        add("arrived", r.t_arr, area="WAITROOM")
        if r.stream == 1:
            add("triaged", r.t_tri, ctas=int(r.ctas), stream="rapid_assessment")
        else:
            add("triaged", r.t_tri, ctas=int(r.ctas))
        add("provider_assigned", r.t_seen)
        if pid in orders_by.groups:
            for n, o in enumerate(orders_by.get_group(pid).itertuples()):
                detail = {"orderId": f"o{pid}-{n}",
                          "orderType": "lab" if o.type == 0 else "imaging"}  # fmt: skip
                if o.type > 0:
                    detail["modality"] = MODALITY[int(o.type)]
                add("order_placed", o.t_order, **detail)
                add("result_available", o.t_result, orderId=detail["orderId"])
        add("consult_requested", r.t_consult)
        if r.admit and not math.isnan(r.t_seen):
            add("admit_decision", r.t_dec)
            add("moved_to_unit", r.t_end, area="4A")
        elif not math.isnan(r.t_seen):
            add("discharged", r.t_end)
        else:
            add("left_without_being_seen", r.t_left)
        visits.append({"id": f"v{pid}", "age": float(r.age), "events": events})

    out_ticks = []
    for t, block in rows.groupby("t"):
        entries = []
        for row in block.itertuples():
            estimates = {}
            for stage in stages_for(row):
                one = block.loc[[row.Index]]
                ranges = predict(fitted[stage], one, stage).iloc[0]
                estimates[stage] = [float(ranges.low), float(ranges.mid), float(ranges.high)]
            entries.append({
                "id": f"v{int(row.pid)}",
                "features": {name: None if math.isnan(getattr(row, name))
                             else float(getattr(row, name)) for name in FEATURES},
                "estimates": estimates,
            })  # fmt: skip
        stamp = BASE + timedelta(milliseconds=round(float(t) * 60_000))
        out_ticks.append({"now": stamp.strftime("%Y-%m-%dT%H:%M:%S.") + f"{stamp.microsecond // 1000:03d}Z",
                          "rows": entries})  # fmt: skip
    document = {"timeZone": "America/Halifax", "visits": visits, "ticks": out_ticks}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with gzip.GzipFile(OUT, "wb", mtime=0) as handle:
        handle.write(json.dumps(document, separators=(",", ":")).encode())
    print(f"{len(visits)} visits, {sum(len(t['rows']) for t in out_ticks)} rows, "
          f"{OUT.stat().st_size:,} bytes -> {OUT}")  # fmt: skip


if __name__ == "__main__":
    main()
