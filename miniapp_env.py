from __future__ import annotations

import os
from pathlib import Path


def _parse_env_lines(text: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def load_env_file_into_environ(
    path: Path,
    *,
    overwrite: bool = False,
    preserve_alias_groups: tuple[tuple[str, ...], ...] = (),
) -> dict[str, str]:
    os.environ.setdefault("FLASK_SKIP_DOTENV", "1")
    if not path.exists():
        return {}
    parsed = _parse_env_lines(path.read_text(encoding="utf-8"))
    protected_keys: set[str] = set()
    for group in preserve_alias_groups:
        alias_group = tuple(str(key) for key in group if str(key).strip())
        if not alias_group:
            continue
        if any(key in os.environ for key in alias_group):
            protected_keys.update(alias_group)
    applied: dict[str, str] = {}
    for key, value in parsed.items():
        if not overwrite and (key in os.environ or key in protected_keys):
            continue
        os.environ[key] = value
        applied[key] = value
    return applied
