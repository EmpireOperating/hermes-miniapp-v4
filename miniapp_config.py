from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

from runtime_limits import (
    DEFAULT_JOB_EVENT_HISTORY_MAX_JOBS,
    DEFAULT_JOB_EVENT_HISTORY_TTL_SECONDS,
    MIN_JOB_EVENT_HISTORY_MAX_JOBS,
    MIN_JOB_EVENT_HISTORY_TTL_SECONDS,
    MIN_JOB_STALL_TIMEOUT_SECONDS,
)


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
    job_worker_launcher: str
    job_worker_subprocess_timeout_seconds: int
    job_worker_subprocess_kill_grace_seconds: int
    job_worker_subprocess_stderr_excerpt_bytes: int
    job_worker_subprocess_memory_limit_mb: int
    job_worker_subprocess_max_tasks: int
    job_worker_subprocess_max_open_files: int
    persistent_runtime_ownership: str
    warm_worker_reuse_enabled: bool
    warm_worker_same_chat_only: bool
    warm_worker_idle_ttl_seconds: int
    warm_worker_max_idle: int
    warm_worker_max_total: int
    warm_worker_retire_after_runs: int
    warm_worker_health_max_rss_mb: int
    warm_worker_health_max_threads: int
    job_stall_timeout_seconds: int
    telegram_init_data_max_age_seconds: int
    auth_session_max_age_seconds: int
    telegram_notification_send_timeout_seconds: int
    force_secure_cookies: bool
    trust_proxy_headers: bool
    allowed_origins: set[str]
    enforce_origin_check: bool
    rate_limit_window_seconds: int
    rate_limit_api_requests: int
    rate_limit_stream_requests: int
    enable_hsts: bool
    operator_debug: bool
    request_debug: bool
    stream_timing_debug: bool
    stream_efficiency_mode: bool
    stream_metrics_refresh_seconds: int
    mobile_tab_carousel_enabled: bool
    tab_actions_menu_enabled: bool
    dev_auth_enabled: bool
    dev_auth_secret: str
    dev_auth_expires_at_epoch: int | None
    job_event_history_max_jobs: int
    job_event_history_ttl_seconds: int
    visual_dev_enabled: bool
    visual_dev_operator_only: bool
    visual_dev_allowed_preview_origins: set[str]
    visual_dev_bridge_allowed_parents: set[str]
    visual_dev_artifact_dir: Path
    visual_dev_max_console_events: int
    visual_dev_screenshot_max_bytes: int
    dev_reload_watch_paths: tuple[Path, ...]

    def resolved_persistent_runtime_ownership(self) -> str:
        return _resolve_persistent_runtime_ownership(
            ownership_mode=self.persistent_runtime_ownership,
            job_worker_launcher=self.job_worker_launcher,
        )

    def is_dev_auth_active(self, now: int | None = None) -> bool:
        if not self.dev_auth_enabled:
            return False
        expires_at = self.dev_auth_expires_at_epoch
        if expires_at is None:
            return True
        current_time = int(now if now is not None else _now_epoch_seconds())
        return current_time < expires_at

    @classmethod
    def from_env(cls) -> "MiniAppConfig":
        base_dir = Path(__file__).resolve().parent
        max_content_length = _parse_max_content_length()
        runtime_settings = _parse_runtime_debug_settings()
        worker_settings = _parse_worker_settings()
        telegram_auth_settings = _parse_telegram_auth_settings()
        web_security_settings = _parse_web_security_settings()
        ui_settings = _parse_ui_settings()
        dev_auth_settings = _parse_dev_auth_settings()
        job_history_settings = _parse_job_history_settings()
        visual_dev_settings = _parse_visual_dev_settings(base_dir)

        return cls(
            port=_as_int("PORT", 8080),
            debug=_as_bool("FLASK_DEBUG", default=False),
            dev_reload=_as_bool("MINI_APP_DEV_RELOAD", default=False),
            dev_reload_interval_ms=_as_int_in_range("MINI_APP_DEV_RELOAD_INTERVAL_MS", 1200, min_value=100, max_value=60000),
            max_message_len=_as_int_in_range("MAX_MESSAGE_LEN", 4000, min_value=1, max_value=12000),
            max_title_len=_as_int_in_range("MAX_TITLE_LEN", 120, min_value=1, max_value=512),
            max_content_length=max_content_length,
            assistant_chunk_len=_as_int_in_range("MAX_ASSISTANT_CHUNK_LEN", 12000, min_value=800, max_value=200000),
            assistant_hard_limit=_as_int_in_range("MAX_ASSISTANT_HARD_LIMIT", 256000, min_value=8000, max_value=1000000),
            job_max_attempts=_as_int_in_range("MINI_APP_JOB_MAX_ATTEMPTS", 4, min_value=1, max_value=20),
            job_retry_base_seconds=_as_int_in_range("MINI_APP_JOB_RETRY_BASE_SECONDS", 2, min_value=1, max_value=120),
            job_worker_concurrency=_as_int_in_range("MINI_APP_JOB_WORKER_CONCURRENCY", 6, min_value=1, max_value=64),
            job_worker_launcher=worker_settings["job_worker_launcher"],
            job_worker_subprocess_timeout_seconds=worker_settings["job_worker_subprocess_timeout_seconds"],
            job_worker_subprocess_kill_grace_seconds=worker_settings["job_worker_subprocess_kill_grace_seconds"],
            job_worker_subprocess_stderr_excerpt_bytes=worker_settings["job_worker_subprocess_stderr_excerpt_bytes"],
            job_worker_subprocess_memory_limit_mb=worker_settings["job_worker_subprocess_memory_limit_mb"],
            job_worker_subprocess_max_tasks=worker_settings["job_worker_subprocess_max_tasks"],
            job_worker_subprocess_max_open_files=worker_settings["job_worker_subprocess_max_open_files"],
            persistent_runtime_ownership=worker_settings["persistent_runtime_ownership"],
            warm_worker_reuse_enabled=worker_settings["warm_worker_reuse_enabled"],
            warm_worker_same_chat_only=worker_settings["warm_worker_same_chat_only"],
            warm_worker_idle_ttl_seconds=worker_settings["warm_worker_idle_ttl_seconds"],
            warm_worker_max_idle=worker_settings["warm_worker_max_idle"],
            warm_worker_max_total=worker_settings["warm_worker_max_total"],
            warm_worker_retire_after_runs=worker_settings["warm_worker_retire_after_runs"],
            warm_worker_health_max_rss_mb=worker_settings["warm_worker_health_max_rss_mb"],
            warm_worker_health_max_threads=worker_settings["warm_worker_health_max_threads"],
            job_stall_timeout_seconds=worker_settings["job_stall_timeout_seconds"],
            telegram_init_data_max_age_seconds=telegram_auth_settings["telegram_init_data_max_age_seconds"],
            auth_session_max_age_seconds=telegram_auth_settings["auth_session_max_age_seconds"],
            telegram_notification_send_timeout_seconds=telegram_auth_settings[
                "telegram_notification_send_timeout_seconds"
            ],
            force_secure_cookies=web_security_settings["force_secure_cookies"],
            trust_proxy_headers=web_security_settings["trust_proxy_headers"],
            allowed_origins=web_security_settings["allowed_origins"],
            enforce_origin_check=web_security_settings["enforce_origin_check"],
            rate_limit_window_seconds=web_security_settings["rate_limit_window_seconds"],
            rate_limit_api_requests=web_security_settings["rate_limit_api_requests"],
            rate_limit_stream_requests=web_security_settings["rate_limit_stream_requests"],
            enable_hsts=web_security_settings["enable_hsts"],
            operator_debug=runtime_settings["operator_debug"],
            request_debug=runtime_settings["request_debug"],
            stream_timing_debug=runtime_settings["stream_timing_debug"],
            stream_efficiency_mode=runtime_settings["stream_efficiency_mode"],
            stream_metrics_refresh_seconds=runtime_settings["stream_metrics_refresh_seconds"],
            mobile_tab_carousel_enabled=ui_settings["mobile_tab_carousel_enabled"],
            tab_actions_menu_enabled=ui_settings["tab_actions_menu_enabled"],
            dev_auth_enabled=dev_auth_settings["dev_auth_enabled"],
            dev_auth_secret=dev_auth_settings["dev_auth_secret"],
            dev_auth_expires_at_epoch=dev_auth_settings["dev_auth_expires_at_epoch"],
            job_event_history_max_jobs=job_history_settings["job_event_history_max_jobs"],
            job_event_history_ttl_seconds=job_history_settings["job_event_history_ttl_seconds"],
            visual_dev_enabled=visual_dev_settings["visual_dev_enabled"],
            visual_dev_operator_only=visual_dev_settings["visual_dev_operator_only"],
            visual_dev_allowed_preview_origins=visual_dev_settings["visual_dev_allowed_preview_origins"],
            visual_dev_bridge_allowed_parents=visual_dev_settings["visual_dev_bridge_allowed_parents"],
            visual_dev_artifact_dir=visual_dev_settings["visual_dev_artifact_dir"],
            visual_dev_max_console_events=visual_dev_settings["visual_dev_max_console_events"],
            visual_dev_screenshot_max_bytes=visual_dev_settings["visual_dev_screenshot_max_bytes"],
            dev_reload_watch_paths=_default_dev_reload_watch_paths(base_dir),
        )


def normalize_origin(value: str | None) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    parsed = urlparse(raw)
    if not parsed.scheme or not parsed.netloc:
        return ""
    return f"{parsed.scheme.lower()}://{parsed.netloc.lower()}".rstrip("/")


def _parse_allowed_origins(raw: str, *, env_name: str = "MINI_APP_ALLOWED_ORIGINS") -> set[str]:
    origins: set[str] = set()
    for value in str(raw).split(","):
        candidate = normalize_origin(value)
        if not value.strip():
            continue
        if not candidate:
            raise ValueError(f"Invalid origin in {env_name}: {value.strip()}")
        origins.add(candidate)
    return origins


def _parse_max_content_length() -> int:
    max_content_length = _as_int("MAX_CONTENT_LENGTH", 1048576)
    if max_content_length <= 0:
        raise ValueError("MAX_CONTENT_LENGTH must be > 0")
    return max_content_length


def _parse_runtime_debug_settings() -> dict[str, bool | int]:
    operator_debug = _as_bool_any("MINI_APP_OPERATOR_DEBUG", "MINIAPP_OPERATOR_DEBUG", default=False)
    request_debug = operator_debug and _as_bool_any("MINI_APP_REQUEST_DEBUG", "MINIAPP_REQUEST_DEBUG", default=False)
    stream_timing_debug = operator_debug and _as_bool_any(
        "MINI_APP_STREAM_TIMING_DEBUG",
        "MINIAPP_STREAM_TIMING_DEBUG",
        default=False,
    )
    return {
        "operator_debug": operator_debug,
        "request_debug": request_debug,
        "stream_timing_debug": stream_timing_debug,
        "stream_efficiency_mode": _as_bool_any(
            "MINI_APP_STREAM_EFFICIENCY_MODE",
            "MINIAPP_STREAM_EFFICIENCY_MODE",
            default=False,
        ),
        "stream_metrics_refresh_seconds": _as_int_in_range(
            "MINI_APP_STREAM_METRICS_REFRESH_SECONDS",
            8,
            min_value=1,
            max_value=60,
        ),
    }


def _parse_worker_settings() -> dict[str, str | bool | int]:
    job_worker_launcher = _as_choice("MINI_APP_JOB_WORKER_LAUNCHER", "inline", {"inline", "subprocess"})
    persistent_runtime_ownership = _as_choice(
        "MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP",
        "auto",
        {"auto", "shared", "checkpoint_only"},
    )
    warm_worker_settings = _parse_warm_worker_settings()
    return {
        "job_worker_launcher": job_worker_launcher,
        "job_worker_subprocess_timeout_seconds": _as_int_in_range(
            "MINI_APP_JOB_WORKER_SUBPROCESS_TIMEOUT_SECONDS",
            120,
            min_value=1,
            max_value=7200,
        ),
        "job_worker_subprocess_kill_grace_seconds": _as_int_in_range(
            "MINI_APP_JOB_WORKER_SUBPROCESS_KILL_GRACE_SECONDS",
            2,
            min_value=1,
            max_value=60,
        ),
        "job_worker_subprocess_stderr_excerpt_bytes": _as_int_in_range(
            "MINI_APP_JOB_WORKER_SUBPROCESS_STDERR_EXCERPT_BYTES",
            4096,
            min_value=256,
            max_value=65536,
        ),
        "job_worker_subprocess_memory_limit_mb": _as_int_in_range(
            "MINI_APP_JOB_WORKER_SUBPROCESS_MEMORY_LIMIT_MB",
            1024,
            min_value=128,
            max_value=32768,
        ),
        "job_worker_subprocess_max_tasks": _as_int_in_range(
            "MINI_APP_JOB_WORKER_SUBPROCESS_MAX_TASKS",
            64,
            min_value=8,
            max_value=2048,
        ),
        "job_worker_subprocess_max_open_files": _as_int_in_range(
            "MINI_APP_JOB_WORKER_SUBPROCESS_MAX_OPEN_FILES",
            256,
            min_value=64,
            max_value=16384,
        ),
        "persistent_runtime_ownership": persistent_runtime_ownership,
        "job_stall_timeout_seconds": _as_int_in_range(
            "MINI_APP_JOB_STALL_TIMEOUT_SECONDS",
            240,
            min_value=MIN_JOB_STALL_TIMEOUT_SECONDS,
            max_value=7200,
        ),
        **warm_worker_settings,
    }


def _parse_warm_worker_settings() -> dict[str, bool | int]:
    warm_worker_max_idle = _as_int_in_range(
        "MINI_APP_WARM_WORKER_MAX_IDLE",
        2,
        min_value=0,
        max_value=128,
    )
    warm_worker_max_total = _as_int_in_range(
        "MINI_APP_WARM_WORKER_MAX_TOTAL",
        4,
        min_value=1,
        max_value=256,
    )
    if warm_worker_max_total < max(1, warm_worker_max_idle):
        raise ValueError("MINI_APP_WARM_WORKER_MAX_TOTAL must be >= MINI_APP_WARM_WORKER_MAX_IDLE")
    return {
        "warm_worker_reuse_enabled": _as_bool("MINI_APP_WARM_WORKER_REUSE", default=False),
        "warm_worker_same_chat_only": _as_bool("MINI_APP_WARM_WORKER_SAME_CHAT_ONLY", default=True),
        "warm_worker_idle_ttl_seconds": _as_int_in_range(
            "MINI_APP_WARM_WORKER_IDLE_TTL_SECONDS",
            180,
            min_value=30,
            max_value=3600,
        ),
        "warm_worker_max_idle": warm_worker_max_idle,
        "warm_worker_max_total": warm_worker_max_total,
        "warm_worker_retire_after_runs": _as_int_in_range(
            "MINI_APP_WARM_WORKER_RETIRE_AFTER_RUNS",
            3,
            min_value=1,
            max_value=128,
        ),
        "warm_worker_health_max_rss_mb": _as_int_in_range(
            "MINI_APP_WARM_WORKER_HEALTH_MAX_RSS_MB",
            1400,
            min_value=128,
            max_value=32768,
        ),
        "warm_worker_health_max_threads": _as_int_in_range(
            "MINI_APP_WARM_WORKER_HEALTH_MAX_THREADS",
            48,
            min_value=4,
            max_value=2048,
        ),
    }


def _parse_telegram_auth_settings() -> dict[str, int]:
    return {
        "telegram_init_data_max_age_seconds": _as_int_in_range(
            "TELEGRAM_INIT_DATA_MAX_AGE_SECONDS",
            21600,
            min_value=60,
            max_value=604800,
        ),
        "auth_session_max_age_seconds": _as_int_in_range(
            "AUTH_SESSION_MAX_AGE_SECONDS",
            60 * 60 * 24 * 7,
            min_value=60,
            max_value=60 * 60 * 24 * 90,
        ),
        "telegram_notification_send_timeout_seconds": _as_int_in_range(
            "MINI_APP_TELEGRAM_NOTIFICATION_TIMEOUT_SECONDS",
            8,
            min_value=1,
            max_value=60,
        ),
    }


def _parse_web_security_settings() -> dict[str, bool | int | set[str]]:
    return {
        "force_secure_cookies": _as_bool("MINI_APP_FORCE_SECURE_COOKIES", default=True),
        "trust_proxy_headers": _as_bool("MINI_APP_TRUST_PROXY_HEADERS", default=False),
        "allowed_origins": _parse_allowed_origins(os.environ.get("MINI_APP_ALLOWED_ORIGINS", "")),
        "enforce_origin_check": _as_bool("MINI_APP_ENFORCE_ORIGIN_CHECK", default=False),
        "rate_limit_window_seconds": _as_int_in_range(
            "MINI_APP_RATE_LIMIT_WINDOW_SECONDS",
            60,
            min_value=5,
            max_value=3600,
        ),
        "rate_limit_api_requests": _as_int_in_range(
            "MINI_APP_RATE_LIMIT_API_REQUESTS",
            180,
            min_value=1,
            max_value=10000,
        ),
        "rate_limit_stream_requests": _as_int_in_range(
            "MINI_APP_RATE_LIMIT_STREAM_REQUESTS",
            24,
            min_value=1,
            max_value=1000,
        ),
        "enable_hsts": _as_bool("MINI_APP_ENABLE_HSTS", default=False),
    }


def _parse_ui_settings() -> dict[str, bool]:
    return {
        "mobile_tab_carousel_enabled": _as_bool_any(
            "MINI_APP_MOBILE_TAB_CAROUSEL",
            "MINIAPP_MOBILE_TAB_CAROUSEL",
            default=False,
        ),
        "tab_actions_menu_enabled": _as_bool_any(
            "MINI_APP_TAB_ACTIONS_MENU",
            "MINIAPP_TAB_ACTIONS_MENU",
            default=False,
        ),
    }


def _parse_dev_auth_settings() -> dict[str, bool | str | int | None]:
    return {
        "dev_auth_enabled": _as_bool_any("MINIAPP_DEV_BYPASS", "MINI_APP_DEV_BYPASS", default=False),
        "dev_auth_secret": str(
            os.environ.get("MINIAPP_DEV_SECRET")
            or os.environ.get("MINI_APP_DEV_AUTH_SECRET")
            or os.environ.get("MINI_APP_DEV_SECRET")
            or ""
        ).strip(),
        "dev_auth_expires_at_epoch": _as_optional_int_any(
            "MINIAPP_DEV_BYPASS_EXPIRES_AT",
            "MINI_APP_DEV_BYPASS_EXPIRES_AT",
        ),
    }


def _parse_job_history_settings() -> dict[str, int]:
    return {
        "job_event_history_max_jobs": _as_int_in_range(
            "MINI_APP_JOB_EVENT_HISTORY_MAX_JOBS",
            DEFAULT_JOB_EVENT_HISTORY_MAX_JOBS,
            min_value=MIN_JOB_EVENT_HISTORY_MAX_JOBS,
            max_value=10000,
        ),
        "job_event_history_ttl_seconds": _as_int_in_range(
            "MINI_APP_JOB_EVENT_HISTORY_TTL_SECONDS",
            DEFAULT_JOB_EVENT_HISTORY_TTL_SECONDS,
            min_value=MIN_JOB_EVENT_HISTORY_TTL_SECONDS,
            max_value=86400,
        ),
    }


def _parse_visual_dev_settings(base_dir: Path) -> dict[str, bool | int | Path | set[str]]:
    return {
        "visual_dev_enabled": _as_bool("MINI_APP_VISUAL_DEV_ENABLED", default=False),
        "visual_dev_operator_only": _as_bool("MINI_APP_VISUAL_DEV_OPERATOR_ONLY", default=True),
        "visual_dev_allowed_preview_origins": _parse_allowed_origins(
            os.environ.get("MINI_APP_VISUAL_DEV_ALLOWED_PREVIEW_ORIGINS", ""),
            env_name="MINI_APP_VISUAL_DEV_ALLOWED_PREVIEW_ORIGINS",
        ),
        "visual_dev_bridge_allowed_parents": _parse_allowed_origins(
            os.environ.get("MINI_APP_VISUAL_DEV_BRIDGE_ALLOWED_PARENTS", ""),
            env_name="MINI_APP_VISUAL_DEV_BRIDGE_ALLOWED_PARENTS",
        ),
        "visual_dev_artifact_dir": _as_path(
            "MINI_APP_VISUAL_DEV_ARTIFACT_DIR",
            base_dir / "visual-dev-artifacts",
        ),
        "visual_dev_max_console_events": _as_int_in_range(
            "MINI_APP_VISUAL_DEV_MAX_CONSOLE_EVENTS",
            200,
            min_value=1,
            max_value=5000,
        ),
        "visual_dev_screenshot_max_bytes": _as_int_in_range(
            "MINI_APP_VISUAL_DEV_SCREENSHOT_MAX_BYTES",
            2 * 1024 * 1024,
            min_value=1024,
            max_value=50 * 1024 * 1024,
        ),
    }


def _default_dev_reload_watch_paths(base_dir: Path) -> tuple[Path, ...]:
    return (
        base_dir / "server.py",
        base_dir / "templates" / "app.html",
        base_dir / "static" / "app.css",
        base_dir / "static" / "app.js",
    )


def _as_int(name: str, default: int) -> int:
    return int(os.environ.get(name, str(default)))


def _as_int_in_range(name: str, default: int, *, min_value: int, max_value: int) -> int:
    value = _as_int(name, default)
    if value < min_value or value > max_value:
        raise ValueError(f"{name} must be between {min_value} and {max_value}")
    return value


def _as_bool(name: str, *, default: bool) -> bool:
    default_raw = "1" if default else "0"
    return os.environ.get(name, default_raw) == "1"


def _as_bool_any(*names: str, default: bool) -> bool:
    for name in names:
        raw = os.environ.get(name)
        if raw is not None:
            return raw == "1"
    return default


def _as_choice(name: str, default: str, allowed: set[str]) -> str:
    raw = str(os.environ.get(name, default)).strip().lower()
    if raw not in allowed:
        allowed_text = ", ".join(sorted(allowed))
        raise ValueError(f"{name} must be one of: {allowed_text}")
    return raw


def _as_path(name: str, default: Path) -> Path:
    raw = str(os.environ.get(name, "")).strip()
    if not raw:
        return default
    return Path(raw).expanduser()


def _as_optional_int_any(*names: str) -> int | None:
    for name in names:
        raw = os.environ.get(name)
        if raw is None:
            continue
        stripped = str(raw).strip()
        if not stripped:
            return None
        return int(stripped)
    return None


def _now_epoch_seconds() -> int:
    import time

    return int(time.time())


def _resolve_persistent_runtime_ownership(*, ownership_mode: str, job_worker_launcher: str) -> str:
    safe_mode = str(ownership_mode or "").strip().lower()
    safe_launcher = str(job_worker_launcher or "").strip().lower()
    if safe_launcher == "subprocess":
        return "checkpoint_only"
    if safe_mode == "auto":
        return "shared"
    return safe_mode
