from __future__ import annotations

import fnmatch
import os
from pathlib import Path
from typing import Any

from file_refs import extract_file_refs

DEFAULT_FILE_PREVIEW_DENY_BASENAME_GLOBS: tuple[str, ...] = (
    ".env",
    ".env.*",
    "auth.json",
    "*.pem",
    "*.key",
    "*.p12",
    "*.pfx",
    "*.kdbx",
    "id_rsa",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
)
DEFAULT_FILE_PREVIEW_DENY_PATH_GLOBS: tuple[str, ...] = (
    "*/.env",
    "*/.env.*",
    ".env",
    ".env.*",
    "checkpoints/*",
    "*/checkpoints/*",
    "checkpoint/*",
    "*/checkpoint/*",
    "pre_restore*/*",
    "*/pre_restore*/*",
    ".git/*",
    "*/.git/*",
    ".ssh/*",
    "*/.ssh/*",
    ".gnupg/*",
    "*/.gnupg/*",
)
FILE_PREVIEW_MAX_BYTES = 1_000_000


def file_preview_allowed_roots() -> list[Path]:
    raw = str(os.environ.get("MINI_APP_FILE_PREVIEW_ALLOWED_ROOTS", "")).strip()
    if not raw:
        return []
    roots: list[Path] = []
    for candidate in raw.split(":"):
        cleaned = candidate.strip()
        if not cleaned:
            continue
        try:
            root = Path(cleaned).expanduser().resolve(strict=False)
        except OSError:
            continue
        roots.append(root)
    return roots


def file_preview_enabled(allowed_roots: list[Path] | None = None) -> bool:
    roots = allowed_roots if allowed_roots is not None else file_preview_allowed_roots()
    raw = os.environ.get("MINI_APP_FILE_PREVIEW_ENABLED")
    if raw is None:
        return bool(roots)
    return str(raw).strip().lower() in {"1", "true", "yes", "on"}


def resolve_preview_path(path_text: str, *, allowed_roots: list[Path]) -> Path:
    cleaned = str(path_text or "").strip()
    if not cleaned:
        raise ValueError("Missing file path")

    if cleaned.lower().startswith("file://"):
        cleaned = cleaned[7:]

    try:
        candidate = Path(cleaned).expanduser()
    except OSError as exc:
        raise ValueError("Invalid file path") from exc

    if candidate.is_absolute():
        try:
            return candidate.resolve(strict=False)
        except OSError as exc:
            raise ValueError("Invalid file path") from exc

    for root in allowed_roots:
        try:
            resolved = (root / candidate).resolve(strict=False)
        except OSError:
            continue
        try:
            resolved.relative_to(root)
            return resolved
        except ValueError:
            continue

    raise ValueError("Path must be absolute or relative to an allowed root")


def path_under_allowed_roots(target: Path, roots: list[Path]) -> bool:
    for root in roots:
        try:
            target.relative_to(root)
            return True
        except ValueError:
            continue
    return False


def _file_preview_deny_basename_globs() -> tuple[str, ...]:
    raw = str(os.environ.get("MINI_APP_FILE_PREVIEW_DENY_BASENAME_GLOBS", "")).strip()
    if not raw:
        return DEFAULT_FILE_PREVIEW_DENY_BASENAME_GLOBS
    values = tuple(str(chunk or "").strip().lower() for chunk in raw.split(os.pathsep) if str(chunk or "").strip())
    return values or DEFAULT_FILE_PREVIEW_DENY_BASENAME_GLOBS


def _file_preview_deny_path_globs() -> tuple[str, ...]:
    raw = str(os.environ.get("MINI_APP_FILE_PREVIEW_DENY_PATH_GLOBS", "")).strip()
    if not raw:
        return DEFAULT_FILE_PREVIEW_DENY_PATH_GLOBS
    values = tuple(str(chunk or "").strip().lower() for chunk in raw.split(os.pathsep) if str(chunk or "").strip())
    return values or DEFAULT_FILE_PREVIEW_DENY_PATH_GLOBS


def _path_within_allowed_root(target: Path, roots: list[Path]) -> tuple[Path, Path] | None:
    for root in roots:
        try:
            relative = target.relative_to(root)
        except ValueError:
            continue
        return root, relative
    return None


def file_preview_deny_status(target: Path, roots: list[Path]) -> dict[str, str] | None:
    match = _path_within_allowed_root(target, roots)
    if match is None:
        return None
    _, relative = match
    basename = target.name.lower()
    relative_path = relative.as_posix().lower()
    anchored_relative_path = f"/{relative_path}" if relative_path else "/"

    for pattern in _file_preview_deny_basename_globs():
        if fnmatch.fnmatch(basename, pattern):
            return {
                "state": "blocked",
                "reason": "sensitive_file",
                "rule_type": "basename_glob",
            }

    for pattern in _file_preview_deny_path_globs():
        normalized = pattern if pattern.startswith("/") else f"/{pattern}"
        if fnmatch.fnmatch(anchored_relative_path, normalized):
            return {
                "state": "blocked",
                "reason": "sensitive_file",
                "rule_type": "path_glob",
            }

    return None


def is_previewable_path(path_text: str, *, allowed_roots: list[Path] | None = None) -> bool:
    roots = allowed_roots if allowed_roots is not None else file_preview_allowed_roots()
    if not file_preview_enabled(roots) or not roots:
        return False
    try:
        target = resolve_preview_path(path_text, allowed_roots=roots)
    except ValueError:
        return False
    if not path_under_allowed_roots(target, roots):
        return False
    if file_preview_deny_status(target, roots) is not None:
        return False
    try:
        if not target.exists() or not target.is_file():
            return False
        if target.stat().st_size > FILE_PREVIEW_MAX_BYTES:
            return False
        raw_bytes = target.read_bytes()
    except OSError:
        return False
    return b"\x00" not in raw_bytes


def previewable_file_refs(text: str, *, message_id: int | None = None, allowed_roots: list[Path] | None = None) -> list[dict[str, Any]]:
    roots = allowed_roots if allowed_roots is not None else file_preview_allowed_roots()
    refs = extract_file_refs(text, message_id=message_id)
    if not refs or not file_preview_enabled(roots) or not roots:
        return []
    return [ref for ref in refs if is_previewable_path(str(ref.get("path") or ""), allowed_roots=roots)]
