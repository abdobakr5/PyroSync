# Operations Runbook (Plan Steps 10–11)

## Setup

```bash
python -m venv .venv
.venv\Scripts\activate          # Windows   (Linux/macOS: source .venv/bin/activate)
pip install -r requirements.txt
copy .env.example .env          # then edit .env (Linux/macOS: cp)
```

`.env` needs:
- `FIRMS_MAP_KEY`: only for NRT data. Get a free key at https://firms.modaps.eosdis.nasa.gov/api/map_key/
- `DATABASE_URL`: only for the `publish` stage.

## Run

| Task | Command |
|---|---|
| Full history (default stages: ingest, silver, gold, ai) | `python -m src.orchestration.workflow run` |
| Small first test | `python -m src.orchestration.workflow run --countries Greece --start-year 2021 --end-year 2021` |
| Backfill some years / countries | `... run --start-year 2015 --end-year 2018 --countries Turkey,Syria` |
| Add recent NRT days | `... run --nrt` (needs `FIRMS_MAP_KEY`) |
| Rebuild Gold after changing thresholds | `... run --stages gold,ai` |
| Load into PostGIS | `... run --stages publish` |
| Force re-download / re-processing | add `--refresh` |
| Status of recent runs + monitoring | `python -m src.orchestration.workflow status` |
| Tests | `pytest -q` (set `DATABASE_URL` to include the database test) |

The first full run downloads about 200 MB. Each stage after that takes minutes on a laptop.

## Schedule

The yearly SP files change rarely, so run monthly. NRT can run daily.
- **Windows Task Scheduler:** Action = `C:\path\.venv\Scripts\python.exe`, Arguments = `-m src.orchestration.workflow run --nrt --stages ingest,silver,gold,ai,publish`, Start in = the repository folder.
- **Linux cron:** `0 6 * * * cd /path/repo && .venv/bin/python -m src.orchestration.workflow run --nrt --stages ingest,silver,gold,ai,publish >> data/_runs/cron.log 2>&1`

Airflow or Prefect can call the same stage functions if the project later needs a scheduler with a UI. Don't add one before it is needed (plan Step 16).

## What happens when something fails

| Failure | What the pipeline does | What you do |
|---|---|---|
| A download fails (timeout, 5xx) | retries 4 times with backoff. If it still fails, the row is `failed` in the ingestion log and the run stops before Silver | rerun later (finished files are skipped), or use `--allow-partial` to continue with what arrived |
| FIRMS has no file (404) | `not_available`, not an error (no fires in that country/year, or not published yet) | nothing |
| A file has a changed schema | the whole file is quarantined (`schema_error`) and the run stops | check FIRMS release notes, update `src/validation/checks.py`, bump `silver.processing_version`, rerun |
| Bad rows | quarantined with a reason; the rest continues | review `data/silver/_quarantine/` and `dq_report.csv` |
| Gold reconciliation fails | Gold stays in `data/gold/_staging/<run_id>/`. `current` is **not** replaced | read `reconciliation.json` in the staging folder |
| Database publish fails | the transaction rolls back; the database keeps the previous version; a `failed` row goes to `firms.pipeline_runs` | fix the problem, then `run --stages publish` |
| A run stops halfway | Bronze files are written atomically, Silver is idempotent, Gold is staged | rerun the same command |

**Rollback of Gold:** the previous Gold folder is kept as `data/gold/previous/`. To roll back, rename `current` → `failed_<date>` and `previous` → `current`, then `run --stages publish`.

## Monitoring (`data/_runs/monitoring.json`, refreshed after Silver)

- last ingestion status counts
- last Silver counts: input, valid, rejected, duplicates, schema errors, duration
- source freshness: latest detection time per product
- Gold match status counts and reconciliation result
- `volume_change_alerts`: files whose valid row count changed by more than `quality.max_volume_change_pct` (50 %) since they were last processed

**A volume alert is a prompt to investigate, not a finding.** Check the FIRMS outage page and release notes before concluding that fire activity changed.

`data/_runs/pipeline_runs.csv` records every stage of every run: start, end, status, counts, error.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Everything `not_available` | country name spelling. Use the FIRMS spelling with spaces, e.g. `Saudi Arabia` (the file name uses `_`) |
| `FIRMS_MAP_KEY is not set` | `--nrt` without a key in `.env` |
| `response is not a FIRMS CSV` | FIRMS maintenance page, or a proxy / captive portal returned HTML. Retry later |
| Match rate suddenly drops | thresholds changed, satellite drift (Aqua after ~2021), or a new VIIRS satellite configured. Compare `matching_sensitivity.csv` |
| Calendar differs from earlier deliveries | check `gold.calendar` settings and `silver.processing_version` in `manifest.json` |
