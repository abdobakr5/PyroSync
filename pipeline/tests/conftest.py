import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.common.config import load_config  # noqa: E402
from tests.fixtures.make_synthetic import write_tree  # noqa: E402


@pytest.fixture(scope="session")
def server_root(tmp_path_factory) -> Path:
    root = tmp_path_factory.mktemp("firms_server")
    write_tree(root)
    return root


@pytest.fixture
def make_cfg(tmp_path):
    def _make(base_url: str | None = None, **overrides):
        cfg = load_config(overrides={"data_dir": str(tmp_path / "data"), "ingestion.backoff_seconds": 0.01,
                                     "ingestion.max_retries": 3, **overrides})
        if base_url:
            cfg.sources["firms"]["country_base_url"] = base_url
        return cfg
    return _make


def database_available() -> bool:
    if not os.environ.get("DATABASE_URL"):
        return False
    try:
        import psycopg
        with psycopg.connect(os.environ["DATABASE_URL"].replace("+psycopg", ""), connect_timeout=3):
            return True
    except Exception:
        return False
