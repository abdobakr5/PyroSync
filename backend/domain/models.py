"""
PyroSync Backend — Domain Layer
Pure domain entities, value objects, and scientific constants with zero external dependencies.
"""
from dataclasses import dataclass, asdict

GOLD_MATCH_STATUSES = ("matched", "candidate_unassigned", "modis_only", "viirs_only")
SPATIAL_METHODOLOGY = "Spatial Resolution of the Satellite (footprint-adaptive)"
MATCHING_RULE_VERSION = "match-1.1.0"
SUPPORTED_COUNTRIES = (
    "Cyprus",
    "Egypt",
    "Greece",
    "Israel",
    "Jordan",
    "Lebanon",
    "Palestine",
    "Syria",
    "Turkey",
)


@dataclass(frozen=True)
class FrpTelemetryInput:
    """Domain value object representing VIIRS sensor telemetry for a fire detection."""
    latitude: float = 38.18
    longitude: float = 23.83
    bright_ti4: float = 356.0
    bright_ti5: float = 314.0
    scan: float = 0.46
    track: float = 0.45
    hour: float = 12.5
    month: int = 8
    confidence: str = "h"
    country: str = "Greece"
    cluster_size: int = 4
    saturated_neighbors: int = 2

    def to_dict(self) -> dict:
        return asdict(self)


def classify_frp_severity_tier(frp_mw: float) -> str:
    """Domain rule mapping Fire Radiative Power (MW) to operational severity tiers."""
    if frp_mw >= 100.0:
        return "Extreme Megafire (>100 MW)"
    if frp_mw >= 30.0:
        return "High Intensity (30–100 MW)"
    if frp_mw >= 10.0:
        return "Moderate Intensity (10–30 MW)"
    return "Low / Nominal (<10 MW)"
