# MODIS–VIIRS Active-Fire Data Pipeline

This folder implements the **Data Engineering Implementation Plan**. It downloads NASA FIRMS fire detections from MODIS and VIIRS, keeps the raw files, validates and harmonizes them, matches detections between the two sensors, builds analytical datasets and the harmonized fire calendar, and publishes everything to PostgreSQL/PostGIS. One command runs the whole pipeline, and every step is logged.

Region: Eastern Mediterranean (Cyprus, Egypt, Greece, Israel, Jordan, Lebanon, Palestine, Syria, Turkey). Years: 2000–2025. Both are set in `config/pipeline.yaml`.

## Quick start

```bash
pip install -r requirements.txt
copy .env.example .env                      # Linux/macOS: cp .env.example .env
python -m src.orchestration.workflow run --countries Greece --start-year 2021 --end-year 2021   # small test
python -m src.orchestration.workflow run    # full region, all years
python -m src.orchestration.workflow status
pytest -q
```

Results are written to `data/gold/current/`. The frontend files are in `data/gold/current/calendar/`. More commands, scheduling and recovery are in `docs/operations.md`.

## Plan step → where it is

| Plan step | Files | Main outputs |
|---|---|---|
| 1. Source datasets | `config/sources.yaml`, `docs/source_specification.md` | product list, fields, limits, licence, region and dates |
| 2. Architecture and contracts | `docs/architecture.md`, `docs/data_dictionary.md`, `docs/data_contracts.md`, `config/pipeline.yaml` | layers, conventions, canonical schema, contracts for Frontend / Backend / AI |
| 3. Ingestion | `src/ingestion/firms.py` | `data/bronze/…` raw files, `data/bronze/_ingestion_log.csv` |
| 4. Validate and harmonize | `src/validation/checks.py`, `src/transformation/harmonize.py`, `src/transformation/silver.py` | `data/silver/detections/…parquet`, `_quarantine/`, `_quality/dq_report.csv` |
| 5. Geospatial and time | `src/geospatial/geometry.py`, `src/transformation/flags.py` | great-circle distances, pixel footprints, local solar dates, grid cells, static-source flag |
| 6. Candidate matching | `src/geospatial/matching.py`, `docs/matching_methodology.md` | `detection_matches`, `candidate_pairs`, `matching_sensitivity` |
| 7. Gold datasets | `src/analytics/gold.py`, `src/analytics/harmonized_calendar.py` | comparison, hotspot statistics, regional trends, calendar + map layers, reconciliation |
| 8. PostgreSQL / PostGIS | `sql/migrations/001_initial_schema.sql`, `src/database/`, `sql/example_queries.sql` | tables, indexes, views, upsert / atomic publish, tested queries |
| 9. AI integration | `src/analytics/ai_dataset.py`, `docs/data_contracts.md` §3 | `data/gold/ai/<run>/model_input.parquet`, prediction validator |
| 10. Orchestration | `src/orchestration/workflow.py`, `docs/operations.md` | ordered stages, run log, retries, backfill, stop on failure |
| 11. Testing and monitoring | `tests/`, `src/validation/monitoring.py`, `docs/test_results.txt` | 43 tests, `data/_runs/monitoring.json` |
| 12. Documentation | this README + `docs/` | runbook, methodology, dictionary, contracts |

`src/analytics/harmonized_calendar.py` is a **copy** of the earlier `firms_harmonize.py`, adapted to read Silver data. The original file is unchanged. A test checks that both produce exactly the same `calendar.json` on the same input.

## Definition of done (plan §15)

| Item | Status |
|---|---|
| Exact MODIS and VIIRS products documented | ✅ `docs/source_specification.md` |
| Raw source files preserved and traceable | ✅ unchanged bytes + SHA-256 + run id in the ingestion log |
| Ingestion can be rerun safely | ✅ tested (`test_rerun_is_idempotent…`) |
| Ingestion failures and empty results distinguishable | ✅ `failed` / `empty` / `not_available` (tested) |
| Silver datasets follow documented schemas | ✅ tested (`test_canonical_schema…`) |
| Invalid records reported or quarantined | ✅ with reasons and line numbers (tested) |
| Source-specific fields and meanings preserved | ✅ raw confidence, version, brightness channels, type |
| Spatial and temporal calculations tested | ✅ `tests/test_matching.py` |
| Matching rules and limitations documented | ✅ `docs/matching_methodology.md` |
| Unmatched detections retained | ✅ enforced by reconciliation checks |
| Gold datasets have documented grains and metrics | ✅ `docs/data_dictionary.md` |
| Database tables and indexes support agreed queries | ✅ tested on PostgreSQL 16 + PostGIS 3.4 |
| AI inputs and outputs have agreed data contracts | 🟡 proposed. The AI Engineer must confirm the task and grain |
| Pipeline execution automated or reproducibly documented | ✅ `workflow.py` + scheduling in `docs/operations.md` |
| Tests and data-quality checks run successfully | ✅ 43 / 43 passed (`docs/test_results.txt`) |
| Backend can query the published datasets | 🟡 queries tested. Backend must confirm its needs |
| Another developer can set up and run the pipeline from the docs | ✅ Quick start + `docs/operations.md` |

## What was tested, and what still needs a real run

**Tested here:**
- every stage, on synthetic data in the exact FIRMS format, served by a local fake FIRMS web server (flaky responses, 404s, HTML error pages included)
- database publication against a real PostgreSQL 16 + PostGIS 3.4
- matching speed at real-data scale (~99k MODIS vs ~714k VIIRS detections in ~40 s)

**Not yet done:** a full run against the live FIRMS site. The build environment cannot reach NASA's servers. The same files were downloaded and processed earlier (432 files, 2.55 million rows) with the same logic, so the first real run should go smoothly. Run the small Greece test first.

## Open decisions for the team

1. **AI Engineer:** confirm the model task and input grain (`docs/data_contracts.md` §3).
2. **Matching thresholds:** review `matching_sensitivity.csv` from the first real run and agree on the defaults (`docs/matching_methodology.md`).
3. **2026 and later:** S-NPP delivery ends Nov 2026. Add NOAA-20 to the calendar with its own calibration (`gold.calendar.viirs_satellites`).
4. **Backend:** confirm tables, filters and refresh schedule (`docs/data_contracts.md` §2).
