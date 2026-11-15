"""Step 9 - Model input for the AI Engineer, and a validator for model outputs.

Input grain (default, change with the AI Engineer): ONE ROW PER COMPARED DETECTION (MODIS or VIIRS) in the
comparison period. Every row keeps its detection_id, so predictions trace back to Silver and Bronze.

Leakage control:
  split           temporal blocks: train <= 2019, validation 2020-2021, test >= 2022 (configurable)
  spatial_block   1 x 1 degree tile id, for spatial cross-validation (keep a tile in one fold only)
Features use only information from the detection itself, the other sensor at the same overpass, and the
grid cell's history BEFORE that month - never the future.

Outputs: data/gold/ai/<gold_run_id>/model_input.parquet + model_input_schema.json
Predictions are validated with validate_predictions() before they are stored or loaded to the database.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

from src.common.config import Config
from src.transformation.silver import read_silver

FEATURES = {
    "detection_id": "string - Silver detection_id (key)",
    "instrument": "MODIS | VIIRS",
    "satellite": "Terra | Aqua | S-NPP | NOAA-20 | NOAA-21",
    "region": "country name",
    "acquisition_timestamp": "UTC timestamp",
    "year": "int", "month": "int 1-12",
    "local_solar_hour": "float, hours",
    "daynight": "D | N",
    "latitude": "deg", "longitude": "deg",
    "frp_mw": "MW",
    "brightness_mir_k": "K (~4 um channel)",
    "brightness_tir_k": "K (~11 um channel)",
    "brightness_difference_k": "K, mir - tir",
    "scan_km": "km", "track_km": "km", "pixel_area_km2": "km2",
    "confidence_class": "low | nominal | high (sensor-specific meaning)",
    "match_status": "matched | candidate_unassigned | modis_only | viirs_only (candidate target)",
    "n_candidates": "int, candidate pairs for a MODIS detection (0 for VIIRS rows)",
    "other_sensor_distance_m": "m, pair distance if matched, else nearest other-sensor detection in the time window",
    "other_sensor_pass_evidence": "bool, the other sensor detected any fire nearby at that time",
    "cell_fire_days_prior_12m": "float, fire-days in the same 0.1 deg cell over the previous 12 months (all sensors)",
    "split": "train | validation | test",
    "spatial_block": "string, 1 deg tile id",
}
PREDICTION_SCHEMA = {"prediction_id": "string", "input_record_id": "string", "model_name": "string",
                     "model_version": "string", "prediction_label": "string", "prediction_score": "float",
                     "inference_timestamp": "timestamp (UTC)"}


def build_model_input(cfg: Config, gold_dir: Path | None = None, train_until: int = 2019, val_until: int = 2021) -> Path:
    gold_dir = gold_dir or cfg.gold / "current"
    manifest = json.loads((gold_dir / "manifest.json").read_text())
    matches = pd.read_parquet(gold_dir / "detection_matches.parquet")
    det = read_silver(cfg)

    m_rows = (matches.dropna(subset=["modis_detection_id"]).sort_values("distance_m")
              .drop_duplicates("modis_detection_id").rename(columns={"modis_detection_id": "detection_id"}))
    v_rows = matches.dropna(subset=["viirs_detection_id"]).rename(columns={"viirs_detection_id": "detection_id"})
    v_rows = v_rows.assign(n_candidates=0)
    st = pd.concat([m_rows, v_rows], ignore_index=True)
    st["other_sensor_distance_m"] = st.distance_m.fillna(st.nearest_other_distance_m)
    st.loc[st.match_status == "matched", "other_sensor_pass_evidence"] = True
    st = st[["detection_id", "match_status", "n_candidates", "other_sensor_distance_m", "other_sensor_pass_evidence"]]

    x = det.merge(st, on="detection_id", how="inner")
    x = x.rename(columns={"source_instrument": "instrument"})
    x["year"] = x.acquisition_timestamp.dt.year
    x["month"] = x.acquisition_timestamp.dt.month
    x["brightness_difference_k"] = x.brightness_mir_k - x.brightness_tir_k
    x["cell_fire_days_prior_12m"] = _prior_cell_activity(det, x, cfg.pipeline["gold"]["grid_deg"])
    x["split"] = np.where(x.year <= train_until, "train", np.where(x.year <= val_until, "validation", "test"))
    x["spatial_block"] = (np.floor(x.latitude).astype(int).astype(str) + "_" + np.floor(x.longitude).astype(int).astype(str))
    x = x[list(FEATURES)].sort_values(["acquisition_timestamp", "detection_id"]).reset_index(drop=True)

    out = cfg.gold / "ai" / manifest["run_id"]
    out.mkdir(parents=True, exist_ok=True)
    x.to_parquet(out / "model_input.parquet", index=False)
    (out / "model_input_schema.json").write_text(json.dumps({
        "grain": "one row per compared detection", "gold_run_id": manifest["run_id"],
        "matching_rule_version": cfg.pipeline["matching"]["rule_version"], "rows": len(x),
        "split_rule": {"train": f"year <= {train_until}", "validation": f"{train_until} < year <= {val_until}",
                       "test": f"year > {val_until}"},
        "split_counts": x.split.value_counts().to_dict(), "columns": FEATURES,
        "prediction_output_schema": PREDICTION_SCHEMA}, indent=1, default=str))
    return out


def _prior_cell_activity(det: pd.DataFrame, rows: pd.DataFrame, grid: float) -> np.ndarray:
    """Fire-days in the row's grid cell during the 12 months BEFORE the row's month (no future data)."""
    cell = lambda d: (np.floor(d.latitude / grid).astype(np.int64) * 100000 + np.floor(d.longitude / grid).astype(np.int64))
    mon = lambda ts: ts.dt.year * 12 + ts.dt.month - 1
    hist = pd.DataFrame({"cell": cell(det), "m": mon(det.local_solar_date), "d": det.local_solar_date})
    monthly = hist.groupby(["cell", "m"]).d.nunique()
    by_cell = {c: s.droplevel(0) for c, s in monthly.groupby(level=0)}
    rc, rm = cell(rows).to_numpy(), mon(rows.acquisition_timestamp).to_numpy()
    out = np.zeros(len(rows))
    for i, (c, m) in enumerate(zip(rc, rm)):
        s = by_cell.get(c)
        if s is not None:
            out[i] = s[(s.index >= m - 12) & (s.index < m)].sum()
    return out


def validate_predictions(pred: pd.DataFrame, model_input: pd.DataFrame) -> list[str]:
    """Return a list of problems (empty list = OK to store/load)."""
    problems = [f"missing column {c}" for c in PREDICTION_SCHEMA if c not in pred.columns]
    if problems:
        return problems
    if not pred.prediction_id.is_unique:
        problems.append("prediction_id is not unique")
    unknown = ~pred.input_record_id.isin(model_input.detection_id)
    if unknown.any():
        problems.append(f"{int(unknown.sum())} input_record_id values are not in the model input")
    if pred[["model_name", "model_version"]].isna().any().any():
        problems.append("model_name / model_version must be filled")
    if pd.to_numeric(pred.prediction_score, errors="coerce").isna().any():
        problems.append("prediction_score must be numeric")
    if pd.to_datetime(pred.inference_timestamp, errors="coerce", utc=True).isna().any():
        problems.append("inference_timestamp must be a valid timestamp")
    return problems
