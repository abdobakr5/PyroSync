"""Step 4 - Validate raw FIRMS rows. Invalid rows go to quarantine with a reason; nothing is dropped silently.

Only rules that come from the product definitions are applied. There are no invented numeric limits
on brightness or FRP: those are only checked for being numbers that are physically possible (>= 0 / > 0).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

COMMON_REQUIRED = ["latitude", "longitude", "acq_date", "acq_time", "satellite", "confidence", "version", "frp", "daynight"]
EXPECTED_COLUMNS = {
    "MODIS": COMMON_REQUIRED + ["brightness", "scan", "track", "instrument", "bright_t31", "type"],
    "VIIRS": COMMON_REQUIRED + ["bright_ti4", "scan", "track", "instrument", "bright_ti5", "type"],
}
OPTIONAL_COLUMNS = {"type", "instrument"}           # 'type' is missing from NRT files
SATELLITE_CODES = {
    "MODIS": {"T", "A", "TERRA", "AQUA"},
    "VIIRS": {"N", "NPP", "SNPP", "SUOMI NPP", "1", "N20", "J1", "NOAA-20", "NOAA20", "2", "N21", "J2", "NOAA-21", "NOAA21"},
}
VIIRS_CONF = {"l", "n", "h", "low", "nominal", "high"}
# fields that must be present for a row to be usable at all; the rest are counted as missing but kept
HARD_REQUIRED = ["latitude", "longitude", "acq_date", "acq_time", "satellite"]


def schema_report(columns: list[str], instrument: str) -> dict:
    cols = {c.strip().lower() for c in columns}
    expected = set(EXPECTED_COLUMNS[instrument])
    return {"schema_missing_cols": ";".join(sorted(expected - cols - OPTIONAL_COLUMNS)),
            "schema_unexpected_cols": ";".join(sorted(cols - expected)),
            "schema_missing_optional": ";".join(sorted((expected & OPTIONAL_COLUMNS) - cols))}


def validate(raw: pd.DataFrame, instrument: str) -> tuple[pd.Series, pd.Series, dict]:
    """raw: all-string DataFrame with lower-case column names.
    Returns (is_valid mask, reason per row ('' when valid), counters for the data-quality report)."""
    n = len(raw)
    reasons = pd.Series([""] * n, index=raw.index, dtype=object)

    def flag(mask: pd.Series, reason: str) -> int:
        mask = mask.fillna(False).astype(bool)
        reasons[mask] = reasons[mask] + reason + ";"
        return int(mask.sum())

    def col(name: str) -> pd.Series:
        return raw[name].str.strip() if name in raw.columns else pd.Series([pd.NA] * n, index=raw.index, dtype=object)

    counters = {}
    missing = {}
    for c in EXPECTED_COLUMNS[instrument]:
        s = col(c)
        missing[c] = int((s.isna() | (s == "")).sum())
    counters["missing_by_field"] = missing

    for c in HARD_REQUIRED:
        s = col(c)
        flag(s.isna() | (s == ""), f"missing_{c}")

    lat = pd.to_numeric(col("latitude"), errors="coerce")
    lon = pd.to_numeric(col("longitude"), errors="coerce")
    bad_lat = col("latitude").notna() & (col("latitude") != "") & (lat.isna() | (lat < -90) | (lat > 90))
    bad_lon = col("longitude").notna() & (col("longitude") != "") & (lon.isna() | (lon < -180) | (lon > 180))
    counters["invalid_coordinates"] = int((bad_lat | bad_lon).sum())
    flag(bad_lat, "invalid_latitude")
    flag(bad_lon, "invalid_longitude")

    d = pd.to_datetime(col("acq_date"), format="%Y-%m-%d", errors="coerce")
    t = col("acq_time").str.replace(r"\.0$", "", regex=True)
    tn = pd.to_numeric(t, errors="coerce")
    bad_time = tn.isna() | (tn < 0) | (tn > 2359) | ((tn % 100) >= 60)
    bad_date = d.isna()
    present_d = col("acq_date").notna() & (col("acq_date") != "")
    present_t = col("acq_time").notna() & (col("acq_time") != "")
    counters["timestamp_failures"] = int(((bad_date & present_d) | (bad_time & present_t)).sum())
    flag(bad_date & present_d, "unparseable_acq_date")
    flag(bad_time & present_t, "invalid_acq_time")

    sat = col("satellite").str.upper()
    flag(sat.notna() & (sat != "") & ~sat.isin(SATELLITE_CODES[instrument]), "unknown_satellite_code")

    conf = col("confidence")
    if instrument == "MODIS":
        cn = pd.to_numeric(conf, errors="coerce")
        flag(conf.notna() & (conf != "") & (cn.isna() | (cn < 0) | (cn > 100)), "invalid_confidence")
    else:
        flag(conf.notna() & (conf != "") & ~conf.str.lower().isin(VIIRS_CONF), "invalid_confidence")

    for c, rule in [("frp", "ge0"), ("scan", "gt0"), ("track", "gt0"),
                    ("brightness" if instrument == "MODIS" else "bright_ti4", "gt0"),
                    ("bright_t31" if instrument == "MODIS" else "bright_ti5", "gt0")]:
        s = col(c)
        v = pd.to_numeric(s, errors="coerce")
        present = s.notna() & (s != "")
        bad = present & (v.isna() | ~np.isfinite(v.fillna(0)) | ((v < 0) if rule == "ge0" else (v <= 0)))
        flag(bad, f"invalid_{c}")

    dn = col("daynight").str.upper()
    flag(dn.notna() & (dn != "") & ~dn.isin({"D", "N"}), "invalid_daynight")

    ft = col("fire_type") if "fire_type" in raw.columns else col("type")
    ftn = pd.to_numeric(ft, errors="coerce")
    flag(ft.notna() & (ft != "") & ~ftn.isin([0, 1, 2, 3]), "invalid_type")

    valid = reasons == ""
    counters["input_records"] = n
    counters["rejected_records"] = int((~valid).sum())
    return valid, reasons.str.rstrip(";"), counters
