"""Load configuration and resolve data paths."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]


@dataclass
class Config:
    pipeline: dict
    sources: dict
    root: Path

    @property
    def data_dir(self) -> Path:
        p = Path(self.pipeline.get("data_dir", "data"))
        return p if p.is_absolute() else self.root / p

    @property
    def bronze(self) -> Path:
        return self.data_dir / "bronze"

    @property
    def silver(self) -> Path:
        return self.data_dir / "silver"

    @property
    def gold(self) -> Path:
        return self.data_dir / "gold"

    @property
    def runs(self) -> Path:
        return self.data_dir / "_runs"

    def product(self, key: str) -> dict:
        p = dict(self.sources["products"][key])
        p["key"] = key
        return p


def load_config(pipeline_path: str | Path | None = None, sources_path: str | Path | None = None,
                overrides: dict | None = None) -> Config:
    pipeline_path = Path(pipeline_path or REPO_ROOT / "config" / "pipeline.yaml")
    sources_path = Path(sources_path or REPO_ROOT / "config" / "sources.yaml")
    pipeline = yaml.safe_load(pipeline_path.read_text())
    sources = yaml.safe_load(sources_path.read_text())
    for key, value in (overrides or {}).items():      # dotted keys, e.g. {"ingestion.end_year": 2021}
        node = pipeline
        parts = key.split(".")
        for p in parts[:-1]:
            node = node.setdefault(p, {})
        node[parts[-1]] = value
    load_dotenv(REPO_ROOT / ".env")
    if os.environ.get("FIRMS_COUNTRY_BASE_URL"):        # mirror / local test server
        sources["firms"]["country_base_url"] = os.environ["FIRMS_COUNTRY_BASE_URL"]
    return Config(pipeline=pipeline, sources=sources, root=REPO_ROOT)


def load_dotenv(path: Path) -> None:
    """Tiny .env reader so secrets stay out of code and config (plan Step 3)."""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
