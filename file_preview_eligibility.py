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
FILE_PREVIEW_CONTEXT_ROOTS_ENV = "MINI_APP_FILE_PREVIEW_CONTEXT_ROOTS"
FILE_PREVIEW_BASENAME_SEARCH_SKIP_DIRS: tuple[str, ...] = (
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    ".venv",
    "venv",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
)


def _parse_root_list(raw: str) -> list[Path]:
    roots: list[Path] = []
    for candidate in str(raw or "").split(":"):
        cleaned = candidate.strip()
        if not cleaned:
            continue
        try:
            root = Path(cleaned).expanduser().resolve(strict=False)
        except OSError:
            continue
        roots.append(root)
    return roots


def _dedupe_roots(roots: list[Path]) -> list[Path]:
    unique: list[Path] = []
    seen: set[str] = set()
    for root in roots:
        key = str(root)
        if not key or key in seen:
            continue
        seen.add(key)
        unique.append(root)
    return unique


def file_preview_allowed_roots() -> list[Path]:
    raw = str(os.environ.get("MINI_APP_FILE_PREVIEW_ALLOWED_ROOTS", "")).strip()
    if not raw:
        return []
    return _dedupe_roots(_parse_root_list(raw))


def file_preview_enabled(allowed_roots: list[Path] | None = None) -> bool:
    roots = allowed_roots if allowed_roots is not None else file_preview_allowed_roots()
    raw = os.environ.get("MINI_APP_FILE_PREVIEW_ENABLED")
    if raw is None:
        return bool(roots)
    return str(raw).strip().lower() in {"1", "true", "yes", "on"}


def _detect_process_repo_root() -> Path | None:
    try:
        current = Path.cwd().resolve(strict=False)
    except OSError:
        return None
    for candidate in (current, *current.parents):
        try:
            if (candidate / ".git").exists():
                return candidate
        except OSError:
            continue
    return None


def file_preview_context_roots(allowed_roots: list[Path] | None = None) -> list[Path]:
    roots = allowed_roots if allowed_roots is not None else file_preview_allowed_roots()
    configured = _parse_root_list(str(os.environ.get(FILE_PREVIEW_CONTEXT_ROOTS_ENV, "")).strip())
    detected_repo_root = _detect_process_repo_root()
    candidates = configured + ([detected_repo_root] if detected_repo_root is not None else [])
    if not roots:
        return _dedupe_roots(candidates)
    return _dedupe_roots([root for root in candidates if path_under_allowed_roots(root, roots)])


def _resolve_relative_path_against_roots(candidate: Path, roots: list[Path]) -> Path | None:
    for root in roots:
        try:
            resolved = (root / candidate).resolve(strict=False)
        except OSError:
            continue
        try:
            resolved.relative_to(root)
            return resolved
        except ValueError:
            continue
    return None


def _resolve_unique_basename_under_roots(basename: str, roots: list[Path]) -> Path | None:
    if not basename or any(sep in basename for sep in ("/", "\\")):
        return None
    matches: list[Path] = []
    for root in roots:
        if not root.exists() or not root.is_dir():
            continue
        for current_root, dirnames, filenames in os.walk(root):
            dirnames[:] = [name for name in dirnames if name not in FILE_PREVIEW_BASENAME_SEARCH_SKIP_DIRS]
            if basename not in filenames:
                continue
            try:
                match = (Path(current_root) / basename).resolve(strict=False)
            except OSError:
                continue
            matches.append(match)
            if len(matches) > 1:
                return None
    return matches[0] if matches else None


def resolve_preview_path(
    path_text: str,
    *,
    allowed_roots: list[Path],
    preferred_roots: list[Path] | None = None,
) -> Path:
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

    context_roots = preferred_roots if preferred_roots is not None else file_preview_context_roots(allowed_roots)

    requires_existing_exact_match = len(candidate.parts) == 1

    resolved = _resolve_relative_path_against_roots(candidate, context_roots)
    if resolved is not None and (not requires_existing_exact_match or resolved.exists()):
        return resolved

    resolved = _resolve_relative_path_against_roots(candidate, allowed_roots)
    if resolved is not None and (not requires_existing_exact_match or resolved.exists()):
        return resolved

    basename_match = _resolve_unique_basename_under_roots(candidate.name, context_roots)
    if basename_match is not None:
        return basename_match

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


def is_previewable_path(
    path_text: str,
    *,
    allowed_roots: list[Path] | None = None,
    preferred_roots: list[Path] | None = None,
) -> bool:
    roots = allowed_roots if allowed_roots is not None else file_preview_allowed_roots()
    if not file_preview_enabled(roots) or not roots:
        return False
    try:
        target = resolve_preview_path(path_text, allowed_roots=roots, preferred_roots=preferred_roots)
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


def previewable_file_refs(
    text: str,
    *,
    message_id: int | None = None,
    allowed_roots: list[Path] | None = None,
    preferred_roots: list[Path] | None = None,
) -> list[dict[str, Any]]:
    roots = allowed_roots if allowed_roots is not None else file_preview_allowed_roots()
    context_roots = preferred_roots if preferred_roots is not None else file_preview_context_roots(roots)
    refs = extract_file_refs(text, message_id=message_id)
    if not refs or not file_preview_enabled(roots) or not roots:
        return []

    previewable_refs: list[dict[str, Any]] = []
    for ref in refs:
        path_text = str(ref.get("path") or "")
        if not is_previewable_path(
            path_text,
            allowed_roots=roots,
            preferred_roots=context_roots,
        ):
            continue
        try:
            resolved_path = resolve_preview_path(
                path_text,
                allowed_roots=roots,
                preferred_roots=context_roots,
            )
        except ValueError:
            continue
        previewable_ref = dict(ref)
        previewable_ref["resolved_path"] = str(resolved_path)
        previewable_refs.append(previewable_ref)
    return previewable_refs
