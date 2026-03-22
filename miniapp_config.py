from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse


@dataclass(frozen=True, slots=True)
class MiniAppConfig:
    port: int
    debug: bool
    dev_reload: bool
    dev_reload_interval_ms: int
    max_message_len: int
    max_title_len: int
    max_content_length: int
    assistant_chunk_len: int
    assistant_hard_limit: int
    job_max_attempts: int
    job_retry_base_seconds: int
    job_worker_concurrency: int
    job_stall_timeout_seconds: int
    telegram_init_data_max_age_seconds: int
    auth_session_max_age_seconds: int
    force_secure_cookies: bool
    trust_proxy_headers: bool
    allowed_origins: set[str]
    enforce_origin_check: bool
    rate_limit_window_seconds: int
    rate_limit_api_requests: int
    rate_limit_stream_requests: int
    enable_hsts: bool
    job_event_history_max_jobs: int
    job_event_history_ttl_seconds: int
    dev_reload_watch_paths: tuple[Path, ...]

    @classmethod
    def from_env(cls) -> "MiniAppConfig":
        base_dir = Path(__file__).resolve().parent
        max_content_length = _as_int("MAX_CONTENT_LENGTH", 1048576)
        if max_content_length <= 0:
            raise ValueError("MAX_CONTENT_LENGTH must be > 0")

        return cls(
            port=_as_int("PORT", 8080),
            debug=_as_bool("FLASK_DEBUG", default=False),
            dev_reload=_as_bool("MINI_APP_DEV_RELOAD", default=False),
            dev_reload_interval_ms=_as_int("MINI_APP_DEV_RELOAD_INTERVAL_MS", 1200),
            max_message_len=_as_int("MAX_MESSAGE_LEN", 4000),
            max_title_len=_as_int("MAX_TITLE_LEN", 120),
            max_content_length=max_content_length,
            assistant_chunk_len=_as_int("MAX_ASSISTANT_CHUNK_LEN", 12000),
            assistant_hard_limit=_as_int("MAX_ASSISTANT_HARD_LIMIT", 256000),
            job_max_attempts=_as_int("MINI_APP_JOB_MAX_ATTEMPTS", 4),
            job_retry_base_seconds=_as_int("MINI_APP_JOB_RETRY_BASE_SECONDS", 2),
            job_worker_concurrency=max(1, _as_int("MINI_APP_JOB_WORKER_CONCURRENCY", 6)),
            job_stall_timeout_seconds=max(60, _as_int("MINI_APP_JOB_STALL_TIMEOUT_SECONDS", 240)),
            telegram_init_data_max_age_seconds=_as_int("TELEGRAM_INIT_DATA_MAX_AGE_SECONDS", 21600),
            auth_session_max_age_seconds=_as_int("AUTH_SESSION_MAX_AGE_SECONDS", 60 * 60 * 24 * 7),
            force_secure_cookies=_as_bool("MINI_APP_FORCE_SECURE_COOKIES", default=True),
            trust_proxy_headers=_as_bool("MINI_APP_TRUST_PROXY_HEADERS", default=True),
            allowed_origins=_parse_allowed_origins(os.environ.get("MINI_APP_ALLOWED_ORIGINS", "")),
            enforce_origin_check=_as_bool("MINI_APP_ENFORCE_ORIGIN_CHECK", default=False),
            rate_limit_window_seconds=max(5, _as_int("MINI_APP_RATE_LIMIT_WINDOW_SECONDS", 60)),
            rate_limit_api_requests=max(10, _as_int("MINI_APP_RATE_LIMIT_API_REQUESTS", 180)),
            rate_limit_stream_requests=max(3, _as_int("MINI_APP_RATE_LIMIT_STREAM_REQUESTS", 24)),
            enable_hsts=_as_bool("MINI_APP_ENABLE_HSTS", default=False),
            job_event_history_max_jobs=max(32, _as_int("MINI_APP_JOB_EVENT_HISTORY_MAX_JOBS", 256)),
            job_event_history_ttl_seconds=max(60, _as_int("MINI_APP_JOB_EVENT_HISTORY_TTL_SECONDS", 1800)),
            dev_reload_watch_paths=(
                base_dir / "server.py",
                base_dir / "templates" / "app.html",
                base_dir / "static" / "app.css",
                base_dir / "static" / "app.js",
            ),
        )


def normalize_origin(value: str | None) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    parsed = urlparse(raw)
    if not parsed.scheme or not parsed.netloc:
        return ""
    return f"{parsed.scheme.lower()}://{parsed.netloc.lower()}".rstrip("/")


def _parse_allowed_origins(raw: str) -> set[str]:
    origins: set[str] = set()
    for value in str(raw).split(","):
        candidate = normalize_origin(value)
        if not value.strip():
            continue
        if not candidate:
            raise ValueError(f"Invalid origin in MINI_APP_ALLOWED_ORIGINS: {value.strip()}")
        origins.add(candidate)
    return origins


def _as_int(name: str, default: int) -> int:
    return int(os.environ.get(name, str(default)))


def _as_bool(name: str, *, default: bool) -> bool:
    default_raw = "1" if default else "0"
    return os.environ.get(name, default_raw) == "1"
