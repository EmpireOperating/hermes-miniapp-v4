from __future__ import annotations

import json
import time
import uuid
from typing import Any

from flask import Request


def new_request_id() -> str:
    return uuid.uuid4().hex[:16]


def now_ms() -> float:
    return time.perf_counter() * 1000.0


def build_request_log(*, request: Request, request_id: str, status_code: int, elapsed_ms: int) -> str:
    payload: dict[str, Any] = {
        "event": "http_request",
        "request_id": request_id,
        "method": request.method,
        "path": request.path,
        "status": int(status_code),
        "elapsed_ms": int(elapsed_ms),
        "remote_addr": request.remote_addr,
    }
    return json.dumps(payload, separators=(",", ":"), ensure_ascii=False)


def build_job_log(*, event: str, request_id: str | None, chat_id: int, job_id: int | None = None, extra: dict[str, Any] | None = None) -> str:
    payload: dict[str, Any] = {
        "event": event,
        "request_id": request_id,
        "chat_id": int(chat_id),
    }
    if job_id is not None:
        payload["job_id"] = int(job_id)
    if extra:
        payload.update(extra)
    return json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
