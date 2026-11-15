"""Step 11 - Monitoring metrics written after each run (data/_runs/monitoring.json).

A sudden change in counts is flagged for a person to investigate. It is never treated as proof that
fewer fires happened (it can be a source change, an outage, or a processing problem).
"""
from __future__ import annotations

import json

import pandas as pd

from src.common.config import Config
from src.common.runlog import utc_now


def volume_changes(cfg: Config, max_change_pct: float) -> list[dict]:
    """Compare each Bronze file's valid record count with the previous time it was processed."""
    path = cfg.silver / "_quality" / "dq_report.csv"
    if not path.exists():
        return []
    dq = pd.read_csv(path).sort_values("processed_at")
    alerts = []
    for bronze_path, g in dq.groupby("bronze_path"):
        if len(g) < 2:
            continue
        prev, last = g.iloc[-2], g.iloc[-1]
        if prev.valid_records == 0:
            continue
        change = 100 * (last.valid_records - prev.valid_records) / prev.valid_records
        if abs(change) > max_change_pct:
            alerts.append({"bronze_path": bronze_path, "previous": int(prev.valid_records),
                           "current": int(last.valid_records), "change_pct": round(change, 1)})
    return alerts


def collect(cfg: Config) -> dict:
    out = {"generated_at": utc_now()}
    log_path = cfg.bronze / "_ingestion_log.csv"
    if log_path.exists():
        lg = pd.read_csv(log_path)
        last = lg[lg.run_id == lg.run_id.iloc[-1]]
        out["last_ingestion"] = {"run_id": last.run_id.iloc[0], **last.status.value_counts().to_dict()}
    dq_path = cfg.silver / "_quality" / "dq_report.csv"
    if dq_path.exists():
        dq = pd.read_csv(dq_path)
        last = dq[dq.run_id == dq.run_id.iloc[-1]]
        out["last_silver"] = {"run_id": last.run_id.iloc[0], "files": len(last),
                              "input_records": int(last.input_records.sum()), "valid_records": int(last.valid_records.sum()),
                              "rejected_records": int(last.rejected_records.sum()),
                              "duplicate_records": int(last.duplicate_records.sum()),
                              "schema_errors": int((last.status == "schema_error").sum()),
                              "duration_seconds": float(last.duration_seconds.sum())}
    files = sorted((cfg.silver / "detections").glob("instrument=*/year=*/*.parquet"))
    if files:
        fresh = {}
        for f in files:
            d = pd.read_parquet(f, columns=["product_key", "acquisition_timestamp"])
            if len(d):
                k = d.product_key.iloc[0]
                fresh[k] = max(fresh.get(k, ""), str(d.acquisition_timestamp.max()))
        out["source_freshness_latest_detection"] = fresh
    man = cfg.gold / "current" / "manifest.json"
    if man.exists():
        m = json.loads(man.read_text())
        out["gold"] = {"run_id": m["run_id"], "match_status_counts": m["match_status_counts"],
                       "reconciliation_passed": m["reconciliation_passed"]}
    out["volume_change_alerts"] = volume_changes(cfg, cfg.pipeline["quality"]["max_volume_change_pct"])
    cfg.runs.mkdir(parents=True, exist_ok=True)
    (cfg.runs / "monitoring.json").write_text(json.dumps(out, indent=1, default=str))
    return out
