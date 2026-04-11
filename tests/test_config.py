from __future__ import annotations

import pytest

from miniapp_config import MiniAppConfig
from runtime_limits import (
    DEFAULT_JOB_EVENT_HISTORY_MAX_JOBS,
    DEFAULT_JOB_EVENT_HISTORY_TTL_SECONDS,
    MIN_JOB_STALL_TIMEOUT_SECONDS,
)


def _cfg() -> MiniAppConfig:
    return MiniAppConfig.from_env()


@pytest.fixture(autouse=True)
def _clear_ambient_miniapp_env(monkeypatch) -> None:
    for key in (
        "MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP",
        "MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP_REQUESTED",
        "MINI_APP_JOB_WORKER_LAUNCHER",
        "MINI_APP_WARM_WORKER_REUSE",
        "MINI_APP_WARM_WORKER_SAME_CHAT_ONLY",
        "MINI_APP_WARM_WORKER_RETIRE_AFTER_RUNS",
        "MINI_APP_WARM_WORKER_HEALTH_MAX_RSS_MB",
        "MINI_APP_WARM_WORKER_HEALTH_MAX_THREADS",
    ):
        monkeypatch.delenv(key, raising=False)


def test_config_normalizes_allowed_origins(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_ALLOWED_ORIGINS", " https://APP.EXAMPLE.COM/ ,https://api.example.com ")

    cfg = _cfg()

    assert cfg.allowed_origins == {"https://app.example.com", "https://api.example.com"}


def test_config_rejects_invalid_allowed_origin(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_ALLOWED_ORIGINS", "not-a-url")

    with pytest.raises(ValueError, match="Invalid origin"):
        _cfg()


def test_config_rejects_non_positive_max_content_length(monkeypatch) -> None:
    monkeypatch.setenv("MAX_CONTENT_LENGTH", "0")

    with pytest.raises(ValueError, match="MAX_CONTENT_LENGTH"):
        _cfg()


def test_config_disables_proxy_header_trust_by_default(monkeypatch) -> None:
    monkeypatch.delenv("MINI_APP_TRUST_PROXY_HEADERS", raising=False)

    cfg = _cfg()

    assert cfg.trust_proxy_headers is False


def test_config_rejects_invalid_worker_concurrency(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_JOB_WORKER_CONCURRENCY", "0")

    with pytest.raises(ValueError, match="MINI_APP_JOB_WORKER_CONCURRENCY"):
        _cfg()


def test_config_rejects_invalid_worker_launcher_mode(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_JOB_WORKER_LAUNCHER", "bogus")

    with pytest.raises(ValueError, match="MINI_APP_JOB_WORKER_LAUNCHER"):
        _cfg()


def test_config_accepts_subprocess_worker_launcher_mode(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_JOB_WORKER_LAUNCHER", "subprocess")

    cfg = _cfg()

    assert cfg.job_worker_launcher == "subprocess"
    assert cfg.resolved_persistent_runtime_ownership() == "checkpoint_only"


def test_config_rejects_invalid_persistent_runtime_ownership(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP", "bogus")

    with pytest.raises(ValueError, match="MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP"):
        _cfg()


def test_config_preserves_requested_shared_ownership_while_resolving_subprocess_launcher(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_JOB_WORKER_LAUNCHER", "subprocess")
    monkeypatch.setenv("MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP", "shared")

    cfg = _cfg()

    assert cfg.persistent_runtime_ownership == "shared"
    assert cfg.resolved_persistent_runtime_ownership() == "checkpoint_only"


def test_config_resolves_shared_persistent_ownership_for_inline_launcher(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_JOB_WORKER_LAUNCHER", "inline")
    monkeypatch.setenv("MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP", "auto")

    cfg = _cfg()

    assert cfg.resolved_persistent_runtime_ownership() == "shared"


def test_config_rejects_invalid_subprocess_worker_timeout(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_JOB_WORKER_SUBPROCESS_TIMEOUT_SECONDS", "0")

    with pytest.raises(ValueError, match="MINI_APP_JOB_WORKER_SUBPROCESS_TIMEOUT_SECONDS"):
        _cfg()


def test_config_rejects_invalid_subprocess_worker_stderr_excerpt_bytes(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_JOB_WORKER_SUBPROCESS_STDERR_EXCERPT_BYTES", "128")

    with pytest.raises(ValueError, match="MINI_APP_JOB_WORKER_SUBPROCESS_STDERR_EXCERPT_BYTES"):
        _cfg()


def test_config_rejects_invalid_subprocess_worker_memory_limit_mb(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_JOB_WORKER_SUBPROCESS_MEMORY_LIMIT_MB", "64")

    with pytest.raises(ValueError, match="MINI_APP_JOB_WORKER_SUBPROCESS_MEMORY_LIMIT_MB"):
        _cfg()


def test_config_accepts_subprocess_worker_hardening_bounds(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_JOB_WORKER_SUBPROCESS_TIMEOUT_SECONDS", "45")
    monkeypatch.setenv("MINI_APP_JOB_WORKER_SUBPROCESS_KILL_GRACE_SECONDS", "3")
    monkeypatch.setenv("MINI_APP_JOB_WORKER_SUBPROCESS_STDERR_EXCERPT_BYTES", "8192")
    monkeypatch.setenv("MINI_APP_JOB_WORKER_SUBPROCESS_MEMORY_LIMIT_MB", "1536")
    monkeypatch.setenv("MINI_APP_JOB_WORKER_SUBPROCESS_MAX_TASKS", "128")
    monkeypatch.setenv("MINI_APP_JOB_WORKER_SUBPROCESS_MAX_OPEN_FILES", "512")

    cfg = _cfg()

    assert cfg.job_worker_subprocess_timeout_seconds == 45
    assert cfg.job_worker_subprocess_kill_grace_seconds == 3
    assert cfg.job_worker_subprocess_stderr_excerpt_bytes == 8192
    assert cfg.job_worker_subprocess_memory_limit_mb == 1536
    assert cfg.job_worker_subprocess_max_tasks == 128
    assert cfg.job_worker_subprocess_max_open_files == 512


def test_config_accepts_warm_worker_reuse_bounds(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_WARM_WORKER_REUSE", "1")
    monkeypatch.setenv("MINI_APP_WARM_WORKER_SAME_CHAT_ONLY", "1")
    monkeypatch.setenv("MINI_APP_WARM_WORKER_IDLE_TTL_SECONDS", "240")
    monkeypatch.setenv("MINI_APP_WARM_WORKER_MAX_IDLE", "3")
    monkeypatch.setenv("MINI_APP_WARM_WORKER_MAX_TOTAL", "5")
    monkeypatch.setenv("MINI_APP_WARM_WORKER_RETIRE_AFTER_RUNS", "4")
    monkeypatch.setenv("MINI_APP_WARM_WORKER_HEALTH_MAX_RSS_MB", "1200")
    monkeypatch.setenv("MINI_APP_WARM_WORKER_HEALTH_MAX_THREADS", "32")

    cfg = _cfg()

    assert cfg.warm_worker_reuse_enabled is True
    assert cfg.warm_worker_same_chat_only is True
    assert cfg.warm_worker_idle_ttl_seconds == 240
    assert cfg.warm_worker_max_idle == 3
    assert cfg.warm_worker_max_total == 5
    assert cfg.warm_worker_retire_after_runs == 4
    assert cfg.warm_worker_health_max_rss_mb == 1200
    assert cfg.warm_worker_health_max_threads == 32


def test_config_rejects_invalid_warm_worker_caps(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_WARM_WORKER_MAX_IDLE", "4")
    monkeypatch.setenv("MINI_APP_WARM_WORKER_MAX_TOTAL", "3")

    with pytest.raises(ValueError, match="MINI_APP_WARM_WORKER_MAX_TOTAL"):
        _cfg()


def test_config_rejects_invalid_rate_limit_window(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_RATE_LIMIT_WINDOW_SECONDS", "4")

    with pytest.raises(ValueError, match="MINI_APP_RATE_LIMIT_WINDOW_SECONDS"):
        _cfg()


def test_config_uses_centralized_runtime_limit_defaults(monkeypatch) -> None:
    monkeypatch.delenv("MINI_APP_JOB_EVENT_HISTORY_MAX_JOBS", raising=False)
    monkeypatch.delenv("MINI_APP_JOB_EVENT_HISTORY_TTL_SECONDS", raising=False)
    monkeypatch.delenv("MINI_APP_JOB_STALL_TIMEOUT_SECONDS", raising=False)

    cfg = _cfg()

    assert cfg.job_event_history_max_jobs == DEFAULT_JOB_EVENT_HISTORY_MAX_JOBS
    assert cfg.job_event_history_ttl_seconds == DEFAULT_JOB_EVENT_HISTORY_TTL_SECONDS
    assert cfg.job_stall_timeout_seconds >= MIN_JOB_STALL_TIMEOUT_SECONDS


def test_config_reads_mobile_tab_carousel_feature_flag(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_MOBILE_TAB_CAROUSEL", "1")

    cfg = _cfg()

    assert cfg.mobile_tab_carousel_enabled is True
