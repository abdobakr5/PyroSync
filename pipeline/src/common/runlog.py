"""Run identifiers, append-only CSV logs, and atomic file writes."""
from __future__ import annotations

import csv
import os
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def new_run_id(prefix: str = "run") -> str:
    return f"{prefix}_{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}_{uuid.uuid4().hex[:6]}"


def append_rows(path: Path, rows: list[dict], fieldnames: list[str]) -> None:
    """Append rows to a CSV log, writing the header when the file is new."""
    if not rows:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    new = not path.exists()
    with path.open("a", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        if new:
            w.writeheader()
        w.writerows(rows)


def atomic_write_bytes(path: Path, data: bytes) -> None:
    """Write to a temp file next to the target, then rename. A crash never leaves half a file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".tmp_", suffix=path.suffix)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise


def atomic_write_text(path: Path, text: str) -> None:
    atomic_write_bytes(path, text.encode("utf-8"))
