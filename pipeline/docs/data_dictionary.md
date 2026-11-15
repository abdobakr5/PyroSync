# Data Dictionary

## Bronze

`data/bronze/<instrument>/product=<key>/year=<YYYY>/<file>.csv`: the original FIRMS CSV, byte for byte. Fields are listed in `source_specification.md`.

`data/bronze/_ingestion_log.csv`: one row per request.

| Column | Meaning |
|---|---|
| run_id | ingestion run |
| source_instrument, source_product, product_key | what was requested |
| region | country (or region name for API requests) |
| requested_start_date, requested_end_date | period covered by the request |
| retrieved_at | UTC time of the request |
| source_url | URL (the MAP_KEY is replaced by `<MAP_KEY>`) |
| bronze_path | where the file was saved |
| record_count, file_size_bytes, sha256 | what was received |
| status | `success`, `empty` (valid file, no rows), `skipped_exists`, `not_available` (HTTP 404), `failed` |
| attempts, error_message | retries used, and the reason for a failure |

## Silver: `data/silver/detections/...parquet`

Grain: one row per source detection (exact duplicates removed).

| Column | Type | Meaning |
|---|---|---|
| detection_id | string | stable ID (SHA-1 of product, satellite, date, time, lat, lon) |
| source_instrument | string | MODIS / VIIRS |
| source_product, product_key | string | exact product name, and its config key |
| satellite | string | Terra, Aqua, S-NPP, NOAA-20, NOAA-21 |
| processing | string | SP (standard) / NRT (near real-time) |
| version | string | raw FIRMS version value |
| region | string | country, from the file name |
| acquisition_timestamp | timestamp UTC | from acq_date + acq_time |
| acq_date_utc | date | UTC date |
| local_solar_date, local_solar_hour | date, float | UTC + longitude/15 h |
| latitude, longitude | float | pixel centre, degrees |
| brightness_mir_k, brightness_tir_k | float | ~4 µm and ~11 µm brightness temperature, K |
| scan_km, track_km, pixel_area_km2 | float | pixel size |
| frp_mw | float | fire radiative power, MW |
| confidence_raw | string | original value (0–100 or l/n/h) |
| confidence_class | string | low / nominal / high (sensor-specific meaning) |
| daynight | string | D / N |
| fire_type | int (nullable) | 0 vegetation, 1 volcano, 2 static source, 3 offshore; null in NRT |
| source_file, source_row | string, int | Bronze file and line number (header = line 1) |
| ingestion_run_id | string | the run that downloaded the file |
| processing_version | string | Silver logic version |

`data/silver/_quarantine/<file>.parquet` holds the rejected rows exactly as read (all text), plus `reason` (`;`-separated) and `bronze_path`. The possible reasons:
- `missing_<field>`
- `invalid_latitude`, `invalid_longitude`
- `unparseable_acq_date`, `invalid_acq_time`
- `unknown_satellite_code`
- `invalid_confidence`, `invalid_frp`, `invalid_scan`, `invalid_track`, `invalid_<brightness field>`
- `invalid_daynight`, `invalid_type`
- `schema_missing_columns:<list>` (the whole file)

`data/silver/_quality/dq_report.csv` has one row per file per run:
- input, valid, rejected and duplicate counts
- invalid coordinates and timestamp failures
- missing values by field (JSON) and rejection reasons (JSON)
- missing, unexpected and optional-missing columns
- duration and status

## Analysis flags (computed in Gold, not stored in Silver)

- **Vegetation:** `fire_type` is 0 or null.
- **Static source:** the detection sits in a 0.01° cell (or one of its 8 neighbours) that had fire on more than `flags.static_days_per_year` (60) local days in one year.
- **Low confidence:** `confidence_class == "low"` (excluded only if `exclude_low_confidence: true`).

## Gold: `data/gold/current/`

### detection_matches.parquet (Step 6)
Grain: one row per matched pair, plus one row per unmatched detection.

| Column | Meaning |
|---|---|
| comparison_id | stable ID |
| modis_detection_id, viirs_detection_id | either can be null for `*_only` rows |
| match_status | `matched`, `candidate_unassigned`, `modis_only`, `viirs_only` (see `matching_methodology.md`) |
| distance_m, time_difference_seconds | for pairs |
| spatial_threshold_m, temporal_threshold_seconds | thresholds used for this row |
| n_candidates | number of candidate VIIRS detections for the MODIS detection |
| other_sensor_pass_evidence | the other sensor detected any fire within `pass_evidence_radius_km` in the time window |
| nearest_other_distance_m | nearest other-sensor detection in the time window |
| matching_rule_version, spatial_mode, comparison_run_id | how and when the row was made |

### candidate_pairs.parquet
Grain: every MODIS–VIIRS pair within the thresholds (many-to-many), for audit. It holds both IDs, the distance, the absolute and signed time difference (VIIRS − MODIS), and the thresholds.

### gold_detection_comparison.parquet
`detection_matches`, plus:
- acquisition_date, year_month, region
- MODIS and VIIRS raw confidence and confidence class
- MODIS and VIIRS FRP
- latitude/longitude (taken from MODIS when present)

### gold_hotspot_statistics.csv
Grain: region × year_month, comparison pair only (default Aqua vs S-NPP), comparison period only. Each detection counts in its own region and month.

| Metric | Formula |
|---|---|
| modis_detections, viirs_detections | compared detections |
| modis_with_candidate | MODIS detections with ≥ 1 candidate (`matched` or `candidate_unassigned`) |
| modis_only, viirs_only | no candidate |
| modis_only_with_viirs_pass / viirs_only_with_modis_pass | unmatched, but the other sensor was observing (see pass evidence) |
| viirs_matched | VIIRS detections assigned to a MODIS detection |
| matched_pairs | number of assigned pairs (= viirs_matched) |
| mean_pair_distance_m, median / p90_pair_time_difference_s | over matched pairs |
| **modis_match_rate_pct** | 100 × modis_with_candidate / modis_detections. **Denominator is MODIS**; empty when there are no MODIS detections |
| **viirs_match_rate_pct** | 100 × viirs_matched / viirs_detections. **Denominator is VIIRS** |
| modis_conf_*, viirs_conf_* | counts per confidence class |

### gold_regional_fire_trends.parquet
Grain: grid cell × year_month × instrument × satellite. Covers all analysis detections, not only the comparison pair.

| Column | Meaning |
|---|---|
| cell_id, cell_lat, cell_lon, region, year_month, instrument, satellite | keys |
| detection_count | detections |
| fire_days | distinct local days with fire |
| frp_sum_mw | sum of FRP |
| compared_count, matched_count, unmatched_count | detections that took part in matching, and how many matched / did not |

### matching_sensitivity.csv
Grain: spatial threshold × temporal threshold (fixed mode). Columns:
- candidate_pairs
- modis_with_candidate_pct, viirs_with_candidate_pct
- median_distance_m

### calendar/ (harmonized calendar; full details in the README of `firms_harmonize`)
- **calendar.json:** for the frontend. Daily rows are `[date, harmonized, modis_fire_cells, viirs_fire_cells, frp_mw, source, percentile, level, frp_percentile, frp_level]`.
- **calendar_daily.csv:** the same as a table.
- **monthly_grid.csv / .json:** region, month, cell centre, fire_days, frp. This is the map layer.
- **cells_summary.json:** per-cell typical year (base map layer).
- **calibration_region_month.csv / calibration_region_year.csv:** VIIRS/MODIS ratios for counts and FRP.
- **validation.csv / validation_by_year.csv:** MODIS × ratio vs VIIRS, for the calibration and holdout periods.

### reconciliation.json and manifest.json
- **reconciliation.json:** true/false for each check that Gold agrees with Silver.
- **manifest.json:** run ID, config, row counts, comparison period, and whether reconciliation passed.

## AI: `data/gold/ai/<gold_run_id>/`
- **model_input.parquet:** one row per compared detection. Columns are listed in `model_input_schema.json`.
- **model_input_schema.json:** grain, split rule and counts, column descriptions, and the prediction output schema.

## Database (`firms` schema)
The tables mirror the Gold files. See `sql/migrations/001_initial_schema.sql` and `data_contracts.md`.
