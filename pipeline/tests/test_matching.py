"""Steps 5-6 tests: distances, thresholds, boundary cases, deterministic assignment, pass evidence."""
import numpy as np
import pandas as pd
import pytest

from src.geospatial.geometry import (chord_for_distance, haversine_m, pixel_half_diagonal_m, to_unit_xyz)
from src.geospatial.matching import match, sensitivity

CFG = {"rule_version": "test-1", "temporal_threshold_seconds": 1200, "pass_evidence_radius_km": 1000,
       "spatial": {"mode": "fixed", "fixed_threshold_m": 1500, "footprint_factor": 1.0,
                   "min_threshold_m": 750, "max_threshold_m": 5000}}
M_PER_DEG_LAT = 111_195.08


def det(did, lat, lon, ts, scan=1.0, track=1.0):
    return {"detection_id": did, "latitude": lat, "longitude": lon, "scan_km": scan, "track_km": track,
            "acquisition_timestamp": pd.Timestamp(ts, tz="UTC")}


def frame(*rows):
    return pd.DataFrame(list(rows))


def run(modis, viirs, cfg=CFG):
    out, pairs = match(frame(*modis), frame(*viirs), cfg, "run1")
    return out, pairs


# ---------- geometry ----------
def test_haversine_known_values():
    assert haversine_m(0, 0, 0, 1) == pytest.approx(111_195.08, abs=1)
    assert haversine_m(30, 31, 31, 31) == pytest.approx(M_PER_DEG_LAT, abs=1)
    assert haversine_m(30, 31, 30, 31) == 0
    a = haversine_m(30.0444, 31.2357, 31.2001, 29.9187)               # Cairo -> Alexandria
    la1, lo1, la2, lo2 = np.radians([30.0444, 31.2357, 31.2001, 29.9187])
    cos_law = 6_371_008.8 * np.arccos(np.sin(la1) * np.sin(la2) + np.cos(la1) * np.cos(la2) * np.cos(lo2 - lo1))
    assert a == pytest.approx(cos_law, rel=1e-6) and 175_000 < a < 185_000


def test_longitude_degrees_shrink_with_latitude():
    assert haversine_m(60, 0, 60, 1) == pytest.approx(111_195.08 * np.cos(np.radians(60)), rel=1e-3)


def test_chord_matches_unit_vectors():
    p, q = to_unit_xyz([38.0], [30.0]), to_unit_xyz([38.0 + 2000 / M_PER_DEG_LAT], [30.0])
    assert np.linalg.norm(p - q) == pytest.approx(chord_for_distance(2000), rel=1e-6)


def test_pixel_half_diagonal():
    assert pixel_half_diagonal_m(3, 4) == pytest.approx(2500)


# ---------- matching ----------
def test_simple_match_and_unmatched():
    out, _ = run([det("m1", 38, 30, "2015-07-01 11:00"), det("m2", 39, 31, "2015-07-01 11:00")],
                 [det("v1", 38 + 500 / M_PER_DEG_LAT, 30, "2015-07-01 11:05"), det("v2", 37, 29, "2015-07-01 11:05")])
    st = {(r.modis_detection_id, r.viirs_detection_id): r.match_status for r in out.itertuples()}
    assert st[("m1", "v1")] == "matched"
    assert out[out.modis_detection_id == "m2"].match_status.item() == "modis_only"
    assert out[out.viirs_detection_id == "v2"].match_status.item() == "viirs_only"
    pair = out[out.match_status == "matched"].iloc[0]
    assert pair.distance_m == pytest.approx(500, abs=1) and pair.time_difference_seconds == 300


def test_time_window_boundary_is_inclusive():
    m = det("m1", 38, 30, "2015-07-01 11:00")
    on = det("v1", 38, 30, "2015-07-01 11:20")                       # exactly 1200 s
    off = det("v2", 38.0001, 30, "2015-07-01 11:21")                  # 1260 s
    out, _ = run([m], [on, off])
    assert out[out.viirs_detection_id == "v1"].match_status.item() == "matched"
    assert out[out.viirs_detection_id == "v2"].match_status.item() == "viirs_only"


def test_distance_boundary():
    m = det("m1", 38, 30, "2015-07-01 11:00")
    inside = det("v1", 38 + 1499 / M_PER_DEG_LAT, 30, "2015-07-01 11:00")
    outside = det("v2", 38 - 1501 / M_PER_DEG_LAT, 30, "2015-07-01 11:00")
    out, _ = run([m], [inside, outside])
    assert out[out.viirs_detection_id == "v1"].match_status.item() == "matched"
    assert out[out.viirs_detection_id == "v2"].match_status.item() == "viirs_only"


def test_one_modis_pixel_many_viirs_pixels():
    m = det("m1", 38, 30, "2015-07-01 11:00")
    vs = [det(f"v{i}", 38 + i * 200 / M_PER_DEG_LAT, 30, "2015-07-01 11:02") for i in range(3)]
    out, _ = run([m], vs)
    assert (out.match_status == "matched").sum() == 3 and out.viirs_detection_id.is_unique


def test_competing_modis_detections_assignment_is_deterministic():
    a = det("mA", 38, 30, "2015-07-01 11:00")
    b = det("mB", 38 + 600 / M_PER_DEG_LAT, 30, "2015-07-01 11:00")
    v = det("v1", 38 + 100 / M_PER_DEG_LAT, 30, "2015-07-01 11:03")   # nearer to mA
    out1, _ = run([a, b], [v])
    out2, _ = run([b, a], [v])                                        # input order must not matter
    for out in (out1, out2):
        assert out[out.viirs_detection_id == "v1"].modis_detection_id.item() == "mA"
        assert out[out.modis_detection_id == "mB"].match_status.item() == "candidate_unassigned"


def test_equal_distance_tie_broken_by_time_then_id():
    v = det("v1", 38, 30, "2015-07-01 11:00")
    east = det("mB", 38, 30 + 300 / (M_PER_DEG_LAT * np.cos(np.radians(38))), "2015-07-01 11:05")
    west = det("mA", 38, 30 - 300 / (M_PER_DEG_LAT * np.cos(np.radians(38))), "2015-07-01 11:10")
    out, _ = run([east, west], [v])
    assert out[out.viirs_detection_id == "v1"].modis_detection_id.item() == "mB"     # smaller |dt|
    west_same_time = dict(west, acquisition_timestamp=pd.Timestamp("2015-07-01 11:05", tz="UTC"))
    out, _ = run([east, west_same_time], [v])
    assert out[out.viirs_detection_id == "v1"].modis_detection_id.item() == "mA"     # then smaller id


def test_match_across_midnight():
    out, _ = run([det("m1", 38, 30, "2015-07-01 23:55")], [det("v1", 38, 30, "2015-07-02 00:05")])
    assert out[out.viirs_detection_id == "v1"].match_status.item() == "matched"


def test_missing_timestamp_is_refused():
    bad = det("m1", 38, 30, "2015-07-01 11:00")
    bad["acquisition_timestamp"] = pd.NaT
    with pytest.raises(ValueError):
        run([bad], [det("v1", 38, 30, "2015-07-01 11:00")])


def test_pass_evidence():
    near_pass = run([det("m1", 38, 30, "2015-07-01 11:00")], [det("v1", 39.5, 31, "2015-07-01 11:05")])[0]
    assert near_pass[near_pass.modis_detection_id == "m1"].other_sensor_pass_evidence.item() == True  # noqa: E712
    no_pass = run([det("m1", 38, 30, "2015-07-01 11:00")], [det("v1", 38, 30, "2015-07-03 11:00")])[0]
    assert no_pass[no_pass.modis_detection_id == "m1"].other_sensor_pass_evidence.item() == False  # noqa: E712


def test_footprint_mode_uses_pixel_sizes():
    cfg = {**CFG, "spatial": {**CFG["spatial"], "mode": "footprint"}}
    m = det("m1", 38, 30, "2015-07-01 11:00", scan=4.0, track=2.0)                     # big edge-of-swath pixel
    v = det("v1", 38 + 2500 / M_PER_DEG_LAT, 30, "2015-07-01 11:00", scan=0.4, track=0.4)
    out, _ = run([m], [v], cfg)
    assert out[out.viirs_detection_id == "v1"].match_status.item() == "matched"
    assert out[out.viirs_detection_id == "v1"].spatial_threshold_m.item() == pytest.approx(2236.1 + 282.8, abs=1)


def test_every_detection_appears_and_each_viirs_once():
    rng = np.random.default_rng(1)
    ms = [det(f"m{i}", 38 + rng.normal(0, .05), 30 + rng.normal(0, .05), "2015-07-01 11:00") for i in range(60)]
    vs = [det(f"v{i}", 38 + rng.normal(0, .05), 30 + rng.normal(0, .05), "2015-07-01 11:08") for i in range(150)]
    out, pairs = run(ms, vs)
    assert set(out.modis_detection_id.dropna()) == {f"m{i}" for i in range(60)}
    assert set(out.viirs_detection_id.dropna()) == {f"v{i}" for i in range(150)} and out.viirs_detection_id.dropna().is_unique
    assert out.comparison_id.is_unique and (pairs.distance_m <= 1500).all()


def test_sensitivity_grows_with_thresholds():
    rng = np.random.default_rng(2)
    ms = [det(f"m{i}", 38 + rng.normal(0, .1), 30 + rng.normal(0, .1), "2015-07-01 11:00") for i in range(80)]
    vs = [det(f"v{i}", 38 + rng.normal(0, .1), 30 + rng.normal(0, .1), "2015-07-01 11:10") for i in range(200)]
    s = sensitivity(frame(*ms), frame(*vs), [500, 1500, 3000], [300, 1200])
    assert s[s.temporal_threshold_seconds == 300].candidate_pairs.sum() == 0
    grow = s[s.temporal_threshold_seconds == 1200].sort_values("spatial_threshold_m").modis_with_candidate_pct
    assert grow.is_monotonic_increasing
