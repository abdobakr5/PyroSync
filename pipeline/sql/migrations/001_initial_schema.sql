-- Step 8 - PostgreSQL/PostGIS schema. Applied once by src/database/publish.py (tracked in schema_migrations).
-- All geometries are WGS84 lon/lat (SRID 4326), built from the latitude/longitude columns.
-- Ownership: Data Engineering writes these tables; Backend reads them (and the views).

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE SCHEMA IF NOT EXISTS firms;

CREATE TABLE IF NOT EXISTS firms.pipeline_runs (
    run_id        text PRIMARY KEY,
    stage         text NOT NULL,
    status        text NOT NULL,          -- success | failed
    started_at    timestamptz,
    finished_at   timestamptz,
    details       jsonb,
    error_message text
);

-- Silver detections, both instruments in one table (plan Step 8 allows a unified table with an instrument field)
CREATE TABLE IF NOT EXISTS firms.detections (
    detection_id          text PRIMARY KEY,
    source_instrument     text NOT NULL CHECK (source_instrument IN ('MODIS', 'VIIRS')),
    source_product        text NOT NULL,
    product_key           text NOT NULL,
    satellite             text NOT NULL,
    processing            text NOT NULL,   -- SP | NRT
    version               text,
    region                text NOT NULL,
    acquisition_timestamp timestamptz NOT NULL,
    acq_date_utc          date NOT NULL,
    local_solar_date      date NOT NULL,
    local_solar_hour      real,
    latitude              double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
    longitude             double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
    brightness_mir_k      real,
    brightness_tir_k      real,
    scan_km               real,
    track_km              real,
    pixel_area_km2        real,
    frp_mw                real,
    confidence_raw        text,
    confidence_class      text,
    daynight              text,
    fire_type             smallint,
    source_file           text,
    source_row            integer,
    ingestion_run_id      text,
    processing_version    text,
    published_run_id      text,
    geom geometry(Point, 4326) GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)) STORED
);
CREATE INDEX IF NOT EXISTS detections_geom_gix ON firms.detections USING gist (geom);
CREATE INDEX IF NOT EXISTS detections_time_idx ON firms.detections (acquisition_timestamp);
CREATE INDEX IF NOT EXISTS detections_inst_date_idx ON firms.detections (source_instrument, acq_date_utc);
CREATE INDEX IF NOT EXISTS detections_region_date_idx ON firms.detections (region, local_solar_date);

CREATE TABLE IF NOT EXISTS firms.detection_comparisons (
    comparison_id              text PRIMARY KEY,
    modis_detection_id         text,
    viirs_detection_id         text,
    match_status               text NOT NULL CHECK (match_status IN ('matched', 'candidate_unassigned', 'modis_only', 'viirs_only')),
    distance_m                 real,
    time_difference_seconds    integer,
    spatial_threshold_m        real,
    temporal_threshold_seconds integer,
    n_candidates               integer,
    other_sensor_pass_evidence boolean,
    nearest_other_distance_m   real,
    matching_rule_version      text NOT NULL,
    spatial_mode               text,
    comparison_run_id          text NOT NULL,
    acquisition_date           date,
    year_month                 text,
    region                     text,
    modis_confidence_raw       text,
    modis_confidence_class     text,
    viirs_confidence_raw       text,
    viirs_confidence_class     text,
    modis_frp_mw               real,
    viirs_frp_mw               real,
    latitude                   double precision,
    longitude                  double precision,
    geom geometry(Point, 4326) GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)) STORED,
    CHECK (modis_detection_id IS NOT NULL OR viirs_detection_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS comparisons_geom_gix ON firms.detection_comparisons USING gist (geom);
CREATE INDEX IF NOT EXISTS comparisons_date_status_idx ON firms.detection_comparisons (acquisition_date, match_status);
CREATE INDEX IF NOT EXISTS comparisons_modis_idx ON firms.detection_comparisons (modis_detection_id);
CREATE INDEX IF NOT EXISTS comparisons_viirs_idx ON firms.detection_comparisons (viirs_detection_id);

CREATE TABLE IF NOT EXISTS firms.hotspot_statistics (
    region                        text NOT NULL,
    year_month                    text NOT NULL,
    modis_detections              integer NOT NULL,
    viirs_detections              integer NOT NULL,
    modis_with_candidate          integer NOT NULL,
    modis_only                    integer NOT NULL,
    modis_only_with_viirs_pass    integer NOT NULL,
    viirs_matched                 integer NOT NULL,
    viirs_only                    integer NOT NULL,
    viirs_only_with_modis_pass    integer NOT NULL,
    matched_pairs                 integer NOT NULL,
    mean_pair_distance_m          real,
    median_pair_time_difference_s real,
    p90_pair_time_difference_s    real,
    modis_match_rate_pct          real,
    viirs_match_rate_pct          real,
    modis_conf_low integer, viirs_conf_low integer, modis_conf_nominal integer,
    viirs_conf_nominal integer, modis_conf_high integer, viirs_conf_high integer,
    PRIMARY KEY (region, year_month)
);

CREATE TABLE IF NOT EXISTS firms.regional_fire_trends (
    cell_id         text NOT NULL,
    cell_lat        double precision NOT NULL,
    cell_lon        double precision NOT NULL,
    region          text NOT NULL,
    year_month      text NOT NULL,
    instrument      text NOT NULL,
    satellite       text NOT NULL,
    detection_count integer NOT NULL,
    fire_days       integer NOT NULL,
    frp_sum_mw      real,
    compared_count  integer NOT NULL,
    matched_count   integer NOT NULL,
    unmatched_count integer NOT NULL,
    grid_deg        real NOT NULL,
    geom geometry(Polygon, 4326) GENERATED ALWAYS AS (
        ST_MakeEnvelope(cell_lon - grid_deg / 2, cell_lat - grid_deg / 2, cell_lon + grid_deg / 2, cell_lat + grid_deg / 2, 4326)) STORED,
    PRIMARY KEY (cell_id, region, year_month, instrument, satellite)
);
CREATE INDEX IF NOT EXISTS trends_geom_gix ON firms.regional_fire_trends USING gist (geom);
CREATE INDEX IF NOT EXISTS trends_month_idx ON firms.regional_fire_trends (year_month, region);

-- Harmonized calendar (the challenge deliverable)
CREATE TABLE IF NOT EXISTS firms.fire_calendar_daily (
    region           text NOT NULL,
    date             date NOT NULL,
    harmonized       real NOT NULL,
    modis_fire_cells integer NOT NULL,
    viirs_fire_cells integer NOT NULL,
    frp_mw           real,
    source           text NOT NULL,
    percentile       real,
    level            text,
    frp_percentile   real,
    frp_level        text,
    PRIMARY KEY (region, date)
);

CREATE TABLE IF NOT EXISTS firms.monthly_grid (
    region     text NOT NULL,
    year_month text NOT NULL,
    cell_lat   double precision NOT NULL,
    cell_lon   double precision NOT NULL,
    fire_days  real NOT NULL,
    frp_sum    real,
    grid_deg   real NOT NULL,
    geom geometry(Polygon, 4326) GENERATED ALWAYS AS (
        ST_MakeEnvelope(cell_lon - grid_deg / 2, cell_lat - grid_deg / 2, cell_lon + grid_deg / 2, cell_lat + grid_deg / 2, 4326)) STORED,
    PRIMARY KEY (region, year_month, cell_lat, cell_lon)
);
CREATE INDEX IF NOT EXISTS monthly_grid_geom_gix ON firms.monthly_grid USING gist (geom);

CREATE TABLE IF NOT EXISTS firms.calibration_ratios (
    region           text NOT NULL,
    month            smallint NOT NULL,
    modis_fire_cells real,
    viirs_fire_cells real,
    modis_frp_sum    real,
    viirs_frp_sum    real,
    ratio            real,
    method           text,
    frp_ratio        real,
    PRIMARY KEY (region, month)
);

CREATE TABLE IF NOT EXISTS firms.calendar_validation (
    region               text NOT NULL,
    period               text NOT NULL,
    months               integer,
    r_monthly            real,
    pred_over_actual     real,
    r_monthly_frp        real,
    pred_over_actual_frp real,
    PRIMARY KEY (region, period)
);

-- Views for common application queries
CREATE OR REPLACE VIEW firms.v_fire_calendar AS
SELECT c.*,
       CASE WHEN array_position(ARRAY['none','low','normal','elevated','high','extreme'], c.frp_level)
               > array_position(ARRAY['none','low','normal','elevated','high','extreme'], c.level)
            THEN c.frp_level ELSE c.level END AS combined_level
FROM firms.fire_calendar_daily c;

CREATE OR REPLACE VIEW firms.v_comparison_summary AS
SELECT region, year_month, modis_detections, viirs_detections, matched_pairs, modis_only, viirs_only,
       modis_match_rate_pct, viirs_match_rate_pct
FROM firms.hotspot_statistics;
