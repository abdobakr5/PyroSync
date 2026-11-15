"""Step 6 - Spatial-temporal candidate matching between MODIS and VIIRS detections.

Definition used (rule version in config `matching.rule_version`, details in docs/matching_methodology.md):

* Candidate pair: a MODIS and a VIIRS detection whose pixel centres are within the spatial threshold
  (great-circle distance) AND whose acquisition times differ by at most the temporal threshold.
* Spatial threshold, mode 'footprint': footprint_factor x (half-diagonal of the MODIS pixel + half-diagonal
  of the VIIRS pixel), clipped to [min_threshold_m, max_threshold_m]. Mode 'fixed': fixed_threshold_m.
* Assignment: one MODIS pixel (~1 km or more) covers several VIIRS pixels (375 m), so a MODIS detection may be
  linked to many VIIRS detections, but each VIIRS detection is assigned to at most ONE MODIS detection:
  the nearest; ties broken by smaller time difference, then by the smaller MODIS detection_id.
  This is deterministic and never assigns one detection inconsistently.
* Status per detection (every detection in the comparison period appears in the output):
    matched                     VIIRS detection assigned to a MODIS detection (one row per pair)
    candidate_unassigned        MODIS detection with candidates, but each of them was assigned to a nearer MODIS
    modis_only / viirs_only     no candidate within the thresholds
  'modis_only' does NOT mean VIIRS missed a fire. `other_sensor_pass_evidence` tells whether the other sensor
  was observing the area at that time (it detected any fire within pass_evidence_radius_km and the time window).
* Candidate pairs (many-to-many) are kept in a separate table for audit.
"""
from __future__ import annotations

import hashlib
import logging

import numpy as np
import pandas as pd
from scipy.spatial import cKDTree

from src.geospatial.geometry import chord_for_distance, haversine_m, pixel_half_diagonal_m, to_unit_xyz

log = logging.getLogger(__name__)

PAIR_COLUMNS = ["modis_detection_id", "viirs_detection_id", "distance_m", "time_difference_seconds",
                "signed_time_difference_seconds", "spatial_threshold_m", "temporal_threshold_seconds"]
MATCH_COLUMNS = ["comparison_id", "modis_detection_id", "viirs_detection_id", "match_status", "distance_m",
                 "time_difference_seconds", "spatial_threshold_m", "temporal_threshold_seconds",
                 "n_candidates", "other_sensor_pass_evidence", "nearest_other_distance_m",
                 "matching_rule_version", "spatial_mode", "comparison_run_id"]


def _prep(df: pd.DataFrame) -> pd.DataFrame:
    if df.acquisition_timestamp.isna().any() or df.latitude.isna().any() or df.longitude.isna().any():
        raise ValueError("matching input must not contain missing timestamps or coordinates (Silver guarantees this)")
    out = df[["detection_id", "latitude", "longitude", "scan_km", "track_km", "acquisition_timestamp"]].copy()
    out["ts"] = (out.acquisition_timestamp - pd.Timestamp("1970-01-01", tz="UTC")) // pd.Timedelta(seconds=1)
    out["half_diag_m"] = pixel_half_diagonal_m(out.scan_km.fillna(0), out.track_km.fillna(0))
    return out.sort_values(["ts", "detection_id"]).reset_index(drop=True)


def spatial_threshold(hd_modis, hd_viirs, spatial_cfg: dict):
    if spatial_cfg["mode"] == "fixed":
        return np.full(np.shape(hd_modis), float(spatial_cfg["fixed_threshold_m"]))
    thr = spatial_cfg.get("footprint_factor", 1.0) * (np.asarray(hd_modis) + np.asarray(hd_viirs))
    return np.clip(thr, spatial_cfg["min_threshold_m"], spatial_cfg["max_threshold_m"])


def _max_spatial(spatial_cfg: dict) -> float:
    return float(spatial_cfg["fixed_threshold_m"] if spatial_cfg["mode"] == "fixed" else spatial_cfg["max_threshold_m"])


def _scan(anchor: pd.DataFrame, other: pd.DataFrame, temporal_s: int, radius_m: float, evidence_m: float,
          want_pairs: bool):
    """For each distinct acquisition time of `anchor`, index the `other` detections within +/- temporal_s and
    (a) collect all pairs within radius_m, (b) find the nearest other detection (pass evidence)."""
    pairs_a, pairs_o = [], []
    nearest = np.full(len(anchor), np.inf)
    if len(other) == 0 or len(anchor) == 0:
        return np.array([], int), np.array([], int), nearest
    o_ts = other.ts.to_numpy()
    o_xyz = to_unit_xyz(other.latitude, other.longitude)
    a_xyz = to_unit_xyz(anchor.latitude, anchor.longitude)
    r_chord = chord_for_distance(radius_m)
    for t, idx in anchor.groupby("ts").indices.items():
        lo, hi = np.searchsorted(o_ts, t - temporal_s, "left"), np.searchsorted(o_ts, t + temporal_s, "right")
        if hi <= lo:
            continue
        tree = cKDTree(o_xyz[lo:hi])
        d, _ = tree.query(a_xyz[idx], k=1)
        nearest[idx] = 2 * 6_371_008.8 * np.arcsin(np.clip(d / 2, 0, 1))
        if want_pairs:
            hits = tree.query_ball_point(a_xyz[idx], r_chord)
            for ai, h in zip(idx, hits):
                if h:
                    pairs_a.extend([ai] * len(h))
                    pairs_o.extend(lo + np.asarray(h))
    return np.asarray(pairs_a, int), np.asarray(pairs_o, int), nearest


def candidate_pairs(modis: pd.DataFrame, viirs: pd.DataFrame, spatial_cfg: dict, temporal_s: int,
                    evidence_m: float = 1_000_000.0):
    """Return (pairs DataFrame, prepared modis, prepared viirs). Inputs are Silver rows."""
    m, v = _prep(modis), _prep(viirs)
    ai, oi, m_near = _scan(m, v, temporal_s, _max_spatial(spatial_cfg), evidence_m, True)
    _, _, v_near = _scan(v, m, temporal_s, 0, evidence_m, False)
    m["nearest_other_m"], v["nearest_other_m"] = m_near, v_near
    if len(ai) == 0:
        return pd.DataFrame(columns=PAIR_COLUMNS), m, v
    dist = haversine_m(m.latitude.to_numpy()[ai], m.longitude.to_numpy()[ai],
                       v.latitude.to_numpy()[oi], v.longitude.to_numpy()[oi])
    sdt = v.ts.to_numpy()[oi] - m.ts.to_numpy()[ai]
    thr = spatial_threshold(m.half_diag_m.to_numpy()[ai], v.half_diag_m.to_numpy()[oi], spatial_cfg)
    keep = (dist <= thr) & (np.abs(sdt) <= temporal_s)
    pairs = pd.DataFrame({
        "modis_detection_id": m.detection_id.to_numpy()[ai][keep], "viirs_detection_id": v.detection_id.to_numpy()[oi][keep],
        "distance_m": np.round(dist[keep], 1), "time_difference_seconds": np.abs(sdt[keep]).astype(np.int64),
        "signed_time_difference_seconds": sdt[keep].astype(np.int64), "spatial_threshold_m": np.round(thr[keep], 1),
        "temporal_threshold_seconds": temporal_s})
    return pairs, m, v


def assign(pairs: pd.DataFrame) -> pd.DataFrame:
    """Each VIIRS detection -> its single best MODIS candidate (nearest, then smallest |dt|, then smallest id)."""
    if pairs.empty:
        return pairs.copy()
    s = pairs.sort_values(["viirs_detection_id", "distance_m", "time_difference_seconds", "modis_detection_id"])
    return s.drop_duplicates("viirs_detection_id", keep="first").reset_index(drop=True)


def _cid(a: pd.Series, b: pd.Series, rule: str) -> list[str]:
    return [hashlib.sha1(f"{x}|{y}|{rule}".encode()).hexdigest()[:20] for x, y in zip(a.fillna(""), b.fillna(""))]


def match(modis: pd.DataFrame, viirs: pd.DataFrame, mcfg: dict, run_id: str) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Returns (detection_matches, candidate_pairs)."""
    T = int(mcfg["temporal_threshold_seconds"])
    R = float(mcfg["pass_evidence_radius_km"]) * 1000
    rule = mcfg["rule_version"]
    pairs, m, v = candidate_pairs(modis, viirs, mcfg["spatial"], T, R)
    best = assign(pairs)
    n_cand_m = pairs.groupby("modis_detection_id").size()

    matched = best.assign(match_status="matched")
    has_cand = m.detection_id.isin(pairs.modis_detection_id)
    assigned_m = m.detection_id.isin(best.modis_detection_id)
    unassigned = m[has_cand & ~assigned_m]
    m_only = m[~has_cand]
    v_only = v[~v.detection_id.isin(pairs.viirs_detection_id)]

    rows = [
        matched[["modis_detection_id", "viirs_detection_id", "match_status", "distance_m", "time_difference_seconds",
                 "spatial_threshold_m"]],
        pd.DataFrame({"modis_detection_id": unassigned.detection_id, "match_status": "candidate_unassigned",
                      "nearest_other_distance_m": unassigned.nearest_other_m.round(1)}),
        pd.DataFrame({"modis_detection_id": m_only.detection_id, "match_status": "modis_only",
                      "other_sensor_pass_evidence": m_only.nearest_other_m <= R,
                      "nearest_other_distance_m": m_only.nearest_other_m.replace(np.inf, np.nan).round(1)}),
        pd.DataFrame({"viirs_detection_id": v_only.detection_id, "match_status": "viirs_only",
                      "other_sensor_pass_evidence": v_only.nearest_other_m <= R,
                      "nearest_other_distance_m": v_only.nearest_other_m.replace(np.inf, np.nan).round(1)}),
    ]
    out = pd.concat([r for r in rows if len(r)], ignore_index=True)
    for c in MATCH_COLUMNS:
        if c not in out.columns:
            out[c] = pd.NA
    out["n_candidates"] = out.modis_detection_id.map(n_cand_m).fillna(0).astype("int64")
    out.loc[out.match_status == "matched", "other_sensor_pass_evidence"] = True
    out["temporal_threshold_seconds"] = T
    out["matching_rule_version"] = rule
    out["spatial_mode"] = mcfg["spatial"]["mode"]
    out["comparison_run_id"] = run_id
    out["comparison_id"] = _cid(out.modis_detection_id, out.viirs_detection_id, rule)
    log.info("matching: %s", out.match_status.value_counts().to_dict())
    return out[MATCH_COLUMNS], pairs


def sensitivity(modis: pd.DataFrame, viirs: pd.DataFrame, spatial_m: list[float], temporal_s: list[int]) -> pd.DataFrame:
    """Share of MODIS / VIIRS detections that have at least one candidate, for a grid of fixed thresholds."""
    big = {"mode": "fixed", "fixed_threshold_m": max(spatial_m)}
    pairs, m, v = candidate_pairs(modis, viirs, big, int(max(temporal_s)))
    rows = []
    for s in spatial_m:
        for t in temporal_s:
            p = pairs[(pairs.distance_m <= s) & (pairs.time_difference_seconds <= t)]
            rows.append({"spatial_threshold_m": s, "temporal_threshold_seconds": t, "candidate_pairs": len(p),
                         "modis_with_candidate_pct": round(100 * p.modis_detection_id.nunique() / max(len(m), 1), 2),
                         "viirs_with_candidate_pct": round(100 * p.viirs_detection_id.nunique() / max(len(v), 1), 2),
                         "median_distance_m": float(p.distance_m.median()) if len(p) else np.nan})
    return pd.DataFrame(rows)
