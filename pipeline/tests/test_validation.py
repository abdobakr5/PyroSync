"""Step 4 tests: validation rules, quarantine, schema changes, canonical schema, stable IDs."""
from pathlib import Path

import pandas as pd

from src.transformation.harmonize import CANONICAL_COLUMNS, confidence_class, harmonize
from src.transformation.silver import read_silver, run_silver
from src.validation.checks import validate

HEADER = "latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_t31,frp,daynight,type\n"
GOOD = "38.0,30.0,320.0,1.0,1.0,2010-05-01,1130,Aqua,MODIS,50,6.03,290.0,10.0,D,0\n"


def _bronze(cfg, name: str, text: str, product="modis_sp", inst="modis", year=2010) -> Path:
    p = cfg.bronze / inst / f"product={product}" / f"year={year}" / name
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)
    return p


def test_invalid_rows_are_quarantined_with_reasons(make_cfg):
    cfg = make_cfg()
    bad = ["95.1,30.0,320.0,1.0,1.0,2010-05-01,1130,Aqua,MODIS,50,6.03,290.0,10.0,D,0\n",
           "38.0,30.0,320.0,1.0,1.0,2010-05-01,2575,Aqua,MODIS,50,6.03,290.0,10.0,D,0\n",
           "38.0,30.0,320.0,1.0,1.0,2010-02-30,1130,Aqua,MODIS,50,6.03,290.0,10.0,D,0\n",
           "38.0,30.0,320.0,1.0,1.0,2010-05-01,1130,,MODIS,50,6.03,290.0,10.0,D,0\n",
           "38.0,30.0,320.0,1.0,1.0,2010-05-01,1130,Aqua,MODIS,150,6.03,290.0,-5.0,D,0\n",
           "38.0,30.0,320.0,1.0,1.0,2010-05-01,1130,Aqua,MODIS,50,6.03,290.0,10.0,X,9\n"]
    _bronze(cfg, "modis_2010_Turkey.csv", HEADER + GOOD + "".join(bad))
    s = run_silver(cfg)
    assert s["valid_records"] == 1 and s["rejected_records"] == 6
    q = pd.read_parquet(cfg.silver / "_quarantine/modis_2010_Turkey.parquet")
    reasons = dict(zip(q.source_row, q.reason))
    assert reasons[3] == "invalid_latitude"
    assert reasons[4] == "invalid_acq_time"
    assert reasons[5] == "unparseable_acq_date"
    assert reasons[6] == "missing_satellite"
    assert set(reasons[7].split(";")) == {"invalid_confidence", "invalid_frp"}
    assert set(reasons[8].split(";")) == {"invalid_daynight", "invalid_type"}
    dq = pd.read_csv(cfg.silver / "_quality/dq_report.csv").iloc[-1]
    assert dq.invalid_coordinates == 1 and dq.timestamp_failures == 2


def test_missing_column_is_a_schema_error_and_nothing_is_published(make_cfg):
    cfg = make_cfg()
    _bronze(cfg, "modis_2010_Greece.csv", HEADER.replace(",frp", ",frp_renamed") + GOOD)
    s = run_silver(cfg)
    assert s["schema_errors"] == 1 and s["valid_records"] == 0
    assert read_silver(cfg).empty
    assert len(pd.read_parquet(cfg.silver / "_quarantine/modis_2010_Greece.parquet")) == 1


def test_nrt_file_without_type_column_is_accepted(make_cfg):
    cfg = make_cfg()
    hdr = HEADER.replace(",type\n", "\n")
    _bronze(cfg, "modis_2010_Syria.csv", hdr + GOOD.replace(",D,0\n", ",D\n").replace("6.03", "6.1NRT"))
    s = run_silver(cfg)
    det = read_silver(cfg)
    assert s["valid_records"] == 1 and det.fire_type.isna().all() and det.processing.iloc[0] == "NRT"


def test_exact_duplicates_counted_and_removed(make_cfg):
    cfg = make_cfg()
    _bronze(cfg, "modis_2010_Cyprus.csv", HEADER + GOOD + GOOD)
    s = run_silver(cfg)
    assert s["duplicate_records"] == 1 and len(read_silver(cfg)) == 1


def test_canonical_schema_and_stable_ids(make_cfg):
    cfg = make_cfg()
    _bronze(cfg, "modis_2010_Lebanon.csv", HEADER + GOOD + GOOD.replace("38.0,30.0", "38.1,30.0"))
    run_silver(cfg)
    a = read_silver(cfg)
    run_silver(cfg, refresh=True)
    b = read_silver(cfg)
    assert list(a.columns) == CANONICAL_COLUMNS
    assert a.detection_id.is_unique and list(a.detection_id) == list(b.detection_id)
    assert str(a.acquisition_timestamp.dt.tz) == "UTC"
    assert a.satellite.iloc[0] == "Aqua" and a.confidence_raw.iloc[0] == "50"


def test_local_solar_date_moves_late_utc_passes_to_next_day(make_cfg):
    cfg = make_cfg()
    row = GOOD.replace("1130", "2330")                       # 23:30 UTC at lon 30 = 01:30 local solar
    _bronze(cfg, "modis_2010_Jordan.csv", HEADER + row)
    run_silver(cfg)
    d = read_silver(cfg).iloc[0]
    assert str(d.acq_date_utc.date()) == "2010-05-01" and str(d.local_solar_date.date()) == "2010-05-02"
    assert d.local_solar_hour == 1.5


def test_unchanged_files_are_skipped_on_rerun(make_cfg):
    cfg = make_cfg()
    _bronze(cfg, "modis_2010_Israel.csv", HEADER + GOOD)
    assert run_silver(cfg)["files_processed"] == 1
    assert run_silver(cfg)["files_skipped_unchanged"] == 1


def test_modis_confidence_class_boundaries():
    s = confidence_class(pd.Series(["0", "29", "30", "79", "80", "100"]), "MODIS")
    assert list(s) == ["low", "low", "nominal", "nominal", "high", "high"]
    v = confidence_class(pd.Series(["l", "n", "h", "nominal"]), "VIIRS")
    assert list(v) == ["low", "nominal", "high", "nominal"]


def test_viirs_rules():
    raw = pd.DataFrame([{"latitude": "38", "longitude": "30", "bright_ti4": "330", "scan": "0.4", "track": "0.4",
                         "acq_date": "2013-01-01", "acq_time": "1105", "satellite": "N", "instrument": "VIIRS",
                         "confidence": c, "version": "2", "bright_ti5": "290", "frp": "3", "daynight": "D", "type": "0"}
                        for c in ["n", "x"]])
    valid, reasons, _ = validate(raw, "VIIRS")
    assert list(valid) == [True, False] and reasons.iloc[1] == "invalid_confidence"


def test_harmonize_keeps_original_values():
    raw = pd.DataFrame([{"latitude": "38.00010", "longitude": "30.0", "brightness": "320.5", "scan": "1.2", "track": "1.1",
                         "acq_date": "2010-05-01", "acq_time": "905", "satellite": "T", "instrument": "MODIS",
                         "confidence": "66", "version": "6.03", "bright_t31": "290", "frp": "12.5", "daynight": "D",
                         "type": "0", "source_row": 2}])
    out = harmonize(raw, {"key": "modis_sp", "instrument": "MODIS", "product": "p"}, "Egypt", "f.csv", "r1", "v1")
    r = out.iloc[0]
    assert r.satellite == "Terra" and r.acquisition_timestamp.strftime("%H:%M") == "09:05"
    assert r.confidence_raw == "66" and r.confidence_class == "nominal" and abs(r.pixel_area_km2 - 1.32) < 1e-9
