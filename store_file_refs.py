from __future__ import annotations

import re
from pathlib import Path
from uuid import uuid4

_FILE_REF_PATTERN = re.compile(
    r"(?P<path>(?:~?/|/|\.\.?/)?[^\s:#]+(?:/[^\s:#]+)*\.[A-Za-z0-9._-]+)(?:(?::(?P<colon_line>\d+))|(?:#L(?P<hash_start>\d+)(?:-L?(?P<hash_end>\d+))?))"
)


def extract_file_refs(text: str) -> list[dict[str, object]]:
    refs: list[dict[str, object]] = []
    for match in _FILE_REF_PATTERN.finditer(str(text or "")):
        path = str(match.group("path") or "").strip()
        if not path:
            continue

        raw_text = str(match.group(0) or "").strip()
        colon_line = match.group("colon_line")
        hash_start = match.group("hash_start")
        hash_end = match.group("hash_end")
        if colon_line:
            line_start = int(colon_line)
            line_end = line_start
        elif hash_start:
            line_start = int(hash_start)
            line_end = int(hash_end) if hash_end else line_start
        else:
            line_start = 1
            line_end = 1

        if line_start < 1:
            line_start = 1
        if line_end < line_start:
            line_end = line_start

        refs.append(
            {
                "ref_id": f"fr_{uuid4().hex[:12]}",
                "raw_text": raw_text,
                "path": path,
                "line_start": line_start,
                "line_end": line_end,
            }
        )
    return refs


def resolve_allowed_roots(raw_roots: list[Path]) -> list[Path]:
    roots: list[Path] = []
    seen: set[str] = set()
    for root in raw_roots:
        candidate = Path(root).expanduser().resolve(strict=False)
        key = str(candidate)
        if key in seen:
            continue
        seen.add(key)
        roots.append(candidate)
    return roots


def path_within_any_root(path: Path, roots: list[Path]) -> bool:
    for root in roots:
        try:
            path.relative_to(root)
            return True
        except ValueError:
            continue
    return False


def is_probably_binary(raw_bytes: bytes) -> bool:
    if not raw_bytes:
        return False
    if b"\x00" in raw_bytes:
        return True

    text_like = 0
    for byte in raw_bytes:
        if byte in (9, 10, 13) or 32 <= byte <= 126:
            text_like += 1
    ratio = text_like / max(1, len(raw_bytes))
    return ratio < 0.75
