"""NHAMCS emergency department public-use files (US CDC / NCHS), 2018-2022.

One row per sampled real ED visit. The file records how long the patient waited
for a provider, how long the whole visit lasted, what was ordered and how the
visit ended, but not when each test was ordered or resulted. Those intermediate
times are inferred in `stage_fit.py`.
"""

from __future__ import annotations

import io
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd

RAW = Path(__file__).resolve().parents[1] / "data" / "raw" / "nhamcs"
CACHE = Path(__file__).resolve().parents[1] / "data" / "nhamcs_visits.parquet"

YEARS = {
    2018: "ED2018-stata.zip",
    2019: "ED2019-stata.zip",
    2020: "ed2020-stata.zip",
    2021: "ed2021-stata.zip",
    2022: "ed2022-stata.zip",
}

LAB_FLAGS = [
    "ABG", "BAC", "BMP", "BNP", "BUNCREAT", "CARDENZ", "CBC", "CMP", "BLOODCX", "DDIMER",
    "ELECTROL", "GLUCOSE", "LACTATE", "LFT", "PTTINR", "OTHERBLD", "TOXSCREN", "URINE",
    "URINECX", "PREGTEST", "FLUTEST",
]  # fmt: skip
DISPOSITION_FLAGS = [
    "LWBS", "LBTC", "LEFTAMA", "DOA", "DIEDED", "TRANNH", "TRANPSYC", "TRANOTH",
    "ADMITHOS", "OBSHOS", "OBSDIS",
]  # fmt: skip
OTHER_FLAGS = ["EKG", "XRAY", "CATSCAN", "MRI", "ULTRASND", "CONSULT", "IVFLUIDS", "PROC"]
NUMERIC = ["WAITTIME", "LOV", "BOARDED", "AGE", "IMMEDR", "ARREMS", "VDAYR", "VMONTH",
           "HOSPCODE", "PATWT", "NUMMED", "TOTPROC"]  # fmt: skip


def _read_year(year: int) -> pd.DataFrame:
    archive = zipfile.ZipFile(RAW / YEARS[year])
    inner = next(i for i in archive.infolist() if i.filename.lower().endswith(".dta"))
    frame = pd.read_stata(io.BytesIO(archive.read(inner)), convert_categoricals=False)
    frame.columns = [c.upper() for c in frame.columns]
    keep = [c for c in NUMERIC + LAB_FLAGS + DISPOSITION_FLAGS + OTHER_FLAGS + ["ARRTIME"]
            if c in frame.columns]  # fmt: skip
    out = frame[keep].copy()
    for column in NUMERIC + LAB_FLAGS + DISPOSITION_FLAGS + OTHER_FLAGS:
        if column not in out.columns:
            out[column] = 0
    out["YEAR"] = year
    return out


def load(refresh: bool = False) -> pd.DataFrame:
    """Cleaned visits with derived fields. Negative codes (blank, unknown, n/a) become NaN."""
    if CACHE.exists() and not refresh:
        return pd.read_parquet(CACHE)
    raw = pd.concat([_read_year(year) for year in YEARS], ignore_index=True)
    v = pd.DataFrame(index=raw.index)
    v["year"] = raw["YEAR"]
    v["hospital"] = raw["YEAR"] * 1000 + raw["HOSPCODE"]
    v["weight"] = raw["PATWT"].astype(float)
    v["age"] = raw["AGE"].astype(float)
    v["ems"] = (raw["ARREMS"] == 1).astype(int)
    v["weekday"] = raw["VDAYR"].astype(int) - 1  # 0 = Sunday
    v["month"] = raw["VMONTH"].astype(int)
    arr = pd.to_numeric(raw["ARRTIME"], errors="coerce")
    arr = arr.where((arr >= 0) & (arr <= 2359))
    v["hour"] = (arr // 100).where(arr.notna())
    v["minute_of_day"] = ((arr // 100) * 60 + arr % 100).where(arr.notna())
    # ESI triage level 1-5. 0 = no triage, 7 = department does not triage, negatives unknown.
    v["esi"] = raw["IMMEDR"].where(raw["IMMEDR"].between(1, 5)).astype(float)
    v["wait"] = raw["WAITTIME"].where(raw["WAITTIME"] >= 0).astype(float)
    v["lov"] = raw["LOV"].where(raw["LOV"] > 0).astype(float)
    v["boarded"] = raw["BOARDED"].where(raw["BOARDED"] >= 0).astype(float)

    v["lab"] = (raw[LAB_FLAGS].eq(1).sum(axis=1) > 0).astype(int)
    v["n_lab"] = raw[LAB_FLAGS].eq(1).sum(axis=1)
    v["troponin"] = raw["CARDENZ"].eq(1).astype(int)
    v["culture"] = (raw["BLOODCX"].eq(1) | raw["URINECX"].eq(1)).astype(int)
    v["ekg"] = raw["EKG"].eq(1).astype(int)
    v["xray"] = raw["XRAY"].eq(1).astype(int)
    v["ct"] = raw["CATSCAN"].eq(1).astype(int)
    v["mri"] = raw["MRI"].eq(1).astype(int)
    v["us"] = raw["ULTRASND"].eq(1).astype(int)
    v["imaging"] = (v[["xray", "ct", "mri", "us"]].sum(axis=1) > 0).astype(int)
    v["consult"] = raw["CONSULT"].eq(1).astype(int)
    v["iv"] = raw["IVFLUIDS"].eq(1).astype(int)
    v["n_med"] = raw["NUMMED"].clip(lower=0).astype(float)

    left = raw[["LWBS", "LBTC"]].eq(1).any(axis=1)
    admit = raw[["ADMITHOS", "OBSHOS"]].eq(1).any(axis=1)
    transfer = raw[["TRANNH", "TRANPSYC", "TRANOTH"]].eq(1).any(axis=1)
    died = raw[["DOA", "DIEDED"]].eq(1).any(axis=1)
    v["outcome"] = np.select(
        [left, died, admit, transfer, raw["LEFTAMA"].eq(1)],
        ["lwbs", "died", "admit", "transfer", "ama"],
        default="home",
    )
    # Time after the provider first saw the patient. Admitted patients' boarding time is
    # part of LOV, so it is removed to leave "seen to decision".
    post = v["lov"] - v["wait"]
    post = post.where(v["outcome"] != "admit", post - v["boarded"].fillna(0))
    v["post"] = post.where(post > 0)
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    v.to_parquet(CACHE)
    return v


if __name__ == "__main__":
    visits = load(refresh=True)
    print(visits.shape)
    print(visits.describe().T.round(2).to_string())
    print(visits["outcome"].value_counts(normalize=True).round(4))
