"""Steps 7-10 tests: Gold reconciliation, calendar regression vs the original script, AI dataset,
database publication (skipped when no database), workflow stop-on-failure."""
import json
import os
import subprocess
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from src.analytics.ai_dataset import build_model_input, validate_predictions
from src.analytics.gold import run_gold
from src.ingestion.firms import run_ingestion
from src.transformation.silver import run_silver
from tests.conftest import ROOT, database_available
from tests.fixtures.fake_firms import FakeFirms
from tests.fixtures.make_synthetic import write_tree


@pytest.fixture
def built(server_root, make_cfg):
    with FakeFirms(server_root) as srv:
        cfg = make_cfg(srv.country_base_url)
        run_ingestion(cfg, start_year=2010, end_year=2014, countries=["Turkey", "Egypt"])
    run_silver(cfg)
    manifest = run_gold(cfg)
    return cfg, manifest


def test_gold_reconciles_with_silver(built):
    cfg, manifest = built
    gold = cfg.gold / "current"
    assert manifest["reconciliation_passed"]
    assert all(json.loads((gold / "reconciliation.json").read_text()).values())
    stats = pd.read_csv(gold / "gold_hotspot_statistics.csv")
    assert stats.modis_detections.sum() == manifest["compared_modis"]
    assert stats.viirs_detections.sum() == manifest["compared_viirs"]
    rate = stats.modis_match_rate_pct.dropna()          # empty when a month has no MODIS detections (no denominator)
    assert stats.modis_match_rate_pct.isna().equals(stats.modis_detections == 0)
    assert ((rate >= 0) & (rate <= 100)).all()
    for f in ["calendar.json", "monthly_grid.json", "cells_summary.json", "validation.csv"]:
        assert (gold / "calendar" / f).exists()


def test_synthetic_fires_are_mostly_matched(built):
    _, manifest = built
    c = manifest["match_status_counts"]
    # synthetic MODIS detections are generated from the same fires VIIRS sees, so most must match
    assert c["matched"] > c.get("modis_only", 0)


def test_static_and_flare_sites_excluded_from_comparison(built):
    cfg, _ = built
    cmp = pd.read_parquet(cfg.gold / "current/gold_detection_comparison.parquet")
    near_flare = (abs(cmp.latitude - 29.5012) < 0.01) & (abs(cmp.longitude - 32.5503) < 0.01)
    near_static = (abs(cmp.latitude - 30.1005) < 0.01) & (abs(cmp.longitude - 31.6004) < 0.01)
    assert not near_flare.any() and not near_static.any()


def test_rerun_gold_keeps_previous_and_same_results(built):
    cfg, first = built
    second = run_gold(cfg)
    assert (cfg.gold / "previous").exists()
    assert first["match_status_counts"] == second["match_status_counts"]


def test_calendar_matches_original_script(tmp_path, make_cfg):
    """The pipeline's calendar must equal the original firms_harmonize.py output on clean input."""
    root = tmp_path / "srv"
    write_tree(root, broken_file=False)
    flat = tmp_path / "flat"
    flat.mkdir()
    for p in (root / "data/country").rglob("*.csv"):
        (flat / p.name).write_bytes(p.read_bytes())
    original = ROOT / "src/analytics/harmonized_calendar.py"
    subprocess.run([sys.executable, str(original), "--input", str(flat), "--out", str(tmp_path / "ref")],
                   check=True, capture_output=True, cwd=ROOT)
    with FakeFirms(root) as srv:
        cfg = make_cfg(srv.country_base_url)
        run_ingestion(cfg, start_year=2010, end_year=2014, countries=["Turkey", "Egypt"])
    run_silver(cfg)
    run_gold(cfg)
    a = json.loads((tmp_path / "ref/calendar.json").read_text())
    b = json.loads((cfg.gold / "current/calendar/calendar.json").read_text())
    assert a == b


def test_ai_model_input_and_prediction_contract(built):
    cfg, manifest = built
    out = build_model_input(cfg, train_until=2012, val_until=2013)
    x = pd.read_parquet(out / "model_input.parquet")
    assert len(x) == manifest["compared_modis"] + manifest["compared_viirs"]
    assert x.detection_id.is_unique
    assert set(x[x.split == "train"].year) <= {2012} and set(x[x.split == "test"].year) <= {2014}
    assert (x.cell_fire_days_prior_12m >= 0).all()
    pred = pd.DataFrame({"prediction_id": ["p1"], "input_record_id": [x.detection_id.iloc[0]], "model_name": ["m"],
                         "model_version": ["0.1"], "prediction_label": ["x"], "prediction_score": [0.5],
                         "inference_timestamp": ["2026-11-13T00:00:00Z"]})
    assert validate_predictions(pred, x) == []
    assert validate_predictions(pred.drop(columns="model_version"), x) == ["missing column model_version"]


def test_prior_cell_activity_uses_only_the_past(built):
    cfg, _ = built
    x = pd.read_parquet(build_model_input(cfg, train_until=2012, val_until=2013) / "model_input.parquet")
    first_month = x[(x.year == x.year.min()) & (x.month == x[x.year == x.year.min()].month.min())]
    # nothing in Silver before 2010 -> the very first months can only see 2010-2011 history, never their own month
    assert first_month.cell_fire_days_prior_12m.max() <= 12 * 31


def test_workflow_stops_after_failed_stage(tmp_path, server_root):
    with FakeFirms(server_root, always_fail={"modis_2012_Egypt.csv"}) as srv:
        env = {**os.environ, "FIRMS_COUNTRY_BASE_URL": srv.country_base_url}
        r = subprocess.run([sys.executable, "-m", "src.orchestration.workflow", "run", "--data-dir", str(tmp_path / "d"),
                            "--start-year", "2012", "--end-year", "2012", "--countries", "Egypt"],
                           cwd=ROOT, env=env, capture_output=True, text=True, timeout=300)
    assert r.returncode == 1
    runs = pd.read_csv(tmp_path / "d/_runs/pipeline_runs.csv")
    assert list(runs.stage) == ["ingest"] and runs.status.item() == "failed"
    assert not (tmp_path / "d/gold/current").exists()


@pytest.mark.skipif(not database_available(), reason="DATABASE_URL not set or database not reachable")
def test_publish_is_idempotent_and_atomic(built, monkeypatch):
    import psycopg
    from src.database import publish
    cfg, manifest = built
    publish.run_publish(cfg)
    publish.run_publish(cfg)
    url = os.environ["DATABASE_URL"].replace("+psycopg", "")
    with psycopg.connect(url) as c:
        n, nd = c.execute("SELECT count(*), count(DISTINCT detection_id) FROM firms.detections").fetchone()
        ncmp = c.execute("SELECT count(*) FROM firms.detection_comparisons").fetchone()[0]
    assert n == nd and ncmp == sum(manifest["match_status_counts"].values())

    real = publish.gold_frames
    def broken(cfg, gold_dir):
        frames = real(cfg, gold_dir)
        frames["firms.hotspot_statistics"] = frames["firms.hotspot_statistics"].assign(not_a_column=1)
        return frames
    monkeypatch.setattr(publish, "gold_frames", broken)
    with pytest.raises(Exception):
        publish.run_publish(cfg)
    with psycopg.connect(url) as c:
        assert c.execute("SELECT count(*) FROM firms.detection_comparisons").fetchone()[0] == ncmp   # rolled back
        assert c.execute("SELECT count(*) FROM firms.pipeline_runs WHERE status = 'failed'").fetchone()[0] >= 1
