"""Step 3 - Ingest NASA FIRMS active-fire data into the Bronze layer.

Two access methods:
  * country_archive : yearly per-country CSVs (standard processing). No key needed.
  * area_api        : FIRMS area API for recent near-real-time days. Needs FIRMS_MAP_KEY.

Guarantees (plan Step 3 "important engineering requirements"):
  * Raw preservation - the downloaded bytes are saved unchanged.
  * Idempotency      - a file that already exists in Bronze is skipped unless refresh=True.
  * Recoverability   - files are written to a temp name then renamed, so a failure never
                       leaves a half file or overwrites a good one.
  * Traceability     - every request is a row in data/bronze/_ingestion_log.csv.
  * Empty vs failed  - 'empty' (valid file, header only), 'not_available' (HTTP 404: FIRMS has no
                       file for that country/year), and 'failed' (errors after retries) are separate.
"""
from __future__ import annotations

import hashlib
import io
import logging
import os
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path

import requests

from src.common.config import Config
from src.common.runlog import append_rows, atomic_write_bytes, new_run_id, utc_now

log = logging.getLogger(__name__)

LOG_FIELDS = ["run_id", "source_instrument", "source_product", "product_key", "region", "requested_start_date",
              "requested_end_date", "retrieved_at", "source_url", "bronze_path", "record_count", "file_size_bytes",
              "sha256", "status", "attempts", "error_message"]
RETRY_STATUS = {429, 500, 502, 503, 504}


@dataclass
class Request:
    product: dict
    url: str
    bronze_path: Path
    region: str
    start: str
    end: str


class FirmsClient:
    """HTTP GET with timeout, retries and exponential backoff."""

    def __init__(self, timeout: float, max_retries: int, backoff: float, session: requests.Session | None = None):
        self.timeout, self.max_retries, self.backoff = timeout, max_retries, backoff
        self.session = session or requests.Session()

    def get(self, url: str) -> tuple[int, bytes, int]:
        """Return (http_status, body, attempts). Raises after the last failed attempt."""
        last_exc = None
        for attempt in range(1, self.max_retries + 1):
            try:
                r = self.session.get(url, timeout=self.timeout)
                if r.status_code in RETRY_STATUS and attempt < self.max_retries:
                    log.warning("HTTP %s for %s (attempt %d), retrying", r.status_code, _safe(url), attempt)
                    time.sleep(self.backoff * 2 ** (attempt - 1))
                    continue
                return r.status_code, r.content, attempt
            except requests.RequestException as e:
                last_exc = e
                if attempt == self.max_retries:
                    break
                log.warning("%s for %s (attempt %d), retrying", type(e).__name__, _safe(url), attempt)
                time.sleep(self.backoff * 2 ** (attempt - 1))
        raise RuntimeError(f"request failed after {self.max_retries} attempts: {last_exc}")


def _safe(url: str) -> str:
    """Never write the MAP_KEY into logs."""
    key = os.environ.get("FIRMS_MAP_KEY")
    return url.replace(key, "<MAP_KEY>") if key else url


def _looks_like_firms_csv(body: bytes) -> bool:
    head = body[:200].decode("utf-8", errors="replace").lstrip("﻿").lower()
    return head.startswith("latitude,longitude")


def plan_country_requests(cfg: Config, product_keys: list[str], start_year: int, end_year: int,
                          countries: list[str]) -> list[Request]:
    base = cfg.sources["firms"]["country_base_url"].rstrip("/")
    reqs = []
    for key in product_keys:
        p = cfg.product(key)
        if p["access"] != "country_archive":
            continue
        d = p["country_dir"]
        for year in range(max(start_year, p.get("first_year", start_year)), end_year + 1):
            for c in countries:
                fname = f"{d}_{year}_{c.replace(' ', '_')}.csv"
                reqs.append(Request(
                    product=p, url=f"{base}/{d}/{year}/{fname}",
                    bronze_path=cfg.bronze / p["instrument"].lower() / f"product={key}" / f"year={year}" / fname,
                    region=c, start=f"{year}-01-01", end=f"{year}-12-31"))
    return reqs


def plan_nrt_requests(cfg: Config, product_keys: list[str], end: date, days_back: int, chunk_days: int,
                      bbox: list[float], region_name: str) -> list[Request]:
    key_env = os.environ.get("FIRMS_MAP_KEY")
    if not key_env:
        raise RuntimeError("FIRMS_MAP_KEY is not set (copy .env.example to .env and add your key)")
    base = cfg.sources["firms"]["api_base_url"].rstrip("/")
    area = ",".join(str(v) for v in bbox)
    reqs = []
    first = end - timedelta(days=days_back - 1)
    for key in product_keys:
        p = cfg.product(key)
        day = first
        while day <= end:
            n = min(chunk_days, (end - day).days + 1)
            last = day + timedelta(days=n - 1)
            fname = f"{p['api_source']}_{region_name}_{day:%Y-%m-%d}_{n}d.csv"
            reqs.append(Request(
                product=p, url=f"{base}/{key_env}/{p['api_source']}/{area}/{n}/{day:%Y-%m-%d}",
                bronze_path=cfg.bronze / p["instrument"].lower() / f"product={key}" / f"acquisition_date={day:%Y-%m-%d}" / fname,
                region=region_name, start=f"{day:%Y-%m-%d}", end=f"{last:%Y-%m-%d}"))
            day = last + timedelta(days=1)
    return reqs


def fetch_one(req: Request, client: FirmsClient, run_id: str, refresh: bool) -> dict:
    row = {"run_id": run_id, "source_instrument": req.product["instrument"], "source_product": req.product["product"],
           "product_key": req.product["key"], "region": req.region, "requested_start_date": req.start,
           "requested_end_date": req.end, "retrieved_at": utc_now(), "source_url": _safe(req.url),
           "bronze_path": str(req.bronze_path), "record_count": "", "file_size_bytes": "", "sha256": "",
           "attempts": 0, "error_message": ""}
    if req.bronze_path.exists() and req.bronze_path.stat().st_size > 0 and not refresh:
        body = req.bronze_path.read_bytes()
        row.update(status="skipped_exists", record_count=_count_rows(body), file_size_bytes=len(body),
                   sha256=hashlib.sha256(body).hexdigest())
        return row
    try:
        status, body, attempts = client.get(req.url)
        row["attempts"] = attempts
        if status == 404:
            row.update(status="not_available", error_message="HTTP 404 - FIRMS has no file for this request")
            return row
        if status != 200:
            row.update(status="failed", error_message=f"HTTP {status}")
            return row
        if not _looks_like_firms_csv(body):
            row.update(status="failed", error_message="response is not a FIRMS CSV: "
                       + body[:80].decode("utf-8", errors="replace").replace("\n", " "))
            return row
        atomic_write_bytes(req.bronze_path, body)          # raw bytes, unchanged
        n = _count_rows(body)
        row.update(status="success" if n > 0 else "empty", record_count=n, file_size_bytes=len(body),
                   sha256=hashlib.sha256(body).hexdigest())
    except Exception as e:                                  # one bad file must not stop the run
        row.update(status="failed", error_message=str(e)[:300])
    return row


def _count_rows(body: bytes) -> int:
    return sum(1 for line in io.BytesIO(body).read().splitlines()[1:] if line.strip())


def run_ingestion(cfg: Config, start_year: int | None = None, end_year: int | None = None,
                  countries: list[str] | None = None, products: list[str] | None = None,
                  refresh: bool = False, nrt: bool | None = None, run_id: str | None = None,
                  session: requests.Session | None = None) -> dict:
    ing = cfg.pipeline["ingestion"]
    run_id = run_id or new_run_id("ingest")
    client = FirmsClient(ing["timeout_seconds"], ing["max_retries"], ing["backoff_seconds"], session)
    reqs = plan_country_requests(cfg, products or ing["products"], start_year or ing["start_year"],
                                 end_year or ing["end_year"], countries or cfg.pipeline["region"]["countries"])
    nrt_cfg = ing.get("nrt", {})
    if nrt if nrt is not None else nrt_cfg.get("enabled", False):
        reqs += plan_nrt_requests(cfg, nrt_cfg["products"], date.today(), nrt_cfg["days_back"],
                                  nrt_cfg["chunk_days"], cfg.pipeline["region"]["bbox"], cfg.pipeline["region"]["name"])
    log.info("ingestion %s: %d requests", run_id, len(reqs))
    with ThreadPoolExecutor(max_workers=ing.get("workers", 4)) as ex:
        rows = list(ex.map(lambda r: fetch_one(r, client, run_id, refresh), reqs))
    append_rows(cfg.bronze / "_ingestion_log.csv", rows, LOG_FIELDS)
    summary = {s: sum(1 for r in rows if r["status"] == s)
               for s in ["success", "empty", "skipped_exists", "not_available", "failed"]}
    summary.update(run_id=run_id, requests=len(rows),
                   records=sum(int(r["record_count"] or 0) for r in rows if r["status"] in ("success", "skipped_exists")))
    log.info("ingestion summary: %s", summary)
    return summary
