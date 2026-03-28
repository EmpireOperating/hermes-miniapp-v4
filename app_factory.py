from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from flask import Flask
from werkzeug.middleware.proxy_fix import ProxyFix

from job_runtime import JobRuntime
from rate_limiter import SlidingWindowRateLimiter


@dataclass(frozen=True, slots=True)
class AppRuntimeDependencies:
    store_getter: Callable[[], Any]
    client_getter: Callable[[], Any]
    runtime: JobRuntime
    rate_limiter: SlidingWindowRateLimiter

    def bind_runtime(self) -> JobRuntime:
        # Keep runtime wiring aligned with active app dependencies.
        self.runtime.store = self.store_getter()
        self.runtime.client = self.client_getter()
        return self.runtime

    @property
    def runtime_getter(self) -> Callable[[], JobRuntime]:
        return lambda: self.bind_runtime()

    @property
    def job_wake_event_getter(self) -> Callable[[], Any]:
        return lambda: self.runtime.wake_event


def create_runtime_dependencies(
    *,
    store_getter: Callable[[], Any],
    client_getter: Callable[[], Any],
    job_max_attempts: int,
    job_retry_base_seconds: int,
    job_worker_concurrency: int,
    job_stall_timeout_seconds: int,
    assistant_chunk_len: int,
    assistant_hard_limit: int,
    job_event_history_max_jobs: int,
    job_event_history_ttl_seconds: int,
    session_id_builder: Callable[[str, int], str],
) -> AppRuntimeDependencies:
    runtime = JobRuntime(
        store=store_getter(),
        client=client_getter(),
        job_max_attempts=job_max_attempts,
        job_retry_base_seconds=job_retry_base_seconds,
        job_worker_concurrency=job_worker_concurrency,
        job_stall_timeout_seconds=job_stall_timeout_seconds,
        assistant_chunk_len=assistant_chunk_len,
        assistant_hard_limit=assistant_hard_limit,
        job_event_history_max_jobs=job_event_history_max_jobs,
        job_event_history_ttl_seconds=job_event_history_ttl_seconds,
        session_id_builder=session_id_builder,
    )
    return AppRuntimeDependencies(
        store_getter=store_getter,
        client_getter=client_getter,
        runtime=runtime,
        rate_limiter=SlidingWindowRateLimiter(),
    )


def create_flask_app(
    *,
    base_dir: Path,
    trust_proxy_headers: bool,
    max_content_length: int,
    debug: bool,
    dev_reload: bool,
) -> Flask:
    app = Flask(__name__, template_folder=str(base_dir / "templates"), static_folder=str(base_dir / "static"))
    if trust_proxy_headers:
        app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_port=1)  # type: ignore[assignment]
    app.config["MAX_CONTENT_LENGTH"] = max_content_length
    app.config["TEMPLATES_AUTO_RELOAD"] = debug or dev_reload
    app.jinja_env.auto_reload = debug or dev_reload
    return app
