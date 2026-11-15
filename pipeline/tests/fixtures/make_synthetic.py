"""Synthetic FIRMS-format files for tests (NOT real data).

Fires are simulated once; each sensor then 'observes' them, so MODIS and VIIRS detections of the same
fire are close in space and time, the way real coincident detections are. Also adds a gas flare
(type 2), a static site with no type, and a few invalid rows to exercise quarantine.

Layout written: <out>/data/country/<dir>/<year>/<dir>_<year>_<Country>.csv  (same as the FIRMS server)
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

MODIS_COLS = ["latitude", "longitude", "brightness", "scan", "track", "acq_date", "acq_time", "satellite",
              "instrument", "confidence", "version", "bright_t31", "frp", "daynight", "type"]
VIIRS_COLS = ["latitude", "longitude", "bright_ti4", "scan", "track", "acq_date", "acq_time", "satellite",
              "instrument", "confidence", "version", "bright_ti5", "frp", "daynight", "type"]
REGIONS = {"Turkey": (36.5, 41.0, 27.0, 44.0, 6.0, 8), "Egypt": (25.0, 31.0, 25.5, 34.0, 2.0, 10)}
VIIRS_START = pd.Timestamp("2012-01-20")


def simulate(years: range, seed: int = 7) -> dict[tuple[str, str, int], pd.DataFrame]:
    rng = np.random.default_rng(seed)
    out = {}
    for region, (la0, la1, lo0, lo1, base, peak) in REGIONS.items():
        rows_m, rows_v = [], []
        for day in pd.date_range(f"{years.start}-01-01", f"{years.stop - 1}-12-31"):
            lam = base * np.exp(-((day.month - peak) ** 2) / 4.0)
            for _ in range(rng.poisson(lam)):
                lat, lon = rng.uniform(la0, la1), rng.uniform(lo0, lo1)
                aqua_utc = 13.5 - lon / 15 + rng.normal(0, 0.15)            # ~13:30 local solar
                terra_utc = 10.5 - lon / 15 + rng.normal(0, 0.15)           # ~10:30 local solar
                for sat, hour, p in (("Aqua", aqua_utc, 0.55), ("Terra", terra_utc, 0.5)):
                    if rng.random() < p:
                        rows_m.append(_modis_row(rng, lat, lon, day, hour, sat))
                if day >= VIIRS_START and rng.random() < 0.85:
                    snpp = aqua_utc + rng.uniform(-0.25, 0.25)              # within +/- 15 min of Aqua
                    for _ in range(rng.integers(1, 4)):
                        rows_v.append(_viirs_row(rng, lat, lon, day, snpp))
            if region == "Egypt":                                           # gas flare: every day, type 2
                rows_m.append(_modis_row(rng, 29.5012, 32.5503, day, 11.2, "Aqua", ftype=2))
                if day >= VIIRS_START:
                    rows_v.append(_viirs_row(rng, 29.5012, 32.5503, day, 11.2, ftype=2))
                if rng.random() < 0.6:                                      # static site with type 0 (flag must catch it)
                    rows_m.append(_modis_row(rng, 30.1005, 31.6004, day, 11.2, "Aqua", jitter=0.0005))
        m = pd.DataFrame(rows_m, columns=MODIS_COLS)
        v = pd.DataFrame(rows_v, columns=VIIRS_COLS)
        for y in years:
            out[("modis", region, y)] = m[m.acq_date.str.startswith(str(y))]
            if y >= VIIRS_START.year:
                out[("viirs-snpp", region, y)] = v[v.acq_date.str.startswith(str(y))]
    return out


def _hhmm(hour: float) -> str:
    h = int(hour) % 24
    return f"{h:02d}{int((hour - int(hour)) * 60):02d}"


def _modis_row(rng, lat, lon, day, hour, sat, ftype=0, jitter=0.004):
    scan = round(float(rng.uniform(1.0, 2.5)), 1)
    return [round(lat + rng.normal(0, jitter), 4), round(lon + rng.normal(0, jitter), 4),
            round(float(rng.uniform(305, 360)), 1), scan, round(min(scan, float(rng.uniform(1.0, 1.6))), 1),
            day.strftime("%Y-%m-%d"), _hhmm(hour), sat, "MODIS", int(rng.integers(20, 101)), "6.03",
            round(float(rng.uniform(285, 305)), 1), round(float(rng.gamma(2, 15)), 1),
            "D", ftype]


def _viirs_row(rng, lat, lon, day, hour, ftype=0):
    return [round(lat + rng.normal(0, 0.002), 5), round(lon + rng.normal(0, 0.002), 5),
            round(float(rng.uniform(300, 367)), 2), round(float(rng.uniform(0.37, 0.6)), 2),
            round(float(rng.uniform(0.37, 0.55)), 2), day.strftime("%Y-%m-%d"), _hhmm(hour), "N", "VIIRS",
            str(rng.choice(["l", "n", "h"], p=[0.1, 0.8, 0.1])), "2", round(float(rng.uniform(285, 305)), 2),
            round(float(rng.gamma(2, 4)), 2), "D", ftype]


def write_tree(root: Path, years: range = range(2010, 2015), seed: int = 7, broken_file: bool = True) -> list[Path]:
    paths = []
    for (d, region, y), df in simulate(years, seed).items():
        p = root / "data" / "country" / d / str(y) / f"{d}_{y}_{region}.csv"
        p.parent.mkdir(parents=True, exist_ok=True)
        df.to_csv(p, index=False)
        paths.append(p)
    if broken_file:                                     # a few invalid rows in one file
        p = root / "data" / "country" / "modis" / str(years.start) / f"modis_{years.start}_Turkey.csv"
        with p.open("a") as f:
            f.write("95.1,30.0,320.0,1.0,1.0,2010-05-01,1130,Aqua,MODIS,50,6.03,290.0,10.0,D,0\n")   # bad latitude
            f.write("38.0,30.0,320.0,1.0,1.0,2010-05-01,2575,Aqua,MODIS,50,6.03,290.0,10.0,D,0\n")   # bad time
            f.write("38.0,30.0,320.0,1.0,1.0,2010-05-01,1130,,MODIS,50,6.03,290.0,10.0,D,0\n")       # no satellite
            f.write("38.0,30.0,320.0,1.0,1.0,2010-05-01,1130,Aqua,MODIS,150,6.03,290.0,-5.0,D,0\n")  # conf>100, frp<0
    return paths


if __name__ == "__main__":
    write_tree(Path(sys.argv[1]))
