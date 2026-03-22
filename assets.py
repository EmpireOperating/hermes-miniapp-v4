from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Iterable


def asset_version(base_dir: Path, filename: str) -> str:
    asset_path = base_dir / "static" / filename
    try:
        return str(asset_path.stat().st_mtime_ns)
    except FileNotFoundError:
        return "0"


def dev_reload_version(base_dir: Path, watch_paths: Iterable[Path]) -> str:
    digest = hashlib.sha1()
    for path in watch_paths:
        try:
            stat = path.stat()
            digest.update(str(path.relative_to(base_dir)).encode("utf-8"))
            digest.update(str(stat.st_mtime_ns).encode("utf-8"))
            digest.update(str(stat.st_size).encode("utf-8"))
        except FileNotFoundError:
            digest.update(str(path).encode("utf-8"))
            digest.update(b"missing")
    return digest.hexdigest()[:12]
