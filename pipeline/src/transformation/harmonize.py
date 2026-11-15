"""Step 4 - Map validated MODIS and VIIRS rows into one canonical schema (docs/data_dictionary.md).

Original values are kept (confidence_raw, version, raw brightness fields) next to the standardized ones.
"""
from __future__ import annotations

import hashlib

import numpy as np
import pandas as pd

SATELLITE_NAMES = {
    "T": "Terra", "TERRA": "Terra", "A": "Aqua", "AQUA": "Aqua",
    "N": "S-NPP", "NPP": "S-NPP", "SNPP": "S-NPP", "SUOMI NPP": "S-NPP",
    "1": "NOAA-20", "N20": "NOAA-20", "J1": "NOAA-20", "NOAA-20": "NOAA-20", "NOAA20": "NOAA-20",
    "2": "NOAA-21", "N21": "NOAA-21", "J2": "NOAA-21", "NOAA-21": "NOAA-21", "NOAA21": "NOAA-21",
}

CANONICAL_COLUMNS = [
    "detection_id", "source_instrument", "source_product", "product_key", "satellite", "processing", "version",
    "region", "acquisition_timestamp", "acq_date_utc", "local_solar_date", "local_solar_hour",
    "latitude", "longitude", "brightness_mir_k", "brightness_tir_k", "scan_km", "track_km", "pixel_area_km2",
    "frp_mw", "confidence_raw", "confidence_class", "daynight", "fire_type",
    "source_file", "source_row", "ingestion_run_id", "processing_version",
]


def detection_ids(product_key: pd.Series, sat: pd.Series, d: pd.Series, t: pd.Series,
                  lat: pd.Series, lon: pd.Series) -> list[str]:
    """Stable ID from the source values (same input row -> same ID on every run)."""
    keys = product_key + "|" + sat + "|" + d + "|" + t + "|" + lat + "|" + lon
    return [hashlib.sha1(k.encode()).hexdigest()[:20] for k in keys]


def confidence_class(raw: pd.Series, instrument: str) -> pd.Series:
    """Common low/nominal/high scale. MODIS 0-29/30-79/80-100 follows the MODIS user guide classes;
    VIIRS already reports l/n/h. Classes are NOT claimed to be equivalent between sensors."""
    if instrument == "MODIS":
        x = pd.to_numeric(raw, errors="coerce")
        out = pd.Series(pd.NA, index=raw.index, dtype=object)
        out[x < 30] = "low"
        out[(x >= 30) & (x < 80)] = "nominal"
        out[x >= 80] = "high"
        return out
    return raw.str.strip().str.lower().str[0].map({"l": "low", "n": "nominal", "h": "high"})


def harmonize(raw: pd.DataFrame, product: dict, region: str, source_file: str, ingestion_run_id: str,
              processing_version: str) -> pd.DataFrame:
    """raw: validated all-string rows (lower-case columns) with a 'source_row' column."""
    inst = product["instrument"]
    s = lambda c: raw[c].str.strip() if c in raw.columns else pd.Series([pd.NA] * len(raw), index=raw.index, dtype=object)
    num = lambda c: pd.to_numeric(s(c), errors="coerce")

    sat_code = s("satellite").str.upper()
    t = s("acq_time").str.replace(r"\.0$", "", regex=True).str.zfill(4)
    d = s("acq_date")
    ts = pd.to_datetime(d + " " + t.str[:2] + ":" + t.str[2:], format="%Y-%m-%d %H:%M", utc=True)
    lat, lon = num("latitude"), num("longitude")
    solar = ts + pd.to_timedelta(lon / 15.0, unit="h")        # local solar time = UTC + lon/15 h

    out = pd.DataFrame(index=raw.index)
    out["detection_id"] = detection_ids(pd.Series(product["key"], index=raw.index), sat_code, d, t,
                                        s("latitude"), s("longitude"))
    out["source_instrument"] = inst
    out["source_product"] = product["product"]
    out["product_key"] = product["key"]
    out["satellite"] = sat_code.map(SATELLITE_NAMES).fillna(sat_code)
    version = s("version").fillna("")
    out["processing"] = np.where(version.str.upper().str.contains("RT"), "NRT", "SP")
    out["version"] = version
    out["region"] = region
    out["acquisition_timestamp"] = ts
    out["acq_date_utc"] = ts.dt.tz_convert(None).dt.normalize()
    out["local_solar_date"] = solar.dt.tz_convert(None).dt.normalize()
    out["local_solar_hour"] = (solar.dt.hour + solar.dt.minute / 60).round(2)
    out["latitude"], out["longitude"] = lat, lon
    out["brightness_mir_k"] = num("brightness" if inst == "MODIS" else "bright_ti4")
    out["brightness_tir_k"] = num("bright_t31" if inst == "MODIS" else "bright_ti5")
    out["scan_km"], out["track_km"] = num("scan"), num("track")
    out["pixel_area_km2"] = out.scan_km * out.track_km
    out["frp_mw"] = num("frp")
    out["confidence_raw"] = s("confidence")
    out["confidence_class"] = confidence_class(s("confidence"), inst)
    out["daynight"] = s("daynight").str.upper()
    out["fire_type"] = pd.to_numeric(s("type"), errors="coerce").astype("Int8")
    out["source_file"] = source_file
    out["source_row"] = raw["source_row"].astype("int64")
    out["ingestion_run_id"] = ingestion_run_id
    out["processing_version"] = processing_version
    return out[CANONICAL_COLUMNS]
