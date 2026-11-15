# Architecture (Plan Step 2)

```text
NASA FIRMS ──┬── MODIS yearly country CSVs (SP)
             ├── VIIRS S-NPP / NOAA-20 yearly country CSVs (SP)
             └── Area API (NRT, optional)
                        │  src/ingestion/firms.py
                        ▼
 BRONZE  data/bronze/<instrument>/product=<key>/year=<YYYY>/<original file>.csv     (unchanged bytes)
         data/bronze/_ingestion_log.csv                                             (one row per request)
                        │  src/validation/checks.py + src/transformation/harmonize.py + silver.py
                        ▼
 SILVER  data/silver/detections/instrument=<MODIS|VIIRS>/year=<YYYY>/<file>.parquet  (canonical schema)
         data/silver/_quarantine/<file>.parquet                                     (rejected rows + reason)
         data/silver/_quality/dq_report.csv                                         (data-quality report)
                        │  src/transformation/flags.py (analysis flags)
                        │  src/geospatial/matching.py  (MODIS-VIIRS candidate matching)
                        │  src/analytics/gold.py + harmonized_calendar.py
                        ▼
 GOLD    data/gold/_staging/<run_id>/  ──(all reconciliation checks pass)──►  data/gold/current/
           detection_matches, candidate_pairs, gold_detection_comparison,
           gold_hotspot_statistics, gold_regional_fire_trends, matching_sensitivity,
           calendar/ (calendar.json, monthly_grid.json, cells_summary.json, calibration, validation)
                        │
          ┌─────────────┼───────────────────────────┐
          ▼             ▼                           ▼
  AI Engineer     PostgreSQL / PostGIS        Frontend (static JSON files)
  data/gold/ai/   (src/database/publish.py)    calendar.json, monthly_grid.json
                        │
                        ▼
                  Backend APIs → Frontend map
```

`src/orchestration/workflow.py` runs the stages in order and logs every run to `data/_runs/pipeline_runs.csv`.

## Layer responsibilities

| Layer | Contains | Rules |
|---|---|---|
| Bronze | the exact files FIRMS returned | never edited; reruns skip existing files; refresh replaces atomically |
| Silver | every valid row, both instruments, one schema | invalid rows are quarantined with a reason; no scientific filtering (gas flares and low confidence stay, flagged for later) |
| Gold | answers to project questions | filters and thresholds are applied here and recorded with the run; published only if the totals reconcile with Silver |

## Conventions

| Topic | Convention |
|---|---|
| Time | `acquisition_timestamp` is UTC, timezone-aware. `local_solar_date` = UTC + longitude/15 hours, used for "which day did this fire burn". |
| Coordinates | WGS84 lat/lon degrees, EPSG:4326. Original values are never changed. Distances are great-circle metres. |
| Grid | regular 0.1° lat/lon grid. A cell is identified by the centre point or `cell_id = "<lat index>_<lon index>"`. |
| Nulls | empty value / Parquet null. `fire_type` is null for NRT rows. |
| IDs | `detection_id` = SHA-1 of product, satellite, date, time, lat, lon (as written in the source). The same row gives the same ID on every run. `comparison_id` = SHA-1 of both detection IDs and the matching rule version. |
| Versions | `processing_version` (Silver logic), `matching_rule_version` (matching logic), and `run_id` on every log, Gold manifest and database row. |
| File formats | CSV for raw (as delivered), Parquet for processed, JSON for frontend layers. |
| Partitioning | Bronze/Silver by instrument + year, one file per source file (no tiny files). |
| Secrets | `FIRMS_MAP_KEY` and `DATABASE_URL` live in `.env` (not in Git; see `.env.example`). |
| Storage | local disk for the prototype. The data folder can move to S3/MinIO later by changing `data_dir`. |

## Repository

```text
config/        pipeline.yaml (settings), sources.yaml (products and URLs)
src/common/    config loading, run ids, atomic writes, CSV logs
src/ingestion/ Step 3      src/validation/ Steps 4 and 11      src/transformation/ Step 4
src/geospatial/ Steps 5-6  src/analytics/  Steps 7 and 9       src/database/ Step 8
src/orchestration/ Step 10
sql/migrations/ database schema    sql/example_queries.sql
tests/         pytest suite + synthetic data + fake FIRMS server
docs/          this folder
data/          created at run time (not in Git)
```
