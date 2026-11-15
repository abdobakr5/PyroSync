"""Step 8 - Publish Silver detections and Gold tables to PostgreSQL/PostGIS.

* Migrations in sql/migrations/*.sql are applied once each, in order (tracked in firms.schema_migrations).
* detections: UPSERT by detection_id (loading the same data twice never duplicates rows).
* Gold tables: replaced as a whole inside ONE transaction. Readers keep seeing the old version
  until the commit, and a failure rolls everything back - a partial publication is never visible.
* Bulk loads use COPY through a temporary table (fast for millions of rows).
"""
from __future__ import annotations

import io
import json
import logging
from pathlib import Path

import numpy as np
import pandas as pd

from src.common.config import REPO_ROOT, Config
from src.common.runlog import new_run_id, utc_now
from src.database.connection import connect
from src.transformation.silver import read_silver

log = logging.getLogger(__name__)
MIGRATIONS = REPO_ROOT / "sql" / "migrations"

DETECTION_COLS = ["detection_id", "source_instrument", "source_product", "product_key", "satellite", "processing",
                  "version", "region", "acquisition_timestamp", "acq_date_utc", "local_solar_date", "local_solar_hour",
                  "latitude", "longitude", "brightness_mir_k", "brightness_tir_k", "scan_km", "track_km",
                  "pixel_area_km2", "frp_mw", "confidence_raw", "confidence_class", "daynight", "fire_type",
                  "source_file", "source_row", "ingestion_run_id", "processing_version", "published_run_id"]


def apply_migrations(conn) -> list[str]:
    with conn.cursor() as cur:
        cur.execute("CREATE SCHEMA IF NOT EXISTS firms")
        cur.execute("CREATE TABLE IF NOT EXISTS firms.schema_migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())")
        cur.execute("SELECT name FROM firms.schema_migrations")
        done = {r[0] for r in cur.fetchall()}
        applied = []
        for f in sorted(MIGRATIONS.glob("*.sql")):
            if f.name in done:
                continue
            cur.execute(f.read_text())
            cur.execute("INSERT INTO firms.schema_migrations (name) VALUES (%s)", (f.name,))
            applied.append(f.name)
    conn.commit()
    return applied


def _copy_df(cur, table: str, df: pd.DataFrame, cols: list[str]) -> None:
    buf = io.StringIO()
    out = df[cols].copy()
    for c in out.columns:
        if isinstance(out[c].dtype, pd.DatetimeTZDtype):
            out[c] = out[c].dt.strftime("%Y-%m-%dT%H:%M:%S%z")
        elif pd.api.types.is_datetime64_any_dtype(out[c]):
            out[c] = out[c].dt.strftime("%Y-%m-%d")
    out = out.replace([np.inf, -np.inf], np.nan)
    out.to_csv(buf, index=False, header=False, na_rep="\\N")
    buf.seek(0)
    with cur.copy(f"COPY {table} ({', '.join(cols)}) FROM STDIN WITH (FORMAT csv, NULL '\\N')") as cp:
        while chunk := buf.read(1 << 20):
            cp.write(chunk)


def upsert_detections(conn, df: pd.DataFrame, run_id: str) -> int:
    df = df.assign(published_run_id=run_id)
    with conn.cursor() as cur:
        cur.execute("CREATE TEMP TABLE stage_detections (LIKE firms.detections INCLUDING DEFAULTS) ON COMMIT DROP")
        cur.execute("ALTER TABLE stage_detections DROP COLUMN geom")
        _copy_df(cur, "stage_detections", df, DETECTION_COLS)
        updates = ", ".join(f"{c} = EXCLUDED.{c}" for c in DETECTION_COLS if c != "detection_id")
        cur.execute(f"INSERT INTO firms.detections ({', '.join(DETECTION_COLS)}) "
                    f"SELECT {', '.join(DETECTION_COLS)} FROM stage_detections "
                    f"ON CONFLICT (detection_id) DO UPDATE SET {updates}")
        return cur.rowcount


def replace_table(conn, table: str, df: pd.DataFrame) -> int:
    with conn.cursor() as cur:
        cur.execute(f"DELETE FROM {table}")
        _copy_df(cur, table, df, list(df.columns))
        return len(df)


def gold_frames(cfg: Config, gold_dir: Path) -> dict[str, pd.DataFrame]:
    g = cfg.pipeline["gold"]["grid_deg"]
    cal = gold_dir / "calendar"
    cmp = pd.read_parquet(gold_dir / "gold_detection_comparison.parquet")
    cmp["other_sensor_pass_evidence"] = cmp.other_sensor_pass_evidence.map({True: "true", False: "false"})
    for c in ["time_difference_seconds", "n_candidates", "temporal_threshold_seconds"]:
        cmp[c] = pd.to_numeric(cmp[c]).astype("Int64")
    daily = pd.read_csv(cal / "calendar_daily.csv", parse_dates=["date"])
    daily = daily[["region", "date", "harmonized", "modis_fire_cells", "viirs_fire_cells", "frp_harmonized", "source",
                   "percentile", "level", "frp_percentile", "frp_level"]].rename(columns={"frp_harmonized": "frp_mw"})
    for c in ["modis_fire_cells", "viirs_fire_cells"]:
        daily[c] = daily[c].astype("int64")
    mg = pd.read_csv(cal / "monthly_grid.csv").rename(columns={"ym": "year_month"}).assign(grid_deg=g)
    trends = pd.read_parquet(gold_dir / "gold_regional_fire_trends.parquet").assign(grid_deg=g)
    trends = trends.drop_duplicates(["cell_id", "region", "year_month", "instrument", "satellite"])
    ratios = pd.read_csv(cal / "calibration_region_month.csv")
    return {
        "firms.detection_comparisons": cmp,
        "firms.hotspot_statistics": pd.read_csv(gold_dir / "gold_hotspot_statistics.csv"),
        "firms.regional_fire_trends": trends,
        "firms.fire_calendar_daily": daily,
        "firms.monthly_grid": mg,
        "firms.calibration_ratios": ratios[["region", "month", "modis_fire_cells", "viirs_fire_cells", "modis_frp_sum",
                                            "viirs_frp_sum", "ratio", "method", "frp_ratio"]],
        "firms.calendar_validation": pd.read_csv(cal / "validation.csv"),
    }


def run_publish(cfg: Config, run_id: str | None = None) -> dict:
    run_id = run_id or new_run_id("publish")
    gold_dir = cfg.gold / "current"
    manifest = json.loads((gold_dir / "manifest.json").read_text())
    if not manifest.get("reconciliation_passed"):
        raise RuntimeError("Gold 'current' did not pass reconciliation - refusing to publish")
    started = utc_now()
    counts = {}
    with connect(cfg) as conn:
        counts["migrations_applied"] = apply_migrations(conn)
        try:
            counts["firms.detections (upserted)"] = upsert_detections(conn, read_silver(cfg), run_id)
            for table, df in gold_frames(cfg, gold_dir).items():
                counts[table] = replace_table(conn, table, df)
            with conn.cursor() as cur:
                cur.execute("INSERT INTO firms.pipeline_runs VALUES (%s, 'publish', 'success', %s, now(), %s, NULL)",
                            (run_id, started, json.dumps({"gold_run_id": manifest["run_id"], **{k: v for k, v in counts.items()}})))
            conn.commit()                              # everything becomes visible at once
        except Exception as e:
            conn.rollback()
            with conn.cursor() as cur:
                cur.execute("INSERT INTO firms.pipeline_runs VALUES (%s, 'publish', 'failed', %s, now(), NULL, %s)",
                            (run_id, started, str(e)[:500]))
            conn.commit()
            raise
    log.info("published %s", counts)
    return {"run_id": run_id, "gold_run_id": manifest["run_id"], **counts}
