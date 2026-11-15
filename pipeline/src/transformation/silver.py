"""Step 4 - Bronze -> Silver.

For every Bronze CSV: read as text, check schema, validate rows, quarantine bad rows with a reason,
harmonize good rows, remove exact duplicates, and write one Parquet file:

  data/silver/detections/instrument=<MODIS|VIIRS>/year=<YYYY>/<bronze file stem>.parquet
  data/silver/_quarantine/<bronze file stem>.parquet
  data/silver/_quality/dq_report.csv           (one row per file per run)

One Silver file per Bronze file keeps reruns idempotent (the same file is replaced) and avoids
many tiny files. A manifest skips files whose Bronze bytes and processing version are unchanged.
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
import time
from pathlib import Path

import pandas as pd

from src.common.config import Config
from src.common.runlog import append_rows, new_run_id, utc_now
from src.transformation.harmonize import CANONICAL_COLUMNS, harmonize
from src.validation.checks import schema_report, validate

log = logging.getLogger(__name__)

DQ_FIELDS = ["run_id", "processed_at", "bronze_path", "product_key", "region", "year", "input_records",
             "valid_records", "rejected_records", "duplicate_records", "invalid_coordinates", "timestamp_failures",
             "missing_by_field", "rejection_reasons", "schema_missing_cols", "schema_unexpected_cols",
             "schema_missing_optional", "duration_seconds", "status"]
PRODUCT_DIR = re.compile(r"product=([^/\\]+)")
YEAR_IN_NAME = re.compile(r"_(\d{4})_(.+)$")


def bronze_files(cfg: Config) -> list[Path]:
    return sorted(p for p in cfg.bronze.rglob("*.csv") if not p.name.startswith(("_", ".")))


def _ingestion_runs(cfg: Config) -> dict[str, str]:
    """bronze_path -> run_id of the last run that downloaded it."""
    path = cfg.bronze / "_ingestion_log.csv"
    if not path.exists():
        return {}
    lg = pd.read_csv(path, dtype=str)
    lg = lg[lg.status.isin(["success", "empty"])]
    return {str(Path(p)): r for p, r in zip(lg.bronze_path, lg.run_id)}


def _read_raw(path: Path) -> pd.DataFrame:
    raw = pd.read_csv(path, dtype=str, keep_default_na=False, na_values=[""], encoding="utf-8-sig")
    raw.columns = [c.strip().lower() for c in raw.columns]
    raw["source_row"] = range(2, len(raw) + 2)          # line number in the original CSV (header = 1)
    return raw


def process_file(cfg: Config, path: Path, run_id: str, ingest_runs: dict[str, str]) -> dict:
    t0 = time.time()
    key = PRODUCT_DIR.search(str(path)).group(1)
    product = cfg.product(key)
    inst = product["instrument"]
    m = YEAR_IN_NAME.search(path.stem)
    region = m.group(2).replace("_", " ") if m else cfg.pipeline["region"]["name"]
    raw = _read_raw(path)
    report = {"run_id": run_id, "processed_at": utc_now(), "bronze_path": str(path), "product_key": key,
              "region": region, **schema_report([c for c in raw.columns if c != "source_row"], inst)}

    if report["schema_missing_cols"]:
        # the file cannot be interpreted safely: quarantine every row, publish nothing for it
        q = raw.assign(reason="schema_missing_columns:" + report["schema_missing_cols"], bronze_path=str(path))
        _write_parquet(cfg.silver / "_quarantine" / f"{path.stem}.parquet", q)
        report.update(input_records=len(raw), valid_records=0, rejected_records=len(raw), duplicate_records=0,
                      status="schema_error", duration_seconds=round(time.time() - t0, 2))
        return report

    valid, reasons, counters = validate(raw, inst)
    good = raw[valid]
    det = harmonize(good, product, region, path.name, ingest_runs.get(str(path), ""),
                    cfg.pipeline["silver"]["processing_version"])
    dup = det.detection_id.duplicated(keep="first")
    det = det[~dup]

    year = int(det.acq_date_utc.dt.year.mode().iloc[0]) if len(det) else (int(m.group(1)) if m else 0)
    out = cfg.silver / "detections" / f"instrument={inst}" / f"year={year}" / f"{path.stem}.parquet"
    _write_parquet(out, det)
    qpath = cfg.silver / "_quarantine" / f"{path.stem}.parquet"
    if (~valid).any():
        _write_parquet(qpath, raw[~valid].assign(reason=reasons[~valid], bronze_path=str(path)))
    elif qpath.exists():
        qpath.unlink()                                   # rerun after a fix: no stale quarantine

    reason_counts = reasons[~valid].str.split(";").explode().value_counts().to_dict() if (~valid).any() else {}
    report.update(year=year, input_records=counters["input_records"], valid_records=len(det),
                  rejected_records=counters["rejected_records"], duplicate_records=int(dup.sum()),
                  invalid_coordinates=counters["invalid_coordinates"], timestamp_failures=counters["timestamp_failures"],
                  missing_by_field=json.dumps({k: v for k, v in counters["missing_by_field"].items() if v}),
                  rejection_reasons=json.dumps(reason_counts), status="ok",
                  duration_seconds=round(time.time() - t0, 2))
    return report


def _write_parquet(path: Path, df: pd.DataFrame) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".tmp_{path.name}")
    df.to_parquet(tmp, index=False)
    tmp.replace(path)


def run_silver(cfg: Config, refresh: bool = False, run_id: str | None = None) -> dict:
    run_id = run_id or new_run_id("silver")
    version = cfg.pipeline["silver"]["processing_version"]
    manifest_path = cfg.silver / "_manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    ingest_runs = _ingestion_runs(cfg)
    reports, skipped = [], 0
    for path in bronze_files(cfg):
        sha = hashlib.sha256(path.read_bytes()).hexdigest()
        prev = manifest.get(str(path))
        if not refresh and prev and prev["sha256"] == sha and prev["processing_version"] == version:
            skipped += 1
            continue
        rep = process_file(cfg, path, run_id, ingest_runs)
        reports.append(rep)
        manifest[str(path)] = {"sha256": sha, "processing_version": version, "run_id": run_id}
    append_rows(cfg.silver / "_quality" / "dq_report.csv", reports, DQ_FIELDS)
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, indent=1))
    summary = {"run_id": run_id, "files_processed": len(reports), "files_skipped_unchanged": skipped,
               "input_records": sum(r["input_records"] for r in reports),
               "valid_records": sum(r["valid_records"] for r in reports),
               "rejected_records": sum(r["rejected_records"] for r in reports),
               "duplicate_records": sum(r["duplicate_records"] for r in reports),
               "schema_errors": sum(r["status"] == "schema_error" for r in reports)}
    log.info("silver summary: %s", summary)
    return summary


def read_silver(cfg: Config, instrument: str | None = None, columns: list[str] | None = None) -> pd.DataFrame:
    """Read all Silver detections; drops cross-file exact duplicates (same detection_id)."""
    base = cfg.silver / "detections"
    files = sorted(base.glob(f"instrument={instrument}/year=*/*.parquet" if instrument else "instrument=*/year=*/*.parquet"))
    if not files:
        return pd.DataFrame(columns=columns or CANONICAL_COLUMNS)
    df = pd.concat([pd.read_parquet(f, columns=columns) for f in files], ignore_index=True)
    if "detection_id" in df.columns:
        df = df.drop_duplicates("detection_id", keep="first").reset_index(drop=True)
    return df
