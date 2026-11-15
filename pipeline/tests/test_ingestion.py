"""Step 3 tests: raw preservation, idempotency, retries, empty vs failed vs not available."""
import hashlib
import os

import pandas as pd

from src.ingestion.firms import _safe, run_ingestion
from tests.fixtures.fake_firms import FakeFirms

ARGS = dict(start_year=2012, end_year=2012, countries=["Egypt"], products=["modis_sp", "viirs_snpp_sp"])


def _log(cfg):
    return pd.read_csv(cfg.bronze / "_ingestion_log.csv")


def test_download_preserves_raw_bytes_and_logs(server_root, make_cfg):
    with FakeFirms(server_root) as srv:
        cfg = make_cfg(srv.country_base_url)
        s = run_ingestion(cfg, **ARGS)
    assert s["success"] == 2 and s["failed"] == 0
    src = server_root / "data/country/modis/2012/modis_2012_Egypt.csv"
    dst = cfg.bronze / "modis/product=modis_sp/year=2012/modis_2012_Egypt.csv"
    assert hashlib.sha256(src.read_bytes()).hexdigest() == hashlib.sha256(dst.read_bytes()).hexdigest()
    lg = _log(cfg)
    row = lg[lg.bronze_path == str(dst)].iloc[0]
    assert row.status == "success" and row.record_count == len(pd.read_csv(src))
    assert row.sha256 == hashlib.sha256(src.read_bytes()).hexdigest()


def test_rerun_is_idempotent_and_refresh_downloads_again(server_root, make_cfg):
    with FakeFirms(server_root) as srv:
        cfg = make_cfg(srv.country_base_url)
        run_ingestion(cfg, **ARGS)
        files_before = sorted(cfg.bronze.rglob("*.csv"))
        again = run_ingestion(cfg, **ARGS)
        refreshed = run_ingestion(cfg, refresh=True, **ARGS)
    assert again["skipped_exists"] == 2 and again["success"] == 0
    assert sorted(cfg.bronze.rglob("*.csv")) == files_before
    assert refreshed["success"] == 2


def test_missing_file_is_not_available_not_failed(server_root, make_cfg):
    with FakeFirms(server_root) as srv:
        cfg = make_cfg(srv.country_base_url)
        s = run_ingestion(cfg, start_year=2012, end_year=2012, countries=["Atlantis"], products=["modis_sp"])
    assert s["not_available"] == 1 and s["failed"] == 0
    assert not list(cfg.bronze.rglob("*Atlantis*"))


def test_header_only_file_is_empty_not_failed(tmp_path, make_cfg):
    root = tmp_path / "srv"
    p = root / "data/country/modis/2015/modis_2015_Cyprus.csv"
    p.parent.mkdir(parents=True)
    p.write_text("latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,instrument,confidence,"
                 "version,bright_t31,frp,daynight,type\n")
    with FakeFirms(root) as srv:
        cfg = make_cfg(srv.country_base_url)
        s = run_ingestion(cfg, start_year=2015, end_year=2015, countries=["Cyprus"], products=["modis_sp"])
    assert s["empty"] == 1 and s["failed"] == 0


def test_retry_then_success(server_root, make_cfg):
    with FakeFirms(server_root, flaky={"modis_2012_Egypt.csv": 2}) as srv:
        cfg = make_cfg(srv.country_base_url)
        s = run_ingestion(cfg, **ARGS)
    assert s["success"] == 2
    lg = _log(cfg)
    assert int(lg[lg.bronze_path.str.contains("modis_2012_Egypt")].attempts.iloc[0]) == 3


def test_failure_keeps_previous_good_file(server_root, make_cfg):
    with FakeFirms(server_root) as srv:
        cfg = make_cfg(srv.country_base_url)
        run_ingestion(cfg, **ARGS)
    good = cfg.bronze / "modis/product=modis_sp/year=2012/modis_2012_Egypt.csv"
    before = good.read_bytes()
    with FakeFirms(server_root, always_fail={"modis_2012_Egypt.csv"}) as srv:
        cfg.sources["firms"]["country_base_url"] = srv.country_base_url
        s = run_ingestion(cfg, refresh=True, **ARGS)
    assert s["failed"] == 1
    assert good.read_bytes() == before
    assert not [p for p in cfg.bronze.rglob(".tmp_*")]


def test_non_csv_response_is_rejected(server_root, make_cfg):
    with FakeFirms(server_root, html_instead={"modis_2012_Egypt.csv"}) as srv:
        cfg = make_cfg(srv.country_base_url)
        s = run_ingestion(cfg, **ARGS)
    assert s["failed"] == 1
    assert not (cfg.bronze / "modis/product=modis_sp/year=2012/modis_2012_Egypt.csv").exists()


def test_map_key_never_written_to_logs(monkeypatch):
    monkeypatch.setenv("FIRMS_MAP_KEY", "SECRET123")
    assert "SECRET123" not in _safe("https://x/api/area/csv/SECRET123/VIIRS_NOAA20_NRT/1,2,3,4/5/2026-11-01")
    assert os.environ["FIRMS_MAP_KEY"] == "SECRET123"
