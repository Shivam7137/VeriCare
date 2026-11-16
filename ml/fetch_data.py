"""Download the open datasets the estimator is trained on.

Run from the repository root:  python ml/fetch_data.py

Sources (both free, no login):
- NHAMCS emergency department public-use files, US CDC / NCHS (public domain).
- MIMIC-IV Clinical Database Demo and MIMIC-IV-ED Demo v2.2, PhysioNet
  (Open Database License). 100 de-identified patients.

Files land in ml/data/raw/, which is git-ignored. Nothing here is executed;
the files are read as data only.
"""

from __future__ import annotations

import sys
import urllib.request
from pathlib import Path

RAW = Path(__file__).resolve().parent / "data" / "raw"
CDC = "https://ftp.cdc.gov/pub/Health_Statistics/NCHS/Dataset_Documentation/NHAMCS/stata/"
PHYSIONET = "https://physionet.org/files/"

FILES: list[tuple[str, str]] = [
    ("nhamcs/ED2018-stata.zip", CDC + "ED2018-stata.zip"),
    ("nhamcs/ED2019-stata.zip", CDC + "ED2019-stata.zip"),
    ("nhamcs/ed2020-stata.zip", CDC + "ed2020-stata.zip"),
    ("nhamcs/ed2021-stata.zip", CDC + "ed2021-stata.zip"),
    ("nhamcs/ed2022-stata.zip", CDC + "ed2022-stata.zip"),
    ("mimic-demo/labevents.csv.gz", PHYSIONET + "mimic-iv-demo/2.2/hosp/labevents.csv.gz"),
    ("mimic-demo/d_labitems.csv.gz", PHYSIONET + "mimic-iv-demo/2.2/hosp/d_labitems.csv.gz"),
    ("mimic-demo/transfers.csv.gz", PHYSIONET + "mimic-iv-demo/2.2/hosp/transfers.csv.gz"),
    ("mimic-demo/edstays.csv.gz", PHYSIONET + "mimic-iv-ed-demo/2.2/ed/edstays.csv.gz"),
    ("mimic-demo/triage.csv.gz", PHYSIONET + "mimic-iv-ed-demo/2.2/ed/triage.csv.gz"),
]


def main() -> int:
    failed = 0
    for relative, url in FILES:
        target = RAW / relative
        if target.exists() and target.stat().st_size > 0:
            print(f"have   {relative} ({target.stat().st_size:,} bytes)")
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        request = urllib.request.Request(url, headers={"User-Agent": "open-data-client/1.0"})
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                data = response.read()
        except Exception as error:  # noqa: BLE001 - report and continue with the rest
            print(f"FAILED {relative}: {error}")
            failed += 1
            continue
        target.write_bytes(data)
        print(f"saved  {relative} ({len(data):,} bytes)")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
