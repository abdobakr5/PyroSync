"""
PyroSync Backend — Presentation Layer (FastAPI HTTP Controllers)
Thin HTTP adapter delegating business logic to the Application Layer (`PyroSyncApplicationService`).
"""
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from domain.models import FrpTelemetryInput
from application.services import service

router = APIRouter()


@router.get("/api/health")
def health_check():
    return service.get_health_status()


@router.get("/api/meta")
def get_meta():
    return service.get_metadata()


@router.get("/api/region/{region_name}")
def get_region_calendar(region_name: str):
    result = service.get_region_calendar(region_name)
    if result is None:
        raise HTTPException(status_code=404, detail=f"Region {region_name} not found")
    return result


@router.get("/api/map-grid/{year_month}")
def get_monthly_grid(year_month: str):
    result = service.get_monthly_grid(year_month)
    if result is None:
        raise HTTPException(status_code=404, detail=f"Month {year_month} not found")
    return result


@router.get("/api/cells-summary")
def get_cells_summary(min_fire_days: float = 0.1):
    return service.get_cells_summary(min_fire_days=min_fire_days)


@router.get("/api/gold-detection-insights")
def get_gold_detection_insights(region: str = "Eastern Med (All)"):
    result = service.get_gold_detection_insights(region=region)
    if result is None:
        raise HTTPException(status_code=404, detail="gold_detection_insights.json not generated yet")
    return result


@router.get("/api/country-stats")
def get_country_stats(country: str | None = None, granularity: str = "yearly"):
    return service.get_country_stats(country=country, granularity=granularity)


@router.get("/api/clusters")
def get_clusters():
    return service.get_clusters()


@router.get("/api/ai-insights")
def get_ai_insights():
    return service.get_ai_insights()


@router.get("/api/predict-frp")
def predict_frp_get(
    latitude: float = 38.18,
    longitude: float = 23.83,
    bright_ti4: float = 356.0,
    bright_ti5: float = 314.0,
    scan: float = 0.46,
    track: float = 0.45,
    hour: float = 12.5,
    month: int = 8,
    confidence: str = "h",
    country: str = "Greece",
    cluster_size: int = 4,
    saturated_neighbors: int = 2,
):
    telemetry = FrpTelemetryInput(
        latitude=latitude,
        longitude=longitude,
        bright_ti4=bright_ti4,
        bright_ti5=bright_ti5,
        scan=scan,
        track=track,
        hour=hour,
        month=month,
        confidence=confidence,
        country=country,
        cluster_size=cluster_size,
        saturated_neighbors=saturated_neighbors,
    )
    return service.predict_fire_intensity(telemetry)


@router.get("/api/export-csv/{region_name}")
def export_region_csv(region_name: str):
    csv_content = service.export_region_csv(region_name)
    if csv_content is None:
        raise HTTPException(status_code=404, detail=f"Region {region_name} not found")

    return StreamingResponse(
        iter([csv_content]),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename=PyroSync_{region_name}.csv"},
    )
