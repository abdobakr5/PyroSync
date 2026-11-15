"""Step 7 - Build the Gold analytical datasets from Silver.

Outputs (data/gold/current/, grain = what one row is):
  detection_matches.parquet          one row per matched pair / unmatched detection (Step 6 output)
  candidate_pairs.parquet            one row per MODIS-VIIRS pair within the thresholds (audit table)
  gold_detection_comparison.parquet  detection_matches + date, region, confidences of both detections
  gold_hotspot_statistics.csv        one row per region x month (comparison period only)
  gold_regional_fire_trends.parquet  one row per grid cell x month x instrument x satellite
  matching_sensitivity.csv           one row per (spatial, temporal) threshold pair
  calendar/                          harmonized fire calendar + map layers (harmonized_calendar.py)
  reconciliation.json                checks that Gold totals agree with Silver
  manifest.json                      run id, config used, row counts

Publication is atomic: everything is written to data/gold/_staging/<run_id>/ first; only when all
reconciliation checks pass is it moved to data/gold/current (the old version moves to data/gold/previous).
"""
from __future__ import annotations

import json
import logging
import shutil
from pathlib import Path

import numpy as np
import pandas as pd

from src.analytics.harmonized_calendar import build_calendar, silver_to_legacy
from src.common.config import Config
from src.common.runlog import new_run_id, utc_now
from src.geospatial.geometry import cell_index
from src.geospatial.matching import match, sensitivity
from src.transformation.flags import analysis_mask
from src.transformation.silver import read_silver

log = logging.getLogger(__name__)


class ReconciliationError(RuntimeError):
    pass


def comparison_inputs(det: pd.DataFrame, cfg: Config) -> tuple[pd.DataFrame, pd.DataFrame, pd.Timestamp, pd.Timestamp]:
    mc = cfg.pipeline["matching"]
    keep = analysis_mask(det, mc["vegetation_only"], mc["exclude_static_sources"],
                         cfg.pipeline["flags"]["static_days_per_year"], mc.get("exclude_low_confidence", False))
    d = det[keep]
    modis = d[(d.source_instrument == "MODIS") & d.satellite.isin(mc["modis_satellites"])]
    viirs = d[(d.source_instrument == "VIIRS") & d.satellite.isin(mc["viirs_satellites"])]
    if modis.empty or viirs.empty:
        return modis.iloc[0:0], viirs.iloc[0:0], pd.NaT, pd.NaT
    # compare only where both sensors were delivering data (full UTC days)
    start = max(modis.acquisition_timestamp.min(), viirs.acquisition_timestamp.min()).normalize()
    end = min(modis.acquisition_timestamp.max(), viirs.acquisition_timestamp.max()).normalize() + pd.Timedelta(days=1)
    inside = lambda x: x[(x.acquisition_timestamp >= start) & (x.acquisition_timestamp < end)]
    return inside(modis), inside(viirs), start, end


def detection_comparison(matches: pd.DataFrame, modis: pd.DataFrame, viirs: pd.DataFrame) -> pd.DataFrame:
    m = modis.set_index("detection_id")
    v = viirs.set_index("detection_id")
    out = matches.copy()
    mt = out.modis_detection_id.map(m.acquisition_timestamp)
    vt = out.viirs_detection_id.map(v.acquisition_timestamp)
    out["acquisition_date"] = mt.fillna(vt).dt.tz_convert(None).dt.normalize()
    out["year_month"] = out.acquisition_date.dt.strftime("%Y-%m")
    out["region"] = out.modis_detection_id.map(m.region).fillna(out.viirs_detection_id.map(v.region))
    out["modis_confidence_raw"] = out.modis_detection_id.map(m.confidence_raw)
    out["modis_confidence_class"] = out.modis_detection_id.map(m.confidence_class)
    out["viirs_confidence_raw"] = out.viirs_detection_id.map(v.confidence_raw)
    out["viirs_confidence_class"] = out.viirs_detection_id.map(v.confidence_class)
    out["modis_frp_mw"] = out.modis_detection_id.map(m.frp_mw)
    out["viirs_frp_mw"] = out.viirs_detection_id.map(v.frp_mw)
    out["latitude"] = out.modis_detection_id.map(m.latitude).fillna(out.viirs_detection_id.map(v.latitude))
    out["longitude"] = out.modis_detection_id.map(m.longitude).fillna(out.viirs_detection_id.map(v.longitude))
    return out


def hotspot_statistics(cmp: pd.DataFrame, modis: pd.DataFrame, viirs: pd.DataFrame) -> pd.DataFrame:
    """Grain: region x year_month. Denominators are stated in the column names."""
    def ym(df):
        return df.acquisition_timestamp.dt.tz_convert(None).dt.strftime("%Y-%m")
    keys = ["region", "year_month"]
    base = pd.concat([
        modis.assign(year_month=ym(modis)).groupby(keys).size().rename("modis_detections"),
        viirs.assign(year_month=ym(viirs)).groupby(keys).size().rename("viirs_detections")], axis=1).fillna(0)
    # region/month of a detection = its own region/month (a pair can cross a border; each side counts where it is)
    mreg = modis.set_index("detection_id")[["region"]].assign(year_month=ym(modis).values)
    vreg = viirs.set_index("detection_id")[["region"]].assign(year_month=ym(viirs).values)
    mstat = cmp.dropna(subset=["modis_detection_id"]).drop_duplicates("modis_detection_id")
    mstat = mstat.assign(**{k: mstat.modis_detection_id.map(mreg[k]) for k in keys})
    vstat = cmp.dropna(subset=["viirs_detection_id"])
    vstat = vstat.assign(**{k: vstat.viirs_detection_id.map(vreg[k]) for k in keys})
    m_has = mstat.match_status.isin(["matched", "candidate_unassigned"])
    pairs = cmp[cmp.match_status == "matched"]
    pairs = pairs.assign(**{k: pairs.viirs_detection_id.map(vreg[k]) for k in keys})
    agg = pd.concat([
        mstat[m_has].groupby(keys).size().rename("modis_with_candidate"),
        mstat[mstat.match_status == "modis_only"].groupby(keys).size().rename("modis_only"),
        mstat[(mstat.match_status == "modis_only") & (mstat.other_sensor_pass_evidence == True)].groupby(keys).size()  # noqa: E712
            .rename("modis_only_with_viirs_pass"),
        vstat[vstat.match_status == "matched"].groupby(keys).size().rename("viirs_matched"),
        vstat[vstat.match_status == "viirs_only"].groupby(keys).size().rename("viirs_only"),
        vstat[(vstat.match_status == "viirs_only") & (vstat.other_sensor_pass_evidence == True)].groupby(keys).size()  # noqa: E712
            .rename("viirs_only_with_modis_pass"),
        pairs.groupby(keys).size().rename("matched_pairs"),
        pairs.groupby(keys).distance_m.mean().rename("mean_pair_distance_m"),
        pairs.groupby(keys).time_difference_seconds.median().rename("median_pair_time_difference_s"),
        pairs.groupby(keys).time_difference_seconds.quantile(0.9).rename("p90_pair_time_difference_s"),
    ], axis=1)
    st = base.join(agg, how="outer")
    count_cols = [c for c in st.columns if c not in ("mean_pair_distance_m", "median_pair_time_difference_s",
                                                     "p90_pair_time_difference_s")]
    st[count_cols] = st[count_cols].fillna(0).astype("int64")
    st["modis_match_rate_pct"] = (100 * st.modis_with_candidate / st.modis_detections.replace(0, np.nan)).round(2)
    st["viirs_match_rate_pct"] = (100 * st.viirs_matched / st.viirs_detections.replace(0, np.nan)).round(2)
    for cls in ["low", "nominal", "high"]:
        st[f"modis_conf_{cls}"] = modis[modis.confidence_class == cls].assign(year_month=ym).groupby(keys).size()
        st[f"viirs_conf_{cls}"] = viirs[viirs.confidence_class == cls].assign(year_month=ym).groupby(keys).size()
    conf_cols = [c for c in st.columns if "_conf_" in c]
    st[conf_cols] = st[conf_cols].fillna(0).astype("int64")
    return st.reset_index()


def regional_trends(det: pd.DataFrame, cmp: pd.DataFrame, grid_deg: float) -> pd.DataFrame:
    """Grain: grid cell x month x instrument x satellite, all analysis detections (not only the comparison pair)."""
    i, j, clat, clon = cell_index(det.latitude, det.longitude, grid_deg)
    status = pd.concat([cmp.dropna(subset=["modis_detection_id"]).drop_duplicates("modis_detection_id")
                        .set_index("modis_detection_id").match_status,
                        cmp.dropna(subset=["viirs_detection_id"]).set_index("viirs_detection_id").match_status])
    st = det.detection_id.map(status)
    d = pd.DataFrame({"cell_id": pd.Series(i).astype(str).values + "_" + pd.Series(j).astype(str).values,
                      "cell_lat": clat, "cell_lon": clon, "region": det.region.values,
                      "year_month": det.local_solar_date.dt.strftime("%Y-%m").values,
                      "instrument": det.source_instrument.values, "satellite": det.satellite.values,
                      "local_date": det.local_solar_date.values, "frp_mw": det.frp_mw.values,
                      "compared": st.notna().values,
                      "matched": st.isin(["matched", "candidate_unassigned"]).values})
    g = d.groupby(["cell_id", "cell_lat", "cell_lon", "region", "year_month", "instrument", "satellite"])
    out = g.agg(detection_count=("frp_mw", "size"), fire_days=("local_date", "nunique"), frp_sum_mw=("frp_mw", "sum"),
                compared_count=("compared", "sum"), matched_count=("matched", "sum")).reset_index()
    out["unmatched_count"] = out.compared_count - out.matched_count
    out["frp_sum_mw"] = out.frp_sum_mw.round(2)
    return out


def reconcile(det_analysis, modis, viirs, matches, stats, trends) -> dict:
    checks = {}
    mm = matches.dropna(subset=["modis_detection_id"])
    vv = matches.dropna(subset=["viirs_detection_id"])
    checks["every_compared_modis_in_output"] = set(modis.detection_id) == set(mm.modis_detection_id)
    checks["every_compared_viirs_in_output"] = set(viirs.detection_id) == set(vv.viirs_detection_id)
    checks["each_viirs_exactly_once"] = bool(vv.viirs_detection_id.is_unique)
    non_pair = mm[mm.match_status != "matched"]
    checks["unmatched_modis_exactly_once"] = bool(non_pair.modis_detection_id.is_unique)
    checks["stats_modis_total"] = int(stats.modis_detections.sum()) == len(modis)
    checks["stats_viirs_total"] = int(stats.viirs_detections.sum()) == len(viirs)
    checks["stats_viirs_partition"] = int((stats.viirs_matched + stats.viirs_only).sum()) == len(viirs)
    checks["stats_modis_partition"] = int((stats.modis_with_candidate + stats.modis_only).sum()) == len(modis)
    checks["trends_total"] = int(trends.detection_count.sum()) == len(det_analysis)
    checks["trends_compared"] = int(trends.compared_count.sum()) == len(modis) + len(viirs)
    return checks


def run_gold(cfg: Config, run_id: str | None = None) -> dict:
    run_id = run_id or new_run_id("gold")
    stage = cfg.gold / "_staging" / run_id
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir(parents=True)
    det = read_silver(cfg)
    if det.empty:
        raise RuntimeError("Silver is empty - run ingestion and silver first")
    mc, gc = cfg.pipeline["matching"], cfg.pipeline["gold"]

    # Step 6: matching (comparison pair, comparison period)
    modis, viirs, c_start, c_end = comparison_inputs(det, cfg)
    matches, pairs = match(modis, viirs, mc, run_id)
    matches.to_parquet(stage / "detection_matches.parquet", index=False)
    pairs.to_parquet(stage / "candidate_pairs.parquet", index=False)
    sens = sensitivity(modis, viirs, mc["sensitivity"]["spatial_m"], mc["sensitivity"]["temporal_s"])
    sens.to_csv(stage / "matching_sensitivity.csv", index=False)

    # Step 7: Gold tables
    cmp = detection_comparison(matches, modis, viirs)
    cmp.to_parquet(stage / "gold_detection_comparison.parquet", index=False)
    stats = hotspot_statistics(cmp, modis, viirs)
    stats.to_csv(stage / "gold_hotspot_statistics.csv", index=False)
    keep = analysis_mask(det, mc["vegetation_only"], mc["exclude_static_sources"],
                         cfg.pipeline["flags"]["static_days_per_year"], mc.get("exclude_low_confidence", False))
    det_analysis = det[keep]
    trends = regional_trends(det_analysis, matches, gc["grid_deg"])
    trends.to_parquet(stage / "gold_regional_fire_trends.parquet", index=False)

    # harmonized calendar + map layers (the challenge deliverable)
    cc = gc["calendar"]
    cal_summary = build_calendar(silver_to_legacy(det), stage / "calendar", gc["grid_deg"], cc["start"],
                                 tuple(cc["overlap"]), cc["viirs_satellites"], cfg.pipeline["flags"]["static_days_per_year"],
                                 cc["min_modis"], cc["keep_low_conf"], cc["smooth_days"], cc["season_window"],
                                 cc["min_active"])

    checks = reconcile(det_analysis, modis, viirs, matches, stats, trends)
    (stage / "reconciliation.json").write_text(json.dumps(checks, indent=1))
    manifest = {"run_id": run_id, "created_at": utc_now(), "silver_detections": len(det),
                "analysis_detections": len(det_analysis),
                "comparison_period": [str(c_start), str(c_end)], "compared_modis": len(modis), "compared_viirs": len(viirs),
                "match_status_counts": matches.match_status.value_counts().to_dict(),
                "matching_config": mc, "calendar": cal_summary, "reconciliation_passed": all(checks.values())}
    (stage / "manifest.json").write_text(json.dumps(manifest, indent=1, default=str))
    if not all(checks.values()):
        raise ReconciliationError(f"Gold not published, failed checks: {[k for k, v in checks.items() if not v]}")
    _publish(cfg.gold, stage)
    return manifest


def _publish(gold: Path, stage: Path) -> None:
    """Swap staging -> current. If anything fails before this point, the old 'current' is untouched."""
    current, previous = gold / "current", gold / "previous"
    if previous.exists():
        shutil.rmtree(previous)
    if current.exists():
        current.rename(previous)
    stage.rename(current)
