"""
PyroSync — Gold Detection-Level Harmonization & AI Feature Store Processor
==========================================================================
Processes the 6 Gold Layer artifacts in `data/gold_detection_level_and_ai/`:
  1. candidate_pairs.parquet           (158,247 spatial-temporal candidate links)
  2. detection_matches.parquet         (612,576 matched / unassigned / single-sensor records)
  3. gold_detection_comparison.parquet (612,576 cross-sensor FRP, confidence, distance & time metrics)
  4. gold_regional_fire_trends.parquet (437,865 cell-month x instrument x satellite records)
  5. model_input.parquet               (645,655 ML feature store rows: train <= 2019, val 2020-2021)
  6. model_input_schema.json           (Schema & split definitions for match-1.1.0)

Outputs:
  - data/gold_detection_insights.json
  - frontend/public/data/gold_detection_insights.json
"""

import json
import os
import numpy as np
import pandas as pd

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GOLD_DIR = os.path.join(BASE_DIR, "data", "gold_detection_level_and_ai")
GOLD_CAL_DIR = os.path.join(BASE_DIR, "data", "gold_calendar_maps_and_stats")
OUT_DATA = os.path.join(BASE_DIR, "data", "gold_detection_insights.json")
OUT_PUBLIC = os.path.join(BASE_DIR, "frontend", "public", "data", "gold_detection_insights.json")


def build_gold_detection_insights():
    print("Loading Gold Detection-Level & AI Parquet files...")
    with open(os.path.join(GOLD_DIR, "model_input_schema.json"), "r", encoding="utf-8") as f:
        schema = json.load(f)

    candidates = pd.read_parquet(os.path.join(GOLD_DIR, "candidate_pairs.parquet"))
    comp = pd.read_parquet(os.path.join(GOLD_DIR, "gold_detection_comparison.parquet"))
    trends = pd.read_parquet(os.path.join(GOLD_DIR, "gold_regional_fire_trends.parquet"))
    model_in = pd.read_parquet(os.path.join(GOLD_DIR, "model_input.parquet"))

    comp["year"] = pd.to_datetime(comp["acquisition_date"]).dt.year
    matched = comp[comp["match_status"] == "matched"]

    # 1. Global Summary
    status_counts = comp["match_status"].value_counts().to_dict()
    total_compared = int(len(comp))

    global_summary = {
        "gold_run_id": schema.get("gold_run_id", "gold_20261113T013051Z_6b529f"),
        "matching_rule_version": schema.get("matching_rule_version", "match-1.1.0"),
        "spatial_mode": str(comp["spatial_mode"].iloc[0]),
        "temporal_threshold_seconds": int(comp["temporal_threshold_seconds"].iloc[0]),
        "candidate_pairs_count": int(len(candidates)),
        "total_compared_records": total_compared,
        "model_input_rows": int(len(model_in)),
        "regional_trends_rows": int(len(trends)),
        "match_status_counts": {k: int(v) for k, v in status_counts.items()},
        "match_status_pct": {
            k: round(float(v) * 100.0 / total_compared, 2) for k, v in status_counts.items()
        },
        "distance_m_stats": {
            "mean": round(float(matched["distance_m"].mean()), 1),
            "median": round(float(matched["distance_m"].median()), 1),
            "p25": round(float(matched["distance_m"].quantile(0.25)), 1),
            "p75": round(float(matched["distance_m"].quantile(0.75)), 1),
            "max": round(float(matched["distance_m"].max()), 1),
        },
        "spatial_threshold_m_stats": {
            "mean": round(float(matched["spatial_threshold_m"].mean()), 1),
            "median": round(float(matched["spatial_threshold_m"].median()), 1),
            "min": round(float(matched["spatial_threshold_m"].min()), 1),
            "max": round(float(matched["spatial_threshold_m"].max()), 1),
        },
        "time_diff_minutes_stats": {
            "mean": round(float(matched["time_difference_seconds"].mean() / 60.0), 1),
            "median": round(float(matched["time_difference_seconds"].median() / 60.0), 1),
            "p25": round(float(matched["time_difference_seconds"].quantile(0.25) / 60.0), 1),
            "p75": round(float(matched["time_difference_seconds"].quantile(0.75) / 60.0), 1),
        },
        "matched_frp_comparison": {
            "modis_mean_mw": round(float(matched["modis_frp_mw"].mean()), 2),
            "viirs_mean_mw": round(float(matched["viirs_frp_mw"].mean()), 2),
            "modis_median_mw": round(float(matched["modis_frp_mw"].median()), 2),
            "viirs_median_mw": round(float(matched["viirs_frp_mw"].median()), 2),
            "modis_total_gw": round(float(matched["modis_frp_mw"].sum() / 1000.0), 2),
            "viirs_total_gw": round(float(matched["viirs_frp_mw"].sum() / 1000.0), 2),
        },
    }

    # 2. Distance Histogram & Time Difference Histogram for Matched Pairs
    dist_bins = [0, 250, 500, 750, 1000, 1250, 1500, 2000, 3500]
    dist_labels = ["0-250m", "250-500m", "500-750m", "750-1000m", "1.0-1.25km", "1.25-1.5km", "1.5-2.0km", ">2.0km"]
    dist_hist_counts = pd.cut(matched["distance_m"], bins=dist_bins, labels=dist_labels).value_counts(sort=False)
    distance_histogram = [
        {"bin": str(label), "count": int(dist_hist_counts[label])} for label in dist_labels
    ]

    time_bins = [-1, 600, 1200, 1800, 2400, 3000, 3600]
    time_labels = ["0-10m", "10-20m", "20-30m", "30-40m", "40-50m", "50-60m"]
    time_hist_counts = pd.cut(matched["time_difference_seconds"], bins=time_bins, labels=time_labels).value_counts(sort=False)
    time_histogram = [
        {"bin": str(label), "count": int(time_hist_counts[label])} for label in time_labels
    ]

    # 3. Regional Breakdown (per country + Eastern Med All)
    regions_data = {}

    def summarize_region(df_sub, trends_sub, mi_sub):
        sc = df_sub["match_status"].value_counts().to_dict()
        tot = max(1, len(df_sub))
        m_sub = df_sub[df_sub["match_status"] == "matched"]

        # Yearly match_status breakdown (2012-2021)
        yearly_ct = pd.crosstab(df_sub["year"], df_sub["match_status"])
        yearly_list = []
        for yr in sorted(yearly_ct.index):
            row = yearly_ct.loc[yr]
            yearly_list.append({
                "year": int(yr),
                "matched": int(row.get("matched", 0)),
                "viirs_only": int(row.get("viirs_only", 0)),
                "modis_only": int(row.get("modis_only", 0)),
                "candidate_unassigned": int(row.get("candidate_unassigned", 0)),
            })

        # Satellite breakdown from gold_regional_fire_trends
        sat_grp = trends_sub.groupby(["instrument", "satellite"])[
            ["detection_count", "fire_days", "frp_sum_mw", "compared_count", "matched_count", "unmatched_count"]
        ].sum().reset_index()
        satellites = []
        for _, srow in sat_grp.iterrows():
            satellites.append({
                "instrument": str(srow["instrument"]),
                "satellite": str(srow["satellite"]),
                "detection_count": int(srow["detection_count"]),
                "fire_days": int(srow["fire_days"]),
                "frp_sum_gw": round(float(srow["frp_sum_mw"]) / 1000.0, 2),
                "compared_count": int(srow["compared_count"]),
                "matched_count": int(srow["matched_count"]),
                "unmatched_count": int(srow["unmatched_count"]),
            })

        # Sample real matched pairs for table inspection
        top_matches = m_sub.sort_values("modis_frp_mw", ascending=False).head(8)
        sample_pairs = []
        for _, mrow in top_matches.iterrows():
            sample_pairs.append({
                "comparison_id": str(mrow["comparison_id"])[:10],
                "date": str(mrow["acquisition_date"])[:10],
                "region": str(mrow["region"]),
                "lat": round(float(mrow["latitude"]), 4),
                "lon": round(float(mrow["longitude"]), 4),
                "distance_m": round(float(mrow["distance_m"]), 1),
                "spatial_threshold_m": round(float(mrow["spatial_threshold_m"]), 1),
                "time_diff_min": round(float(mrow["time_difference_seconds"]) / 60.0, 1),
                "modis_frp_mw": round(float(mrow["modis_frp_mw"]), 1),
                "viirs_frp_mw": round(float(mrow["viirs_frp_mw"]), 1),
                "n_candidates": int(mrow["n_candidates"]),
            })

        return {
            "total_compared": int(len(df_sub)),
            "matched": int(sc.get("matched", 0)),
            "viirs_only": int(sc.get("viirs_only", 0)),
            "modis_only": int(sc.get("modis_only", 0)),
            "candidate_unassigned": int(sc.get("candidate_unassigned", 0)),
            "matched_pct": round(float(sc.get("matched", 0)) * 100.0 / tot, 2),
            "viirs_only_pct": round(float(sc.get("viirs_only", 0)) * 100.0 / tot, 2),
            "modis_only_pct": round(float(sc.get("modis_only", 0)) * 100.0 / tot, 2),
            "mean_distance_m": round(float(m_sub["distance_m"].mean()), 1) if len(m_sub) else 0.0,
            "mean_threshold_m": round(float(m_sub["spatial_threshold_m"].mean()), 1) if len(m_sub) else 0.0,
            "mean_time_diff_min": round(float(m_sub["time_difference_seconds"].mean() / 60.0), 1) if len(m_sub) else 0.0,
            "modis_matched_frp_mean": round(float(m_sub["modis_frp_mw"].mean()), 1) if len(m_sub) else 0.0,
            "viirs_matched_frp_mean": round(float(m_sub["viirs_frp_mw"].mean()), 1) if len(m_sub) else 0.0,
            "yearly_matches": yearly_list,
            "satellites": satellites,
            "top_matched_pairs": sample_pairs,
        }

    regions_data["Eastern Med (All)"] = summarize_region(comp, trends, model_in)
    for reg in sorted(comp["region"].unique()):
        regions_data[str(reg)] = summarize_region(
            comp[comp["region"] == reg],
            trends[trends["region"] == reg],
            model_in[model_in["region"] == reg],
        )

    # 4. AI / ML Feature Store Profile (from model_input.parquet + model_input_schema.json)
    feature_cols = [
        "frp_mw",
        "brightness_mir_k",
        "brightness_tir_k",
        "brightness_difference_k",
        "scan_km",
        "track_km",
        "pixel_area_km2",
        "n_candidates",
        "other_sensor_distance_m",
        "cell_fire_days_prior_12m",
    ]
    feature_profiles = {}
    for status, grp in model_in.groupby("match_status"):
        prof = {
            "count": int(len(grp)),
            "day_pct": round(float((grp["daynight"] == "D").mean() * 100.0), 1),
            "other_sensor_pass_pct": round(float(grp["other_sensor_pass_evidence"].dropna().mean() * 100.0), 1)
            if grp["other_sensor_pass_evidence"].notna().any()
            else 0.0,
        }
        for col in feature_cols:
            val = grp[col].dropna().mean()
            prof[col] = round(float(val), 2) if pd.notna(val) else None
        feature_profiles[str(status)] = prof

    # 5. Spatial Resolution of the Satellite Proof (MODIS vs VIIRS Footprint Geometry)
    spatial_resolution_proof = {}
    for inst, grp in model_in.groupby("instrument"):
        spatial_resolution_proof[str(inst)] = {
            "count": int(len(grp)),
            "scan_km": {
                "min": round(float(grp["scan_km"].min()), 3),
                "median": round(float(grp["scan_km"].median()), 3),
                "mean": round(float(grp["scan_km"].mean()), 3),
                "p95": round(float(grp["scan_km"].quantile(0.95)), 3),
                "max": round(float(grp["scan_km"].max()), 3),
            },
            "track_km": {
                "min": round(float(grp["track_km"].min()), 3),
                "median": round(float(grp["track_km"].median()), 3),
                "mean": round(float(grp["track_km"].mean()), 3),
                "p95": round(float(grp["track_km"].quantile(0.95)), 3),
                "max": round(float(grp["track_km"].max()), 3),
            },
            "pixel_area_km2": {
                "min": round(float(grp["pixel_area_km2"].min()), 3),
                "median": round(float(grp["pixel_area_km2"].median()), 3),
                "mean": round(float(grp["pixel_area_km2"].mean()), 3),
                "p95": round(float(grp["pixel_area_km2"].quantile(0.95)), 3),
                "max": round(float(grp["pixel_area_km2"].max()), 3),
            },
        }

    # 6. Audit & Calibration Validation (from gold_calendar_maps_and_stats/)
    audit_and_validation = {}
    manifest_path = os.path.join(GOLD_CAL_DIR, "manifest.json")
    recon_path = os.path.join(GOLD_CAL_DIR, "reconciliation.json")
    val_path = os.path.join(GOLD_CAL_DIR, "calendar", "validation.csv")
    if os.path.exists(manifest_path) and os.path.exists(recon_path):
        with open(manifest_path, "r", encoding="utf-8") as f:
            manifest = json.load(f)
        with open(recon_path, "r", encoding="utf-8") as f:
            recon = json.load(f)
        val_rows = pd.read_csv(val_path).to_dict(orient="records") if os.path.exists(val_path) else []
        audit_and_validation = {
            "run_id": manifest.get("run_id"),
            "silver_detections": manifest.get("silver_detections"),
            "analysis_detections": manifest.get("analysis_detections"),
            "calendar_days": manifest.get("calendar", {}).get("calendar_days"),
            "grid_rows": manifest.get("calendar", {}).get("grid_rows"),
            "reconciliation_passed": bool(manifest.get("reconciliation_passed", False)),
            "reconciliation_checks_passed": sum(1 for v in recon.values() if v is True),
            "reconciliation_checks_total": len(recon),
            "validation_metrics": val_rows,
        }

    payload = {
        "schema": schema,
        "global_summary": global_summary,
        "spatial_resolution_proof": spatial_resolution_proof,
        "audit_and_validation": audit_and_validation,
        "distance_histogram": distance_histogram,
        "time_histogram": time_histogram,
        "feature_profiles": feature_profiles,
        "regions": regions_data,
    }

    os.makedirs(os.path.dirname(OUT_DATA), exist_ok=True)
    os.makedirs(os.path.dirname(OUT_PUBLIC), exist_ok=True)

    with open(OUT_DATA, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
    with open(OUT_PUBLIC, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)

    print(f"Saved Gold Detection Insights to:\n  - {OUT_DATA}\n  - {OUT_PUBLIC}")


if __name__ == "__main__":
    build_gold_detection_insights()
