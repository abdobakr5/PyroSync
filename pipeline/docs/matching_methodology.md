# Matching Methodology (Plan Steps 5–6)

Rule version: `match-1.0.0` (`config/pipeline.yaml → matching.rule_version`). Change the version whenever the rule or its defaults change.

## Which detections are compared

- **Pair:** Aqua MODIS vs S-NPP VIIRS. Both cross the equator at about 13:30 local solar time, so they see the same fires within minutes. Terra (about 10:30) is not paired by default, because a fire can start, grow or end in three hours. Satellites are configurable.
- **Period:** only full UTC days when both satellites were delivering data (S-NPP starts 20 Jan 2012).
- **Filters (configurable):**
  - vegetation fires only (`fire_type` 0 or missing)
  - static heat sources removed
  - low confidence kept by default
- These filters are analysis choices made in Gold. Silver keeps every valid row.

## Candidate pair

A MODIS detection *m* and a VIIRS detection *v* are a candidate pair when both of these hold:

1. **Great-circle distance** between the pixel centres ≤ spatial threshold.
2. **|time(v) − time(m)| ≤ temporal threshold.** The default is 1,200 s (20 min). The boundary is inclusive.

**Spatial threshold, `footprint` mode (default):**
- threshold = `footprint_factor × (½ diagonal of the MODIS pixel + ½ diagonal of the VIIRS pixel)`
- clipped to [750 m, 5,000 m]
- reason: a fire can be anywhere inside a pixel, and MODIS pixels grow from about 1 km at nadir to about 5 km × 2 km at the swath edge, so a fixed threshold would be too strict at the edge and too loose at nadir
- the pixel half-diagonal uses the `scan` and `track` sizes from FIRMS

**`fixed` mode:** one threshold (`fixed_threshold_m`, default 1,500 m).

**Search:** pixel centres are turned into 3-D unit vectors and indexed with a KD-tree, one tree per MODIS overpass time, covering only the VIIRS detections inside the time window. There is no full MODIS × VIIRS join. Distances are exact great-circle metres. Passes across midnight UTC are handled.

## Assignment (one-to-many, deterministic)

One MODIS pixel (≥ 1 km) covers several VIIRS pixels (375 m), so:
- a MODIS detection may be linked to **many** VIIRS detections
- each VIIRS detection is assigned to **at most one** MODIS detection
- the chosen one is the nearest; ties go to the smaller time difference, then the smaller `modis_detection_id`

The result does not depend on input order, and the same detection is never assigned two ways.

## Status of each detection

| Status | Meaning |
|---|---|
| `matched` | a VIIRS detection and the MODIS detection it was assigned to (one row per pair) |
| `candidate_unassigned` | a MODIS detection that had candidates, but every one of them was assigned to a nearer MODIS detection |
| `modis_only` | a MODIS detection with no VIIRS candidate |
| `viirs_only` | a VIIRS detection with no MODIS candidate |

Every compared detection appears in the output. Each VIIRS detection appears exactly once. Each MODIS detection appears once per assigned pair, or once with its non-matched status. Reconciliation checks enforce this on every run.

**Pass evidence.** FIRMS lists only fire pixels, so "no detection" can mean "looked and saw nothing" or "was not looking". For `*_only` rows, `other_sensor_pass_evidence = true` means the other sensor detected *some* fire within 1,000 km during the time window, so it was overhead. `false` means there is no evidence that it was observing at all; such rows should not be read as misses.

## How to read the results

- **A candidate match is not ground truth.** It means "close enough in space and time to plausibly be the same fire".
- **`modis_only` / `viirs_only` is not an error.** VIIRS sees smaller and cooler fires. MODIS can see a fire that is under thin cloud for VIIRS. Geolocation differs by hundreds of metres. Claims about detection accuracy need independent reference data (for example burned-area maps or field reports).
- **Confidence classes differ by sensor** and are not compared as equals.
- **Match rates have different denominators:** the MODIS-based rate uses MODIS detections, the VIIRS-based rate uses VIIRS detections. They are different numbers by design.

## Sensitivity

`matching_sensitivity.csv` recomputes the share of detections with a candidate for a grid of fixed thresholds:
- spatial: 750 / 1,500 / 3,000 / 5,000 m
- temporal: 300 / 600 / 1,200 / 2,400 s

If the match rate keeps rising strongly at large thresholds, the extra pairs are probably different fires (chance neighbours). A plateau suggests the threshold is wide enough. **Review this table on the real data with the AI Engineer before freezing the defaults.**

## Tests (tests/test_matching.py)

- distance and time boundaries (inclusive)
- equal-distance ties
- several VIIRS pixels inside one MODIS pixel
- two MODIS detections competing for one VIIRS detection (order-independent)
- a pass across midnight
- missing timestamps refused
- pass evidence
- footprint thresholds
- every detection kept
- sensitivity grows with the thresholds

Performance check: about 99k MODIS vs 714k VIIRS detections matched in about 40 s on one CPU.
