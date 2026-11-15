# Source Specification (Plan Step 1)

## Products used

| Key (config) | Instrument | Product | Satellites | Coverage | Access |
|---|---|---|---|---|---|
| `modis_sp` | MODIS | Collection 6.1 active fire (MCD14ML), FIRMS standard processing | Terra, Aqua | Terra from Nov 2000, Aqua from Jul 2002 | Yearly country CSV |
| `viirs_snpp_sp` | VIIRS | S-NPP 375 m active fire (VNP14IMG, collection 2), standard processing | S-NPP | 20 Jan 2012 → (delivery ends Nov 2026) | Yearly country CSV |
| `viirs_noaa20_sp` | VIIRS | NOAA-20 375 m active fire (VJ114IMG, collection 2), standard processing | NOAA-20 | 1 Apr 2018 → | Yearly country CSV |
| `modis_nrt` | MODIS | C6.1 near real-time (MCD14DL) | Terra, Aqua | recent days | Area API |
| `viirs_noaa20_nrt` | VIIRS | NOAA-20 NRT (VJ114IMGTDL_NRT) | NOAA-20 | recent days | Area API |
| `viirs_noaa21_nrt` | VIIRS | NOAA-21 NRT (VJ214IMGTDL_NRT) | NOAA-21 | recent days | Area API |

**Science quality vs near real-time.** History uses standard processing (SP): NASA's reprocessed, science-quality files. NRT data is for recent days only, and is replaced by SP when it becomes available. The pipeline keeps both: if a satellite has SP data for a day, its NRT rows for that day are dropped in the calendar stage.

**Source of truth.** NASA FIRMS (https://firms.modaps.eosdis.nasa.gov/), its "Active Fire Data" attribute pages for MODIS and VIIRS, and the FIRMS API documentation (https://firms.modaps.eosdis.nasa.gov/content/academy/data_api/firms_api_use.html).

## Access, limits, licence

| Item | Country archive | Area API |
|---|---|---|
| URL | `https://firms.modaps.eosdis.nasa.gov/data/country/{dir}/{year}/{dir}_{year}_{Country}.csv` | `https://firms.modaps.eosdis.nasa.gov/api/area/csv/{MAP_KEY}/{SOURCE}/{w},{s},{e},{n}/{days}/{date}` |
| Authentication | none | free MAP_KEY (env var `FIRMS_MAP_KEY`) |
| Limits | none stated; the pipeline uses 4 parallel downloads | 5,000 transactions per 10 minutes per MAP_KEY. The number of days per request is limited (check the current API docs); default `chunk_days: 5` |
| Format | CSV | CSV |
| Missing file | HTTP 404 = no file for that country/year (logged as `not_available`) | empty CSV = no fires |
| Update | yearly SP files are added in batches, months after the year ends | NRT appears within hours of the overpass |

**Licence / attribution (must appear in the app):** "We acknowledge the use of data and/or imagery from NASA's Fire Information for Resource Management System (FIRMS) (https://earthdata.nasa.gov/firms), part of NASA's Earth Science Data and Information System (ESDIS)." The same text is in `config/sources.yaml`.

**Important change (Nov 2026):** the FIRMS website says S-NPP data delivery ceases on 2 November 2026 and users should move to NOAA-20 / NOAA-21. S-NPP is still the best VIIRS record for 2012–2025 (the only one covering the whole overlap with MODIS). New data from 2026 on needs NOAA-20 / NOAA-21.

## Fields (both products)

| Field | MODIS | VIIRS | Unit / values | Notes |
|---|---|---|---|---|
| `latitude`, `longitude` | ✓ | ✓ | decimal degrees, WGS84 (EPSG:4326) | centre of the fire pixel, not the exact fire position |
| `brightness` / `bright_ti4` | ch 21/22 (~4 µm) | I-4 (~4 µm) | Kelvin | VIIRS I-4 saturates at about 367 K on strong fires |
| `bright_t31` / `bright_ti5` | ch 31 (~11 µm) | I-5 (~11 µm) | Kelvin | mostly background temperature |
| `scan`, `track` | ✓ | ✓ | km | real pixel size. MODIS ~1 km at nadir, up to ~4.8 × 2 km at the swath edge. VIIRS 0.375 km at nadir, ~0.8 km at the edge |
| `acq_date` | ✓ | ✓ | `YYYY-MM-DD`, **UTC** | |
| `acq_time` | ✓ | ✓ | `HHMM`, **UTC**, minute precision | can arrive without leading zeros (`905`) |
| `satellite` | `Terra`/`Aqua` (also `T`/`A`) | `N` (S-NPP), `N20`/`1` (NOAA-20), `N21`/`2` (NOAA-21) | code | mapped to one name in Silver |
| `instrument` | `MODIS` | `VIIRS` | text | |
| `confidence` | 0–100 | `l` / `n` / `h` | | **not equivalent between sensors** (see below) |
| `version` | e.g. `6.03`, `6.2` (SP), `6.1NRT` | e.g. `2` (SP), `2.0NRT` | text | contains `NRT` for near-real-time rows |
| `frp` | ✓ | ✓ | MW | fire radiative power of the pixel |
| `daynight` | ✓ | ✓ | `D` / `N` | |
| `type` | ✓ | ✓ | 0 vegetation fire, 1 active volcano, 2 other static land source, 3 offshore | **SP files only**; missing in NRT |

**Confidence.** MODIS gives a number. The MODIS user guide groups it as low (0–29), nominal (30–79) and high (80–100). VIIRS gives a class directly: low is often sun glint or a weak signal, high is a saturated pixel. The pipeline keeps the raw value (`confidence_raw`) and adds `confidence_class` on the common low/nominal/high scale. The classes are a convenience for filtering. They do **not** mean the two sensors are equally certain.

## Region and dates

- **Region:** Cyprus, Egypt, Greece, Israel, Jordan, Lebanon, Palestine, Syria, Turkey (`config/pipeline.yaml`).
- **Dates:** MODIS 2000–2025, VIIRS S-NPP 2012–2025, NOAA-20 2018–2025. NRT optional.
- **First development dataset:** any one country and year, for example `--countries Greece --start-year 2021 --end-year 2021`.
- **Reference size** (full region, observed on 12 Nov 2026): 432 files, 201 MB, 2,550,672 rows. About 600,000 of these are non-vegetation (`type` ≠ 0), mostly gas flares in Egypt and the Gulf of Suez.

## Known limitations that affect comparison

- **Pixel size.** MODIS 1 km vs VIIRS 375 m, so VIIRS detects more and smaller fires. Raw counts are not comparable.
- **Overpass time.** Aqua and S-NPP cross at about 13:30 local time and can be compared directly. Terra crosses at about 10:30 and sees a different part of the daily fire cycle.
- **Orbit drift.** Terra and Aqua orbits drift after about 2021 (crossing times change), and NASA plans to end both missions in late 2026 / early 2027.
- **Fires only.** The files list only pixels with fire. There are no "observed, no fire" records, so when one sensor has no detection, you cannot tell whether it looked and saw nothing or did not look at all.
- **Static heat sources.** These are labelled by `type` in SP data only. The pipeline adds its own static-site rule.
