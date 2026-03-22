from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Any


class HermesClientError(RuntimeError):
    """Raised when Hermes cannot produce a response."""


@dataclass(slots=True)
class HermesReply:
    """Normalized Hermes reply payload."""

    text: str
    source: str
    latency_ms: int


@dataclass(slots=True)
class _PersistentRuntime:
    session_id: str
    agent: Any
    model: str | None
    max_iterations: int
    lock: threading.Lock
    last_used_at: float
    bootstrapped: bool = False
    checkpoint_history: list[dict[str, str]] | None = None


class PersistentSessionManager:
    """Owns long-lived AIAgent runtimes keyed by miniapp session_id."""

    def __init__(self, *, max_sessions: int = 64, idle_ttl_seconds: int = 1800) -> None:
        self.max_sessions = max(1, int(max_sessions or 64))
        self.idle_ttl_seconds = max(60, int(idle_ttl_seconds or 1800))
        self._lock = threading.Lock()
        self._runtimes: dict[str, _PersistentRuntime] = {}

    def get_or_create(
        self,
        *,
        session_id: str,
        model: str | None,
        max_iterations: int,
        create_agent: callable,
    ) -> _PersistentRuntime:
        now = time.time()
        with self._lock:
            self._prune_locked(now)
            runtime = self._runtimes.get(session_id)
            if runtime and runtime.model == model and runtime.max_iterations == max_iterations:
                runtime.last_used_at = now
                return runtime

            agent = create_agent()
            runtime = _PersistentRuntime(
                session_id=session_id,
                agent=agent,
                model=model,
                max_iterations=max_iterations,
                lock=threading.Lock(),
                last_used_at=now,
            )
            self._runtimes[session_id] = runtime

            if len(self._runtimes) > self.max_sessions:
                oldest_session_id = min(self._runtimes.items(), key=lambda item: item[1].last_used_at)[0]
                if oldest_session_id != session_id:
                    self._runtimes.pop(oldest_session_id, None)
            return runtime

    def get_runtime(self, session_id: str) -> _PersistentRuntime | None:
        now = time.time()
        with self._lock:
            self._prune_locked(now)
            runtime = self._runtimes.get(session_id)
            if runtime:
                runtime.last_used_at = now
            return runtime

    def evict(self, session_id: str) -> bool:
        with self._lock:
            return self._runtimes.pop(session_id, None) is not None

    def stats(self) -> dict[str, int]:
        now = time.time()
        with self._lock:
            self._prune_locked(now)
            total = len(self._runtimes)
            bootstrapped = sum(1 for runtime in self._runtimes.values() if runtime.bootstrapped)
            return {
                "total": total,
                "bootstrapped": bootstrapped,
                "unbootstrapped": max(0, total - bootstrapped),
            }

    def _prune_locked(self, now: float) -> None:
        cutoff = now - self.idle_ttl_seconds
        stale = [session_id for session_id, runtime in self._runtimes.items() if runtime.last_used_at < cutoff]
        for session_id in stale:
            self._runtimes.pop(session_id, None)
