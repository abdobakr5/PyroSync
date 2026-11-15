"""Step 10 - Run the pipeline stages in order, with a run log.

    python -m src.orchestration.workflow run                          # all default stages
    python -m src.orchestration.workflow run --stages silver,gold     # rerun some stages
    python -m src.orchestration.workflow run --start-year 2019 --end-year 2020 --countries Greece   # backfill
    python -m src.orchestration.workflow run --stages publish         # load Gold into PostGIS
    python -m src.orchestration.workflow status                       # last runs + monitoring

Rules:
  * Stages run in this order: ingest -> silver -> gold -> ai -> publish (publish only when asked for).
  * A stage starts only if the previous stage succeeded. The first failure stops the run.
  * Every stage writes one row to data/_runs/pipeline_runs.csv (start, end, status, counts, error).
  * Ingestion with failed downloads stops the run, unless --allow-partial (then only what arrived is used).
  * Gold is built in a staging folder and published only if reconciliation passes; the database
    publication is one transaction. So a failed run never replaces good published data.
  * Every stage can be rerun safely (idempotent).

For a schedule, call `run` from cron / Windows Task Scheduler (see docs/operations.md). An orchestrator
such as Airflow or Prefect can call the same stage functions later if the project needs one.
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
import time
import traceback

from src.common.config import load_config
from src.common.runlog import append_rows, new_run_id, utc_now

DEFAULT_STAGES = ["ingest", "silver", "gold", "ai"]
ALL_STAGES = ["ingest", "silver", "gold", "ai", "publish"]
RUN_FIELDS = ["pipeline_run_id", "stage", "status", "started_at", "finished_at", "duration_seconds", "details", "error_message"]
log = logging.getLogger("workflow")


class StageFailed(RuntimeError):
    pass


def _stage_ingest(cfg, a):
    from src.ingestion.firms import run_ingestion
    s = run_ingestion(cfg, a.start_year, a.end_year, a.countries, a.products, a.refresh, a.nrt)
    if s["failed"] and not a.allow_partial:
        raise StageFailed(f"{s['failed']} downloads failed (see data/bronze/_ingestion_log.csv); "
                          "rerun to retry them, or use --allow-partial")
    return s


def _stage_silver(cfg, a):
    from src.transformation.silver import run_silver
    from src.validation.monitoring import collect
    s = run_silver(cfg, refresh=a.refresh)
    if s["schema_errors"]:
        raise StageFailed(f"{s['schema_errors']} Bronze files have an unexpected schema (see data/silver/_quality/dq_report.csv)")
    s["volume_alerts"] = len(collect(cfg)["volume_change_alerts"])
    return s


def _stage_gold(cfg, a):
    from src.analytics.gold import run_gold
    m = run_gold(cfg)
    return {k: m[k] for k in ["run_id", "silver_detections", "analysis_detections", "compared_modis", "compared_viirs",
                              "match_status_counts", "reconciliation_passed"]}


def _stage_ai(cfg, a):
    from src.analytics.ai_dataset import build_model_input
    return {"output": str(build_model_input(cfg))}


def _stage_publish(cfg, a):
    from src.database.publish import run_publish
    return run_publish(cfg)


STAGES = {"ingest": _stage_ingest, "silver": _stage_silver, "gold": _stage_gold, "ai": _stage_ai, "publish": _stage_publish}


def run(a) -> int:
    overrides = {}
    if a.data_dir:
        overrides["data_dir"] = a.data_dir
    cfg = load_config(a.config, overrides=overrides)
    stages = [s for s in ALL_STAGES if s in (a.stages.split(",") if a.stages else DEFAULT_STAGES)]
    run_id = new_run_id("pipeline")
    log.info("pipeline %s: stages %s", run_id, stages)
    for stage in stages:
        started, t0 = utc_now(), time.time()
        row = {"pipeline_run_id": run_id, "stage": stage, "started_at": started}
        try:
            details = STAGES[stage](cfg, a)
            row.update(status="success", details=json.dumps(details, default=str), error_message="")
            log.info("%s: success %s", stage, details)
        except Exception as e:
            row.update(status="failed", details="", error_message=f"{type(e).__name__}: {e}"[:500])
            log.error("%s failed: %s", stage, e)
            log.debug(traceback.format_exc())
        row.update(finished_at=utc_now(), duration_seconds=round(time.time() - t0, 1))
        append_rows(cfg.runs / "pipeline_runs.csv", [row], RUN_FIELDS)
        if row["status"] != "success":
            later = stages[stages.index(stage) + 1:]
            if later:
                log.error("stopping: %s not run", ", ".join(later))
            return 1
    return 0


def status(a) -> int:
    import pandas as pd
    cfg = load_config(a.config, overrides={"data_dir": a.data_dir} if a.data_dir else None)
    p = cfg.runs / "pipeline_runs.csv"
    if p.exists():
        print(pd.read_csv(p).tail(10)[["pipeline_run_id", "stage", "status", "finished_at", "duration_seconds", "error_message"]]
              .to_string(index=False))
    m = cfg.runs / "monitoring.json"
    if m.exists():
        print(m.read_text())
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--stages", help=f"comma list from {ALL_STAGES} (default: {','.join(DEFAULT_STAGES)})")
    r.add_argument("--start-year", type=int)
    r.add_argument("--end-year", type=int)
    r.add_argument("--countries", type=lambda s: [c.strip() for c in s.split(",")])
    r.add_argument("--products", type=lambda s: [c.strip() for c in s.split(",")])
    r.add_argument("--refresh", action="store_true", help="download / reprocess even if unchanged")
    r.add_argument("--nrt", action="store_true", default=None, help="also pull recent NRT days (needs FIRMS_MAP_KEY)")
    r.add_argument("--allow-partial", action="store_true")
    for p in (r, sub.add_parser("status")):
        p.add_argument("--config", help="path to pipeline.yaml")
        p.add_argument("--data-dir", help="override data_dir")
        p.add_argument("-v", "--verbose", action="store_true")
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if a.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s", stream=sys.stdout)
    return run(a) if a.cmd == "run" else status(a)


if __name__ == "__main__":
    sys.exit(main())
