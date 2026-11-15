#!/usr/bin/env python3
"""
Step 7 (Gold) - harmonized fire calendar and monthly grid.

COPY of firms_harmonize.py (the original file is unchanged). Changes in this copy:
  * build_calendar(): stages 2-7 as a function, so the pipeline can call it with Silver data
  * silver_to_legacy(): maps the canonical Silver schema to the column names used below
  * also writes monthly_grid.json and cells_summary.json (map layers for the frontend)
  * the stand-alone command line (main) still works on a folder of FIRMS CSVs

MODIS + VIIRS active-fire harmonization pipeline
NASA Space Apps 2026 - "Harmonization of MODIS and VIIRS Hot Spots"

Stages
  1. load      read every FIRMS CSV in the input folder, map both sensors to ONE standard schema
  2. clean     keep vegetation fires, nominal/high confidence, drop static sources (gas flares),
               prefer standard-processing (SP) over near-real-time (NRT), drop duplicates
  3. grid      snap detections to a grid (default 0.1 deg) -> "fire-cell-days" per sensor
  4. calibrate in the overlap period, fit VIIRS / MODIS ratio per region and calendar month
  5. harmonize two daily series per region - extent (fire-cell-days) and intensity (FRP):
               VIIRS where it exists, scaled MODIS before 2012; then check the fit (validation)
  6. calendar  climatology (same time of year across all years) -> percentile + level per day, for both
  7. export    calendar.json (for the web app), calibration + validation CSVs, monthly_grid.csv, detections.parquet

Usage
  python firms_harmonize.py --input data/raw --out output
  python firms_harmonize.py --input data/raw --out output --grid 0.1 --overlap 2012-02-01 2020-12-31
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import numpy as np
import pandas as pd

# ---------------------------------------------------------------------------
# 1. STANDARD SCHEMA
# ---------------------------------------------------------------------------
# FIRMS column name (lower-case)  ->  our standard name
RENAME = {
    "latitude": "lat",
    "longitude": "lon",
    "brightness": "bt_mir_k",   # MODIS ch 21/22 (~4 um), Kelvin
    "bright_ti4": "bt_mir_k",   # VIIRS I-4 (~4 um), Kelvin
    "bright_t31": "bt_tir_k",   # MODIS ch 31 (~11 um), Kelvin
    "bright_ti5": "bt_tir_k",   # VIIRS I-5 (~11 um), Kelvin
    "scan": "scan_km",
    "track": "track_km",
    "acq_date": "acq_date",
    "acq_time": "acq_time",
    "satellite": "satellite_raw",
    "instrument": "instrument",
    "confidence": "conf_raw",
    "version": "version",
    "frp": "frp_mw",
    "daynight": "daynight",
    "type": "fire_type",
}

# Satellite codes seen in FIRMS files (old and new spellings) -> one name
SATELLITE_NAMES = {
    "T": "Terra", "TERRA": "Terra",
    "A": "Aqua", "AQUA": "Aqua",
    "N": "S-NPP", "NPP": "S-NPP", "SNPP": "S-NPP", "SUOMI NPP": "S-NPP",
    "1": "NOAA-20", "N20": "NOAA-20", "J1": "NOAA-20", "NOAA-20": "NOAA-20", "NOAA20": "NOAA-20",
    "2": "NOAA-21", "N21": "NOAA-21", "J2": "NOAA-21", "NOAA-21": "NOAA-21", "NOAA21": "NOAA-21",
}

STANDARD_COLUMNS = [
    "sensor",          # MODIS | VIIRS
    "satellite",       # Terra | Aqua | S-NPP | NOAA-20 | NOAA-21
    "processing",      # SP (standard, science quality) | NRT (near real-time)
    "version",         # raw FIRMS version string, e.g. 6.1, 6.1NRT, 2.0NRT
    "region",          # country / region name (from file name, or --region-name)
    "date_utc",        # acquisition date, UTC
    "time_utc",        # acquisition time, "HHMM" UTC
    "datetime_utc",    # full timestamp, UTC
    "date_local",      # local SOLAR date (UTC + lon/15 h) - keeps a night's fire on one day
    "lat", "lon",      # pixel centre, degrees
    "bt_mir_k",        # mid-infrared (~4 um) brightness temperature, K
    "bt_tir_k",        # thermal-infrared (~11 um) brightness temperature, K
    "scan_km", "track_km",
    "pixel_area_km2",  # scan_km * track_km
    "frp_mw",          # fire radiative power, MW
    "conf_raw",        # original confidence: 0-100 (MODIS) or l/n/h (VIIRS)
    "conf_class",      # low | nominal | high  (same scale for both sensors)
    "daynight",        # D | N
    "fire_type",       # 0 vegetation, 1 volcano, 2 static land source, 3 offshore; NaN in NRT files
    "source_file",
]

YEAR_COUNTRY_RE = re.compile(r"_(\d{4})_(.+)$")  # e.g. modis_2021_Turkey -> Turkey


def region_from_filename(path: Path, default: str) -> str:
    m = YEAR_COUNTRY_RE.search(path.stem)
    return m.group(2).replace("_", " ").strip() if m else default


def modis_conf_class(v: pd.Series) -> pd.Series:
    """MODIS user guide: 0-29 low, 30-79 nominal, 80-100 high."""
    x = pd.to_numeric(v, errors="coerce")
    out = pd.Series(pd.NA, index=v.index, dtype="object")
    out[x < 30] = "low"
    out[(x >= 30) & (x < 80)] = "nominal"
    out[x >= 80] = "high"
    return out


def viirs_conf_class(v: pd.Series) -> pd.Series:
    s = v.astype(str).str.strip().str.lower().str[0]
    return s.map({"l": "low", "n": "nominal", "h": "high"})


def standardize(df: pd.DataFrame, source_file: str, region: str) -> pd.DataFrame:
    """Map one raw FIRMS table (MODIS or VIIRS) to the standard schema."""
    df = df.rename(columns={c: c.strip().lower() for c in df.columns})

    # which sensor? trust the instrument column, else infer from channel names
    if "instrument" in df.columns:
        sensor = df["instrument"].astype(str).str.upper().str.strip()
    elif "bright_ti4" in df.columns:
        sensor = pd.Series("VIIRS", index=df.index)
    elif "brightness" in df.columns:
        sensor = pd.Series("MODIS", index=df.index)
    else:
        raise ValueError(f"{source_file}: cannot tell if this is MODIS or VIIRS")

    df = df.rename(columns={k: v for k, v in RENAME.items() if k in df.columns})
    out = pd.DataFrame(index=df.index)
    out["sensor"] = sensor.values

    sat = df.get("satellite_raw", pd.Series("", index=df.index)).astype(str).str.strip().str.upper()
    out["satellite"] = sat.map(SATELLITE_NAMES).fillna(sat)

    version = df.get("version", pd.Series("", index=df.index)).astype(str).str.strip()
    out["version"] = version
    out["processing"] = np.where(version.str.upper().str.contains("RT"), "NRT", "SP")
    out["region"] = region

    t = df["acq_time"].astype(str).str.replace(r"\.0$", "", regex=True).str.zfill(4)
    out["date_utc"] = pd.to_datetime(df["acq_date"]).dt.normalize()
    out["time_utc"] = t
    out["datetime_utc"] = out["date_utc"] + pd.to_timedelta(t.str[:2].astype(int), unit="h") \
        + pd.to_timedelta(t.str[2:].astype(int), unit="m")

    for c in ["lat", "lon", "bt_mir_k", "bt_tir_k", "scan_km", "track_km", "frp_mw"]:
        out[c] = pd.to_numeric(df[c], errors="coerce") if c in df.columns else np.nan
    out["pixel_area_km2"] = out["scan_km"] * out["track_km"]

    # local solar date: a fire seen at 23:30 UTC over Egypt is really "tomorrow" locally
    solar = out["datetime_utc"] + pd.to_timedelta(out["lon"] / 15.0, unit="h")
    out["date_local"] = solar.dt.normalize()

    out["conf_raw"] = df["conf_raw"].astype(str) if "conf_raw" in df.columns else pd.NA
    is_modis = out["sensor"].eq("MODIS")
    conf = pd.Series(pd.NA, index=df.index, dtype="object")
    if "conf_raw" in df.columns:
        conf[is_modis] = modis_conf_class(df.loc[is_modis, "conf_raw"])
        conf[~is_modis] = viirs_conf_class(df.loc[~is_modis, "conf_raw"])
    out["conf_class"] = conf

    out["daynight"] = df.get("daynight", pd.Series(pd.NA, index=df.index))
    out["fire_type"] = pd.to_numeric(df["fire_type"], errors="coerce") if "fire_type" in df.columns else np.nan
    out["source_file"] = source_file
    return out[STANDARD_COLUMNS]


def load_folder(folder: Path, default_region: str) -> pd.DataFrame:
    files = sorted(p for p in folder.rglob("*.csv"))
    if not files:
        raise SystemExit(f"No CSV files found in {folder}")
    parts = []
    for p in files:
        raw = pd.read_csv(p, low_memory=False)
        if raw.empty:
            continue
        region = region_from_filename(p, default_region)
        parts.append(standardize(raw, p.name, region))
        print(f"  loaded {p.name:<45} {len(raw):>9,} rows  region={region}  sensor={parts[-1]['sensor'].iloc[0]}")
    return pd.concat(parts, ignore_index=True)


# ---------------------------------------------------------------------------
# 2. CLEAN
# ---------------------------------------------------------------------------
def clean(df: pd.DataFrame, static_days_per_year: int, keep_low_conf: bool) -> pd.DataFrame:
    n0 = len(df)
    log = {}

    # exact duplicates (same pass, same pixel) - happens when country + custom-area files overlap
    df = df.drop_duplicates(subset=["satellite", "datetime_utc", "lat", "lon"])
    log["duplicates"] = n0 - len(df)

    # prefer SP over NRT: if a satellite has SP data for a day, drop its NRT rows for that day
    sp = df.loc[df.processing == "SP", ["satellite", "date_utc"]].drop_duplicates().assign(_sp=True)
    has_sp = df[["satellite", "date_utc"]].merge(sp, how="left", on=["satellite", "date_utc"])._sp.notna().values
    is_redundant_nrt = pd.Series((df.processing == "NRT").values & has_sp, index=df.index)
    log["nrt_replaced_by_sp"] = int(is_redundant_nrt.sum())
    df = df[~is_redundant_nrt]

    # vegetation fires only (type is missing in NRT files -> keep, static mask below handles them)
    bad_type = df.fire_type.notna() & (df.fire_type != 0)
    log["non_vegetation_type"] = int(bad_type.sum())
    df = df[~bad_type]

    if not keep_low_conf:
        low = df.conf_class.eq("low")
        log["low_confidence"] = int(low.sum())
        df = df[~low]

    # static-source mask: ~1 km cells burning on too many days a year are flares / industry
    cell = ((np.floor(df.lat / 0.01).astype(np.int64) + 20000) * 100000
            + (np.floor(df.lon / 0.01).astype(np.int64) + 20000))
    days = df.assign(_c=cell, _y=df.date_local.dt.year).groupby(["_c", "_y"]).date_local.nunique()
    static_cells = set(days[days > static_days_per_year].index.get_level_values(0))
    is_static = cell.isin(static_cells)
    log["static_source"] = int(is_static.sum())
    df = df[~is_static]

    print("  removed:", ", ".join(f"{k}={v:,}" for k, v in log.items()), f"| kept {len(df):,} of {n0:,}")
    return df.reset_index(drop=True)


# ---------------------------------------------------------------------------
# 3. GRID -> fire-cell-days
# ---------------------------------------------------------------------------
def to_grid(df: pd.DataFrame, res: float) -> pd.DataFrame:
    g = df.assign(
        cell_lat=(np.floor(df.lat / res) * res + res / 2).round(4),
        cell_lon=(np.floor(df.lon / res) * res + res / 2).round(4),
        date=df.date_local,
    )
    return (g.groupby(["region", "sensor", "date", "cell_lat", "cell_lon"])
             .agg(n_det=("frp_mw", "size"), frp_sum=("frp_mw", "sum"))
             .reset_index())


def daily_series(cells: pd.DataFrame, sensor: str) -> pd.DataFrame:
    s = cells[cells.sensor == sensor]
    return (s.groupby(["region", "date"])
             .agg(fire_cells=("n_det", "size"), detections=("n_det", "sum"), frp_sum=("frp_sum", "sum"))
             .add_prefix(sensor.lower() + "_"))


# ---------------------------------------------------------------------------
# 4. CALIBRATE  (VIIRS / MODIS ratios in the overlap period, for counts and for FRP)
# ---------------------------------------------------------------------------
SUM_COLS = ["modis_fire_cells", "viirs_fire_cells", "modis_frp_sum", "viirs_frp_sum"]


def calibrate(daily: pd.DataFrame, start: str, end: str, min_modis: int) -> tuple[pd.DataFrame, pd.DataFrame]:
    d = daily.reset_index()
    ov = d[(d.date >= start) & (d.date <= end)].copy()
    ov["month"] = ov.date.dt.month
    ov["year"] = ov.date.dt.year

    m = ov.groupby(["region", "month"])[SUM_COLS].sum()   # per region + calendar month (pooled over years)
    r = ov.groupby("region")[SUM_COLS].sum()               # per region, all months (fallback)
    g = ov[SUM_COLS].sum()                                 # everything (last resort)
    weak = m.modis_fire_cells < min_modis                  # too few MODIS fires for a monthly ratio
    regions = m.index.get_level_values("region")

    # fire-cell-day ratio
    r_ratio = (r.viirs_fire_cells / r.modis_fire_cells).replace([np.inf], np.nan)
    global_ratio = g.viirs_fire_cells / g.modis_fire_cells if g.modis_fire_cells else np.nan
    m["ratio"] = m.viirs_fire_cells / m.modis_fire_cells
    m["method"] = "region-month"
    m.loc[weak, "ratio"] = r_ratio.reindex(regions[weak]).values
    m.loc[weak, "method"] = "region-annual (few MODIS fires this month)"
    still = m.ratio.isna()
    m.loc[still, "ratio"] = global_ratio
    m.loc[still, "method"] = "all-regions"

    # FRP ratio (same fallback rules)
    r_frp = r.viirs_frp_sum / r.modis_frp_sum
    global_frp = g.viirs_frp_sum / g.modis_frp_sum if g.modis_frp_sum else np.nan
    m["frp_ratio"] = m.viirs_frp_sum / m.modis_frp_sum
    m.loc[weak, "frp_ratio"] = r_frp.reindex(regions[weak]).values
    m["frp_ratio"] = m.frp_ratio.replace([np.inf], np.nan)
    m.loc[m.frp_ratio.isna(), "frp_ratio"] = global_frp

    # per region + year: shows whether the ratios are stable over time
    y = ov.groupby(["region", "year"])[SUM_COLS].sum()
    y["ratio"] = y.viirs_fire_cells / y.modis_fire_cells
    y["frp_ratio"] = y.viirs_frp_sum / y.modis_frp_sum
    return m.reset_index(), y.reset_index()


# ---------------------------------------------------------------------------
# 5. HARMONIZE
# ---------------------------------------------------------------------------
def harmonize(daily: pd.DataFrame, ratios: pd.DataFrame, viirs_start: pd.Timestamp,
              start: pd.Timestamp, end: pd.Timestamp) -> pd.DataFrame:
    d = daily.reset_index()
    # every region gets every day in the range (no detection = 0 fires, not missing)
    idx = pd.date_range(start, end, freq="D")
    full = []
    for region, grp in d.groupby("region"):
        g = grp.set_index("date").reindex(idx).rename_axis("date").reset_index()
        g["region"] = region
        full.append(g)
    d = pd.concat(full, ignore_index=True)
    for c in d.columns:
        if c.startswith(("modis_", "viirs_")):
            d[c] = d[c].fillna(0)

    d["month"] = d.date.dt.month
    d = d.merge(ratios[["region", "month", "ratio", "frp_ratio"]], on=["region", "month"], how="left")
    d["ratio"] = d["ratio"].fillna(ratios.ratio.median())
    d["frp_ratio"] = d["frp_ratio"].fillna(ratios.frp_ratio.median())

    before = d.date < viirs_start
    d["harmonized"] = np.where(before, d.modis_fire_cells * d.ratio, d.viirs_fire_cells)       # extent
    d["frp_harmonized"] = np.where(before, d.modis_frp_sum * d.frp_ratio, d.viirs_frp_sum)     # intensity
    d["source"] = np.where(before, "MODIS x ratio", "VIIRS")
    return d.drop(columns=["month"])


def validate(h: pd.DataFrame, ov_start: str, ov_end: str) -> tuple[pd.DataFrame, pd.DataFrame]:
    """How well does MODIS x ratio reproduce what VIIRS really saw?
    calibration = months inside the calibration period, holdout = months after it (never used for fitting)."""
    d = h[h.date >= ov_start].copy()
    d["pred"] = d.modis_fire_cells * d.ratio
    d["pred_frp"] = d.modis_frp_sum * d.frp_ratio
    d["period"] = np.where(d.date <= ov_end, "calibration", "holdout")
    d["ym"] = d.date.dt.strftime("%Y-%m")
    d["year"] = d.date.dt.year
    cols = ["pred", "viirs_fire_cells", "pred_frp", "viirs_frp_sum"]
    m = d.groupby(["region", "period", "ym"])[cols].sum().reset_index()
    rows = []
    for (region, period), g in m.groupby(["region", "period"]):
        ok = len(g) >= 3
        rows.append({"region": region, "period": period, "months": len(g),
                     "r_monthly": round(g.pred.corr(g.viirs_fire_cells), 3) if ok else np.nan,
                     "pred_over_actual": round(g.pred.sum() / g.viirs_fire_cells.sum(), 3),
                     "r_monthly_frp": round(g.pred_frp.corr(g.viirs_frp_sum), 3) if ok else np.nan,
                     "pred_over_actual_frp": round(g.pred_frp.sum() / g.viirs_frp_sum.sum(), 3)})
    y = d.groupby(["region", "year"])[cols].sum().reset_index()
    y["pred_over_actual"] = (y.pred / y.viirs_fire_cells).round(3)
    y["pred_over_actual_frp"] = (y.pred_frp / y.viirs_frp_sum).round(3)
    y["pred"] = y.pred.round(1)
    y["pred_frp"] = y.pred_frp.round(1)
    y["viirs_frp_sum"] = y.viirs_frp_sum.round(1)
    y = y.rename(columns={"pred": "modis_x_ratio", "pred_frp": "modis_frp_x_ratio"})
    return pd.DataFrame(rows), y[["region", "year", "modis_x_ratio", "viirs_fire_cells", "pred_over_actual",
                                  "modis_frp_x_ratio", "viirs_frp_sum", "pred_over_actual_frp"]]


# ---------------------------------------------------------------------------
# 6. CALENDAR  (how unusual is each day for its time of year?)
# ---------------------------------------------------------------------------
LEVEL_BINS, LEVEL_LABELS = [-1, 25, 75, 90, 97, 101], ["low", "normal", "elevated", "high", "extreme"]


def season_stats(dates: pd.Series, values: pd.Series, smooth_days: int, window: int):
    """Smooth a daily series, then rank every day against the same +/- window days of the year in all years."""
    smooth = values.rolling(smooth_days, center=True, min_periods=1).mean().round(6).to_numpy()
    doy = dates.dt.dayofyear.clip(upper=365).to_numpy()     # fold Dec 31 of leap years into 365
    table = (pd.DataFrame({"y": dates.dt.year.to_numpy(), "d": doy, "v": smooth})
             .pivot_table(index="y", columns="d", values="v").reindex(columns=range(1, 366)))
    arr = table.to_numpy()                                   # years x 365
    p50, p90, pct = np.full(365, np.nan), np.full(365, np.nan), np.full(len(smooth), np.nan)
    for k in range(365):
        cols = [(k + o) % 365 for o in range(-window, window + 1)]
        ref = arr[:, cols].ravel()
        ref = ref[~np.isnan(ref)]
        if ref.size == 0:
            continue
        p50[k], p90[k] = np.percentile(ref, [50, 90])
        mask = (doy - 1) == k
        pct[mask] = np.searchsorted(np.sort(ref), smooth[mask], side="right") / ref.size * 100
    return smooth, pct.round(1), np.round(p50, 2).tolist(), np.round(p90, 2).tolist()


def to_level(pct: np.ndarray, smooth: np.ndarray, activity: np.ndarray, min_active: float) -> np.ndarray:
    level = pd.Series(pd.cut(pct, LEVEL_BINS, labels=LEVEL_LABELS)).astype(str).to_numpy(dtype=object)
    # in a quiet season 1-2 fires would rank "extreme"; require real activity first
    level[(activity < min_active) & np.isin(level, ["elevated", "high", "extreme"])] = "normal"
    level[smooth <= 0] = "none"
    return level


def add_climatology(h: pd.DataFrame, smooth_days: int, window: int,
                    min_active: float) -> tuple[pd.DataFrame, dict]:
    out, clim_all = [], {}
    for region, g in h.groupby("region"):
        g = g.sort_values("date").copy()
        sm, pct, p50, p90 = season_stats(g.date, g.harmonized, smooth_days, window)            # extent
        fsm, fpct, f50, f90 = season_stats(g.date, g.frp_harmonized, smooth_days, window)      # intensity
        g["smooth"], g["percentile"], g["level"] = sm, pct, to_level(pct, sm, sm, min_active)
        g["frp_smooth"], g["frp_percentile"], g["frp_level"] = fsm, fpct, to_level(fpct, fsm, sm, min_active)
        out.append(g)
        clim_all[region] = {"p50": p50, "p90": p90, "frp_p50": f50, "frp_p90": f90}
    return pd.concat(out, ignore_index=True), clim_all


# ---------------------------------------------------------------------------
# 7. EXPORT
# ---------------------------------------------------------------------------
def monthly_grid(cells: pd.DataFrame, ratios: pd.DataFrame, viirs_start: pd.Timestamp) -> pd.DataFrame:
    """Harmonized fire-days and FRP per grid cell per month - for a map layer."""
    c = cells.copy()
    c["month"] = c.date.dt.month
    use = ((c.sensor == "MODIS") & (c.date < viirs_start)) | ((c.sensor == "VIIRS") & (c.date >= viirs_start))
    c = c[use].merge(ratios[["region", "month", "ratio", "frp_ratio"]], on=["region", "month"], how="left")
    is_modis = c.sensor == "MODIS"
    c["w"] = np.where(is_modis, c.ratio.fillna(1.0), 1.0)
    c["frp_w"] = c.frp_sum * np.where(is_modis, c.frp_ratio.fillna(1.0), 1.0)
    c["ym"] = c.date.dt.strftime("%Y-%m")
    return (c.groupby(["region", "ym", "cell_lat", "cell_lon"])
             .agg(fire_days=("w", "sum"), frp_sum=("frp_w", "sum"))
             .round(2).reset_index())


DAILY_COLUMNS = ["date", "harmonized", "modis_fire_cells", "viirs_fire_cells", "frp_mw", "source",
                 "percentile", "level", "frp_percentile", "frp_level"]


def export_calendar(cal: pd.DataFrame, clim: dict, meta: dict, path: Path) -> None:
    num = lambda v: None if np.isnan(v) else float(v)
    regions = {}
    for region, g in cal.groupby("region"):
        g = g.sort_values("date")
        regions[region] = {
            "start": g.date.min().strftime("%Y-%m-%d"),
            "end": g.date.max().strftime("%Y-%m-%d"),
            # one row per day; columns listed in meta.daily_columns
            "daily": [
                [r.date.strftime("%Y-%m-%d"), round(float(r.harmonized), 2), int(r.modis_fire_cells),
                 int(r.viirs_fire_cells), round(float(r.frp_harmonized), 1), r.source,
                 num(r.percentile), r.level, num(r.frp_percentile), r.frp_level]
                for r in g.itertuples()
            ],
            "climatology": clim[region],  # index 0 = day-of-year 1
        }
    payload = {"meta": meta, "regions": regions}
    path.write_text(json.dumps(payload, separators=(",", ":")))


# ---------------------------------------------------------------------------
LEGACY_MAP = {"source_instrument": "sensor", "acq_date_utc": "date_utc", "acquisition_timestamp": "datetime_utc",
              "local_solar_date": "date_local", "latitude": "lat", "longitude": "lon", "confidence_class": "conf_class"}


def silver_to_legacy(df: pd.DataFrame) -> pd.DataFrame:
    """Canonical Silver columns -> the column names this module was written with."""
    out = df.rename(columns=LEGACY_MAP)
    out["time_utc"] = out.datetime_utc.dt.strftime("%H%M")
    return out


def grid_json(grid: pd.DataFrame) -> dict:
    """monthly_grid.csv -> map-ready JSON: one list of cells per month."""
    regions = sorted(grid.region.unique())
    ri = {r: i for i, r in enumerate(regions)}
    months = pd.period_range(grid.ym.min(), grid.ym.max(), freq="M").strftime("%Y-%m").tolist() if len(grid) else []
    data = {m: [] for m in months}
    for r in grid.itertuples(index=False):
        data[r.ym].append([r.cell_lat, r.cell_lon, ri[r.region], round(float(r.fire_days), 2), round(float(r.frp_sum), 1)])
    return {"meta": {"description": "Harmonized fire activity per grid cell per month",
                     "cell_point": "cell centre", "columns": ["lat", "lon", "region", "fire_days", "frp_mw"],
                     "region_names": regions,
                     "units": {"fire_days": "VIIRS-equivalent days with fire in the cell that month (fractional before VIIRS start: scaled MODIS)",
                               "frp_mw": "VIIRS-equivalent sum of fire radiative power, MW"},
                     "months": months}, "data": data}


def cells_summary_json(grid: pd.DataFrame) -> dict:
    """Typical-year base layer: average fire-days per year and per calendar month for every cell."""
    regions = sorted(grid.region.unique())
    ri = {r: i for i, r in enumerate(regions)}
    g = grid.assign(month=grid.ym.str[5:].astype(int))
    n_years = max(g.ym.str[:4].nunique(), 1)
    tot = g.groupby(["cell_lat", "cell_lon", "region"]).agg(fire_days=("fire_days", "sum"), frp=("frp_sum", "sum")).reset_index()
    bym = (g.groupby(["cell_lat", "cell_lon", "month"]).fire_days.sum().unstack(fill_value=0)
           .reindex(columns=range(1, 13), fill_value=0) / n_years).round(2)
    bym_list = {k: list(v) for k, v in zip(bym.index, bym.to_numpy().tolist())}
    cells = []
    for r in tot.itertuples(index=False):
        mm = bym_list[(r.cell_lat, r.cell_lon)]
        cells.append([r.cell_lat, r.cell_lon, ri[r.region], round(r.fire_days / n_years, 2), round(r.frp / n_years, 1),
                      int(np.argmax(mm)) + 1, mm])
    return {"meta": {"description": "Typical (average) fire activity per grid cell - static base layer for the map",
                     "years": n_years, "columns": ["lat", "lon", "region", "fire_days_per_year", "frp_mw_per_year",
                                                   "peak_month", "mean_fire_days_by_month (Jan..Dec)"],
                     "region_names": regions}, "cells": cells}


def build_calendar(det: pd.DataFrame, out: Path, grid: float = 0.1, start_date: str = "2003-01-01",
                   overlap: tuple[str, str] = ("2012-02-01", "2020-12-31"), viirs_sats: list[str] | None = None,
                   static_days: int = 60, min_modis: int = 30, keep_low_conf: bool = False, smooth_days: int = 7,
                   season_window: int = 15, min_active: float = 2.0) -> dict:
    """Stages 2-7 on a standardized detections table (legacy column names). Returns a small summary."""
    out.mkdir(parents=True, exist_ok=True)
    viirs_sats = viirs_sats or ["S-NPP"]
    overlap = list(overlap)
    det = det[(det.sensor == "MODIS") | det.satellite.isin(viirs_sats)]
    det = clean(det, static_days, keep_low_conf)

    start = max(pd.Timestamp(start_date), det.date_utc.min())
    end = min(det.date_local.max(), det.date_utc.max())
    cells = to_grid(det, grid)
    cells = cells[(cells.date >= start) & (cells.date <= end)]
    daily = daily_series(cells, "MODIS").join(daily_series(cells, "VIIRS"), how="outer").fillna(0)
    viirs_dates = cells.loc[cells.sensor == "VIIRS", "date"]
    viirs_start = viirs_dates.min() if len(viirs_dates) else pd.Timestamp.max

    ratios, yearly = calibrate(daily, *overlap, min_modis=min_modis)
    ratios.to_csv(out / "calibration_region_month.csv", index=False)
    yearly.to_csv(out / "calibration_region_year.csv", index=False)
    h = harmonize(daily, ratios, viirs_start, start, end)
    val, val_year = validate(h, *overlap)
    val.to_csv(out / "validation.csv", index=False)
    val_year.to_csv(out / "validation_by_year.csv", index=False)
    cal, clim = add_climatology(h, smooth_days, season_window, min_active)
    cal.to_csv(out / "calendar_daily.csv", index=False)
    mg = monthly_grid(cells, ratios, viirs_start)
    mg.to_csv(out / "monthly_grid.csv", index=False)
    (out / "monthly_grid.json").write_text(json.dumps(grid_json(mg), separators=(",", ":")))
    (out / "cells_summary.json").write_text(json.dumps(cells_summary_json(mg), separators=(",", ":")))
    meta = {
        "unit": "VIIRS-equivalent fire-cell-days",
        "frp_unit": "VIIRS-equivalent MW (daily sum of pixel FRP)",
        "grid_deg": grid,
        "viirs_satellites": viirs_sats,
        "viirs_start": None if viirs_start is pd.Timestamp.max else viirs_start.strftime("%Y-%m-%d"),
        "calibration_period": overlap,
        "start": start.strftime("%Y-%m-%d"), "end": end.strftime("%Y-%m-%d"),
        "smooth_days": smooth_days, "season_window_days": season_window, "min_active": min_active,
        "daily_columns": DAILY_COLUMNS,
        "levels": ["none", "low", "normal", "elevated", "high", "extreme"],
    }
    export_calendar(cal, clim, meta, out / "calendar.json")
    return {"start": meta["start"], "end": meta["end"], "regions": int(cal.region.nunique()),
            "calendar_days": int(len(cal)), "grid_rows": int(len(mg)), "detections_used": int(len(det))}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--input", required=True, type=Path, help="folder with FIRMS CSV files (searched recursively)")
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--region-name", default="region", help="region name when it can't be read from the file name")
    ap.add_argument("--grid", type=float, default=0.1, help="grid cell size in degrees (default 0.1 ~ 11 km)")
    ap.add_argument("--overlap", nargs=2, default=["2012-02-01", "2020-12-31"], metavar=("START", "END"),
                    help="calibration period; default stops before MODIS orbit drift got large")
    ap.add_argument("--start", default="2003-01-01",
                    help="first day of the calendar; default 2003 = both Terra and Aqua flying all year")
    ap.add_argument("--viirs-sats", default="S-NPP", help="comma list of VIIRS satellites to use (default S-NPP)")
    ap.add_argument("--static-days", type=int, default=60, help="~1 km cell burning > N days/year = static source")
    ap.add_argument("--min-modis", type=int, default=30, help="min MODIS fire-cell-days for a monthly ratio")
    ap.add_argument("--keep-low-conf", action="store_true")
    ap.add_argument("--smooth-days", type=int, default=7)
    ap.add_argument("--season-window", type=int, default=15, help="+/- days used to define 'same time of year'")
    ap.add_argument("--min-active", type=float, default=2.0,
                    help="smoothed fire-cells/day needed before a day can be elevated/high/extreme")
    a = ap.parse_args()
    a.out.mkdir(parents=True, exist_ok=True)
    det = load_folder(a.input, a.region_name)
    det.to_parquet(a.out / "detections_standard.parquet", index=False)
    summary = build_calendar(det, a.out, a.grid, a.start, a.overlap, [s.strip() for s in a.viirs_sats.split(",")],
                             a.static_days, a.min_modis, a.keep_low_conf, a.smooth_days, a.season_window, a.min_active)
    print(summary)


if __name__ == "__main__":
    main()
