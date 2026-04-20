from __future__ import annotations

from miniapp_config import normalize_origin


def preview_url_origin(value: str | None) -> str:
    return normalize_origin(value)


def is_preview_url_allowed(url: str | None, allowed_origins: set[str]) -> bool:
    candidate_origin = preview_url_origin(url)
    if not candidate_origin:
        return False
    return candidate_origin in set(allowed_origins or set())


def assert_preview_url_allowed(url: str | None, allowed_origins: set[str]) -> str:
    candidate_url = str(url or "").strip()
    if not candidate_url or not preview_url_origin(candidate_url):
        raise ValueError("Invalid preview url")
    if not is_preview_url_allowed(candidate_url, allowed_origins):
        raise ValueError("Untrusted preview url origin")
    return candidate_url


def is_parent_origin_allowed(origin: str | None, allowed_origins: set[str]) -> bool:
    candidate_origin = normalize_origin(origin)
    if not candidate_origin:
        return False
    return candidate_origin in set(allowed_origins or set())


def assert_parent_origin_allowed(origin: str | None, allowed_origins: set[str]) -> str:
    candidate_origin = normalize_origin(origin)
    if not candidate_origin:
        raise ValueError("Invalid parent origin")
    if not is_parent_origin_allowed(candidate_origin, allowed_origins):
        raise ValueError("Untrusted parent origin")
    return candidate_origin
