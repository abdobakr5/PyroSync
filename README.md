# PyroSync — Multi-Decadal NASA MODIS & VIIRS Fire Intelligence Platform

> **NASA Space Apps Challenge 2026**  
> *Synchronizing 25+ years of multi-sensor satellite thermal observations (MODIS 1 km & VIIRS 375 m) into a single, deduplicated, scientifically traceable record across the Eastern Mediterranean.*

---

## 1. Executive Summary & Problem Statement

For over two decades, NASA's Earth Observation fleet has monitored global wildfire activity through two distinct sensor generations:
- **MODIS (Terra & Aqua, 2000–present):** `~1 km` nadir pixel resolution, capturing long-term climate baselines.
- **VIIRS (Suomi-NPP, NOAA-20/21, 2012–present):** `~375 m` nadir pixel resolution, resolving smaller thermal features (`~7×` finer pixel area) with higher sensitivity.

### Why Raw Multi-Sensor Aggregation Fails
1. **The Artificial 2012 Step-Change:** Combining raw MODIS and VIIRS counts creates an illusion that fire frequency surged after 2012, when in reality VIIRS simply detects low-intensity fires (`<30 MW`) that MODIS misses.
2. **Same-Day Cross-Sensor Double Counting:** A single active wildfire is routinely observed multiple times on the same UTC day by Terra, Aqua, S-NPP, and NOAA-20.
3. **Detector Saturation & Fold-Over in Megafires:** During extreme crown fires, the VIIRS 375 m mid-infrared channel (`I4 / bright_ti4`) saturates and clips at **`367 K`**—or suffers **detector fold-over (`208 K`)** under extreme radiance—causing standard regression models to severely underestimate catastrophic wildfires.

**PyroSync** solves all three challenges through a **Footprint-Adaptive Medallion Data Pipeline**, a **3-Model LightGBM Physics-Aware AI Ensemble**, a **4-Layer Clean Architecture FastAPI Backend**, and an **Interactive 3D Globe & Role-Based Web Platform**.

---

## 2. System Architecture & Clean Architecture Design

PyroSync strictly enforces **Clean Architecture** and **Medallion Data Engineering** principles across four decoupled subsystems:

```text
PyroSync/
├── pipeline/                  # 1. Medallion ETL & Spatial Footprint Harmonization Engine
│   ├── config/                #    YAML pipeline & NASA FIRMS source definitions
│   ├── sql/                   #    PostgreSQL/SQLite DDL migrations & analytical queries
│   ├── src/                   #    Bronze -> Silver -> Gold harmonization & audit modules
│   └── tests/                 #    43 automated unit & reconciliation tests (pytest)
│
├── ai_ml/                     # 2. Physics-Aware AI / Machine Learning Suite
│   ├── prediction_viirs_improved.ipynb  # LightGBM 3-Model Blend training & evaluation
│   ├── frp_blend_model.pkl              # Trained 55-feature ensemble model artifact
│   ├── spatial_regime_clustering.py     # Spatial DBSCAN fire-complex & regime classifier
│   ├── forecast_and_classify.py         # Seasonal anomaly & overlap ratio engine
│   ├── process_gold_detection_and_ai.py # Gold feature-store processor
│   └── export_pyrosync_real_data.py     # Frontend Gold dataset exporter
│
├── backend/                   # 3. 4-Layer Clean Architecture FastAPI Server
│   ├── domain/                #    Pure entities, value objects & scientific constants
│   ├── application/           #    Use-case orchestration (PyroSyncApplicationService)
│   ├── infrastructure/        #    Parquet/JSON/CSV repositories & LightGBM inference
│   ├── presentation/          #    FastAPI HTTP controllers & streaming CSV endpoints
│   ├── sql/                   #    Database schema definitions
│   └── main.py                #    ASGI application entrypoint
│
├── frontend/                  # 4. React 19 + TypeScript + Three.js 3D Web Platform
│   ├── public/                #    Harmonized Gold JSON records, GeoJSON & 3D textures
│   └── src/                   #    Role views, 3D Globe, Anomaly UI, AI FRP Predictor
│
├── data/                      # 5. Medallion Data Lake (Bronze / Gold / Served JSONs)
│   ├── bronze_viirs_raw/                # 1.4M+ raw VIIRS S-NPP partitions (9 countries)
│   ├── gold_calendar_maps_and_stats/    # Daily calendar, monthly grids & audit proofs
│   └── gold_detection_level_and_ai/     # Matched pairs & ML feature store Parquets
```

---

## 3. Core Scientific & AI Innovations

### A. Footprint-Adaptive Sensor Harmonization (`match-1.1.0`)
Instead of using a fixed arbitrary radius that fails at swath edges, PyroSync computes the exact off-nadir footprint geometry (`scan × track`) of every MODIS and VIIRS detection:
- Pairs detections across sensors within a **`±60 minute` overpass window** and footprint-adaptive spatial threshold (`median match distance = 516.9 m`).
- Aggregates co-located detections on a **`~1 km` UTC-day analytical grid** using `max(FRP)` while retaining **100% of original NASA source IDs** (`Zero Black Boxes`).
- Enforces **"Missing is Never Zero"**: pre-2012 VIIRS coverage gaps are explicitly encoded as `unavailable` rather than `0`, preventing artificial distortion of long-term baselines.

### B. Three-Model AI Architecture
PyroSync integrates three complementary AI/statistical models answering **HOW STRONG**, **WHEN**, and **WHAT KIND**:

1. **Model 1 — `HOW STRONG`: LightGBM 3-Model VIIRS FRP Intensity Blend (`ai_ml/prediction_viirs_improved.ipynb`)**
   - Trained on **`1,405,427` VIIRS detections** across **9 Eastern Mediterranean countries** (`Greece, Turkey, Syria, Cyprus, Egypt, Lebanon, Israel, Jordan, Palestine`).
   - Engineers **55 physical & spatial features**, including **Stefan-Boltzmann 4th-power radiance proxies**, **`367 K` TI4 clipping flags**, **`208 K` detector fold-over correction**, and **same-overpass spatial cluster aggregates** (recovering M13 dual-gain co-located radiance).
   - Evaluates with **zero overpass leakage** via a **Stratified `(Country × Date)` Group Split** (`1,125,993` Train / `140,870` Val / `138,564` Test).
   - Blends **50% Weighted Tweedie (`p=1.35`) + 30% Weighted Log-L2 + 20% Raw-L2 Tail Specialist** (`up to 25×` extreme-fire weighting):

| Model / Pipeline (Test Set = 138,564 Detections) | RMSE (MW) | MAE (MW) | MedAE (MW) | R² (Raw) | R² (Log) | Extreme Bias (`FRP > 100 MW`) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Previous Baseline Pipeline** | `13.8957` | `3.3863` | `0.6365` | `0.4713` | `0.7526` | `-106.23 MW` |
| **Model A · Weighted Tweedie (`p=1.35`)** | `9.7948` | `2.6220` | `0.5515` | `0.5572` | `0.8034` | `-76.41 MW` |
| **Model B · Weighted Log-Target (`log1p`)** | `9.7276` | `2.3938` | `0.4904` | `0.5632` | `0.8317` | `-81.12 MW` |
| **Model C · Raw-L2 Tail Specialist** | `9.7608` | `2.6366` | `0.6049` | `0.5602` | `0.7927` | `-61.85 MW` |
| **PyroSync 3-Model Ensemble Blend** | **`9.6021`** | **`2.5047`** | **`0.5331`** | **`0.5744`** | **`0.8165`** | **`-72.97 MW` (-30.9% RMSE)** |

2. **Model 2 — `WHEN`: Seasonally-Matched Anomaly Intelligence (`frontend/src/anomaly.ts`)**
   - Benchmarks every ISO week and month against the **same seasonal window across the 2012–2023 VIIRS-era baseline** (excluding the evaluated year) using **Median % Change** and **MAD-based Robust Z-Scores** (`Normal` → `Elevated` → `Extreme`).

3. **Model 3 — `WHAT KIND & WHERE`: Spatial DBSCAN & Fire-Regime Classification (`ai_ml/spatial_regime_clustering.py`)**
   - Groups recurring fire cells (`0.1°` grid, `eps = 0.18°`) via spatial **DBSCAN** and physical persistence rules to separate **High-Intensity Forest Wildfires (`>110 MW`)** from **Small Agricultural / Crop-Residue Burns (`<30 MW`, VIIRS-dominated)**.

---

## 4. Platform Features & Role-Based Views

- **Multi-Role Intelligence Views:** Adapts KPIs and workflows for **Emergency Responders**, **Climate Scientists**, and **Land Managers**.
- **Interactive 3D Globe & 2D Map (`Explore Map`):** WebGL/Three.js globe with bounding-box spatial filtering, match-type/regime color encoding, Admin-0/Admin-1 reverse geocoding, and a full **Observation Inspector** tracing every event to its NASA MODIS & VIIRS source IDs.
- **4-Step Harmonization Grid & Pixel Footprint Explorer (`Overview`):** Interactive visual proof of `1 km` cell fusion and off-nadir satellite pixel stretching (`0°` to `55°` scan angle).
- **Live AI VIIRS High-FRP Intensity Predictor (`Overview` & `Anomaly Intelligence`):** Real-time telemetry controls connected to `GET /api/predict-frp` (with embedded client-side fallback for static cloud hosting) and one-click synchronization with any selected fire on the 3D Globe.
- **Thermal History Matrix & Seasonal Risk Curve:** 26-year heatmap (`Year × Month / ISO Week`) and 52-week normalized climatological risk curve.
- **Scientific Export Engine (`Data Explorer`):** Exports filtered harmonized or raw records to **CSV** alongside an automated **Dataset Provenance Brief (`.txt`)**.

---

## 5. Quickstart & Installation

### Prerequisites
- **Python:** `3.11+`
- **Node.js:** `20+`

### 1. Install Python Dependencies & Run Backend (`Port 8000`)
```bash
pip install -r requirements.txt
cd backend
python -m uvicorn main:app --host 127.0.0.1 --port 8000 --reload
```
- **API Health Check:** `http://127.0.0.1:8000/api/health`
- **Interactive Swagger UI:** `http://127.0.0.1:8000/docs`
- **Live ML Inference Endpoint:** `http://127.0.0.1:8000/api/predict-frp?country=Greece&bright_ti4=367&bright_ti5=334&cluster_size=14`

### 2. Install Frontend Dependencies & Launch Web Platform (`Port 5173`)
```bash
cd frontend
npm install
npm run dev -- --port 5173
```
- Open **`http://localhost:5173`** in your browser.

### 3. Run the Automated Test Suites
```bash
# 1. Data Pipeline & Scientific Reconciliation Tests (42 passed)
cd pipeline
python -m pytest -v

# 2. Frontend Unit & Formula Verification Tests (21 passed)
cd ../frontend
npm test

# 3. TypeScript & Production Build Check
npx tsc --noEmit
npm run build
```

---

## 6. Clean Architecture REST API Reference

| Method | Endpoint | Layer / Use Case Description |
| :---: | :--- | :--- |
| `GET` | `/api/health` | Returns Clean Architecture health status, matching rule version (`match-1.1.0`), ML model readiness, and SQL schema metadata. |
| `GET` | `/api/meta` | Returns metadata and available regions across the Gold calendar, grid, and cell summary tables. |
| `GET` | `/api/predict-frp` | Runs live inference on the 55-feature **LightGBM 3-Model Ensemble** (`frp_blend_model.pkl`) and returns individual model predictions + physics diagnostics. |
| `GET` | `/api/gold-detection-insights` | Returns cross-sensor distance/time histograms, FRP calibration metrics, and reconciliation proofs. |
| `GET` | `/api/clusters` | Returns spatial DBSCAN fire complexes and classified fire regimes across the Eastern Mediterranean. |
| `GET` | `/api/ai-insights` | Returns regional VIIRS-to-MODIS overlap ratios and top extreme fire wave classifications. |
| `GET` | `/api/region/{region_name}` | Returns the 2003–2025 daily harmonized time series and anomaly scores for a specific country/region. |
| `GET` | `/api/map-grid/{year_month}` | Returns active `0.1°` grid cells for a given `YYYY-MM`. |
| `GET` | `/api/cells-summary` | Returns multi-decadal persistent fire cell summaries filtered by `min_fire_days`. |
| `GET` | `/api/country-stats` | Returns yearly or monthly country-level statistics (`?country=Greece&granularity=monthly`). |
| `GET` | `/api/export-csv/{region_name}` | Streams a downloadable harmonized CSV for the requested region. |

---

## 7. Scientific Disclaimer
PyroSync is an independent scientific intelligence platform created for the **NASA Space Apps Challenge 2026** using public NASA FIRMS MODIS and VIIRS archives. It is not an official NASA product and should not be used as a substitute for local emergency evacuation directives.
