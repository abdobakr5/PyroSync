"""Database connection. The URL comes from an environment variable (never from code or Git)."""
from __future__ import annotations

import os

from src.common.config import Config


def database_url(cfg: Config) -> str:
    env = cfg.pipeline["database"]["url_env"]
    url = os.environ.get(env)
    if not url:
        raise RuntimeError(f"{env} is not set - add it to .env (see .env.example)")
    return url.replace("postgresql+psycopg://", "postgresql://").replace("postgresql+psycopg2://", "postgresql://")


def connect(cfg: Config):
    import psycopg                       # optional dependency, only needed for Step 8
    return psycopg.connect(database_url(cfg))
