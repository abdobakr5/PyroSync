"""
PyroSync Backend — Application Layer (Use Cases)
Orchestrates domain rules and infrastructure repositories without coupling to HTTP transport.
"""
import csv
import io
from domain.models import (
    FrpTelemetryInput,
    MATCHING_RULE_VERSION,
    SPATIAL_METHODOLOGY,
)
from infrastructure.repository import PyroSyncDataRepository, repo


class PyroSyncApplicationService:
    """Application use-case coordinator for PyroSync analytical & ML operations."""

    def __init__(self, repository: PyroSyncDataRepository) -> None:
        self._repo = repository

    def get_health_status(self) -> dict:
        return {
            "status": "ok",
            "project": "PyroSync",
            "architecture": "Clean Architecture (Domain / Application / Infrastructure / Presentation)",
            "methodology": SPATIAL_METHODOLOGY,
            "matching_rule_version": MATCHING_RULE_VERSION,
            "ml_model_loaded": self._repo.frp_bundle is not None,
            "sql_schema": self._repo.get_sql_schema_summary(),
        }

    def get_metadata(self) -> dict:
        return {
            "calendar_meta": self._repo.calendar_data.get("meta", {}),
            "grid_meta": self._repo.monthly_grid.get("meta", {}),
            "summary_meta": self._repo.cells_summary.get("meta", {}),
            "regions": list(self._repo.calendar_data.get("regions", {}).keys()),
        }

    def get_region_calendar(self, region_name: str) -> dict | None:
        regions = self._repo.calendar_data.get("regions", {})
        return regions.get(region_name)

    def get_monthly_grid(self, year_month: str) -> dict | None:
        data = self._repo.monthly_grid.get("data", {})
        if year_month not in data:
            return None
        meta = self._repo.monthly_grid.get("meta", {})
        return {
            "year_month": year_month,
            "columns": meta.get("columns", []),
            "region_names": meta.get("region_names", []),
            "cells": data[year_month],
        }

    def get_cells_summary(self, min_fire_days: float = 0.1) -> dict:
        cells = self._repo.cells_summary.get("cells", [])
        filtered = [c for c in cells if c[3] >= min_fire_days]
        return {
            "meta": self._repo.cells_summary.get("meta", {}),
            "cells": filtered,
        }

    def get_gold_detection_insights(self, region: str = "Eastern Med (All)") -> dict | None:
        if not self._repo.gold_insights:
            return None
        regions = self._repo.gold_insights.get("regions", {})
        return {
            "schema": self._repo.gold_insights.get("schema"),
            "global_summary": self._repo.gold_insights.get("global_summary"),
            "spatial_resolution_proof": self._repo.gold_insights.get("spatial_resolution_proof"),
            "audit_and_validation": self._repo.gold_insights.get("audit_and_validation"),
            "distance_histogram": self._repo.gold_insights.get("distance_histogram"),
            "time_histogram": self._repo.gold_insights.get("time_histogram"),
            "feature_profiles": self._repo.gold_insights.get("feature_profiles"),
            "region_data": regions.get(region, regions.get("Eastern Med (All)")),
        }

    def get_country_stats(self, country: str | None = None, granularity: str = "yearly") -> dict:
        if granularity == "monthly":
            rows = self._repo.get_monthly_country_stats(country)
        else:
            rows = self._repo.get_yearly_country_stats(country)
        return {"granularity": granularity, "count": len(rows), "rows": rows}

    def get_clusters(self) -> dict:
        return self._repo.clusters

    def get_ai_insights(self) -> dict:
        return self._repo.ai_insights

    def predict_fire_intensity(self, telemetry: FrpTelemetryInput) -> dict:
        return self._repo.predict_frp(**telemetry.to_dict())

    def export_region_csv(self, region_name: str) -> str | None:
        regions = self._repo.calendar_data.get("regions", {})
        if region_name not in regions:
            return None
        region = regions[region_name]
        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(["region"] + self._repo.calendar_data["meta"]["daily_columns"])
        for row in region["daily"]:
            writer.writerow([region_name] + row)
        return output.getvalue()


service = PyroSyncApplicationService(repo)
