"""Step 5 - Geographic and time calculations.

Coordinates: WGS84 latitude/longitude in decimal degrees (EPSG:4326), as delivered by FIRMS.
Distances are great-circle (haversine) on a sphere with the IUGG mean Earth radius. Over the few km used
for matching, the difference from the WGS84 ellipsoid (pyproj.Geod) is below 0.5%. Degrees are never
treated as planar metres.
"""
from __future__ import annotations

import numpy as np

EARTH_RADIUS_M = 6_371_008.8


def haversine_m(lat1, lon1, lat2, lon2):
    lat1, lon1, lat2, lon2 = map(np.radians, (lat1, lon1, lat2, lon2))
    a = np.sin((lat2 - lat1) / 2) ** 2 + np.cos(lat1) * np.cos(lat2) * np.sin((lon2 - lon1) / 2) ** 2
    return 2 * EARTH_RADIUS_M * np.arcsin(np.sqrt(np.clip(a, 0, 1)))


def to_unit_xyz(lat, lon) -> np.ndarray:
    """3-D unit vectors, so a KD-tree can index points on the sphere without longitude wrap problems."""
    la, lo = np.radians(np.asarray(lat, float)), np.radians(np.asarray(lon, float))
    return np.column_stack([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)])


def chord_for_distance(distance_m: float) -> float:
    """Straight-line distance between two unit vectors that are distance_m apart on the surface."""
    return 2 * np.sin(np.asarray(distance_m) / (2 * EARTH_RADIUS_M))


def pixel_half_diagonal_m(scan_km, track_km):
    """Half of the pixel diagonal in metres: the farthest a fire can be from its pixel centre."""
    return 500.0 * np.sqrt(np.asarray(scan_km, float) ** 2 + np.asarray(track_km, float) ** 2)


def cell_index(lat, lon, grid_deg: float):
    """Integer grid indices and the cell centre for a regular lat/lon grid."""
    i = np.floor(np.asarray(lat, float) / grid_deg).astype(np.int64)
    j = np.floor(np.asarray(lon, float) / grid_deg).astype(np.int64)
    return i, j, np.round(i * grid_deg + grid_deg / 2, 4), np.round(j * grid_deg + grid_deg / 2, 4)


def footprint_wkt(lat: float, lon: float, scan_km: float, track_km: float) -> str:
    """Approximate pixel footprint as an axis-aligned box (scan along longitude, track along latitude).
    Good enough for display; real footprints are rotated with the orbit."""
    dlat = track_km / 2 / 111.32
    dlon = scan_km / 2 / (111.32 * max(np.cos(np.radians(lat)), 1e-6))
    pts = [(lon - dlon, lat - dlat), (lon + dlon, lat - dlat), (lon + dlon, lat + dlat), (lon - dlon, lat + dlat),
           (lon - dlon, lat - dlat)]
    return "POLYGON((" + ", ".join(f"{x:.6f} {y:.6f}" for x, y in pts) + "))"
