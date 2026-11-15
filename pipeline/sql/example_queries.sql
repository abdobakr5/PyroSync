-- Step 8 - Example queries for the Backend team. Parameters are shown as :name.
-- Every query here was run against the published test database.

-- 1. Fire calendar for one country and year (main calendar screen)
SELECT date, harmonized, frp_mw, source, percentile, level, frp_percentile, frp_level, combined_level
FROM firms.v_fire_calendar
WHERE region = :region AND date BETWEEN make_date(:year, 1, 1) AND make_date(:year, 12, 31)
ORDER BY date;

-- 2. Map layer: grid cells for one month as GeoJSON features (month slider)
SELECT json_build_object('type', 'FeatureCollection', 'features', coalesce(json_agg(json_build_object(
         'type', 'Feature', 'geometry', ST_AsGeoJSON(geom)::json,
         'properties', json_build_object('region', region, 'fire_days', fire_days, 'frp_mw', frp_sum))), '[]'::json))
FROM firms.monthly_grid
WHERE year_month = :year_month;

-- 3. Detections inside a map bounding box and date range (uses the spatial index), paginated
SELECT detection_id, source_instrument, satellite, acquisition_timestamp, latitude, longitude, frp_mw, confidence_class
FROM firms.detections
WHERE geom && ST_MakeEnvelope(:west, :south, :east, :north, 4326)
  AND acquisition_timestamp >= :start_ts AND acquisition_timestamp < :end_ts
ORDER BY acquisition_timestamp, detection_id
LIMIT :page_size OFFSET :offset;

-- 4. MODIS vs VIIRS comparison results near a point (within 25 km), with match status filter
SELECT comparison_id, match_status, modis_detection_id, viirs_detection_id, distance_m, time_difference_seconds,
       other_sensor_pass_evidence, acquisition_date
FROM firms.detection_comparisons
WHERE ST_DWithin(geom::geography, ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)::geography, 25000)
  AND match_status = ANY(:statuses)
  AND acquisition_date BETWEEN :start_date AND :end_date
ORDER BY acquisition_date
LIMIT 500;

-- 5. Monthly comparison statistics for a country (charts)
SELECT year_month, modis_detections, viirs_detections, matched_pairs, modis_only, viirs_only,
       modis_match_rate_pct, viirs_match_rate_pct
FROM firms.v_comparison_summary
WHERE region = :region
ORDER BY year_month;

-- 6. Worst days on record for a country (risk periods list)
SELECT date, harmonized, frp_mw, level, frp_level
FROM firms.v_fire_calendar
WHERE region = :region AND combined_level IN ('high', 'extreme')
ORDER BY frp_mw DESC NULLS LAST
LIMIT 20;

-- 7. Trust panel: how well the harmonization holds per country
SELECT region, period, r_monthly, pred_over_actual, r_monthly_frp, pred_over_actual_frp
FROM firms.calendar_validation
ORDER BY region, period;

-- 8. Data freshness: last successful publication
SELECT run_id, finished_at, details->>'gold_run_id' AS gold_run_id
FROM firms.pipeline_runs
WHERE stage = 'publish' AND status = 'success'
ORDER BY finished_at DESC
LIMIT 1;
