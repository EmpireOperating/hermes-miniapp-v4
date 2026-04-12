from __future__ import annotations

import threading
import time
from dataclasses import dataclass, replace
from typing import Any, Protocol

from hermes_client_warm_session_helpers import (
    build_owner_state_payload as helper_build_owner_state_payload,
    build_owner_state_summary as helper_build_owner_state_summary,
    build_reusable_candidate_payload as helper_build_reusable_candidate_payload,
    build_reuse_contract,
    build_worker_event_detail as helper_build_worker_event_detail,
    classify_reusable_candidate_expiration,
)


class HermesClientError(RuntimeError):
    """Raised when Hermes cannot produce a response."""


@dataclass(slots=True)
class HermesReply:
    """Normalized Hermes reply payload."""

    text: str
    source: str
    latency_ms: int


@dataclass(slots=True)
class WarmSessionContract:
    """Explicit contract for miniapp warm-session ownership semantics."""

    current_mode: str
    owner: str
    owner_class: str
    lifecycle_state: str
    lifecycle_scope: str
    eviction_policy: str
    requested: bool
    enabled: bool
    ownership: str
    launcher: str
    target_mode: str
    target_status: str
    safety_reason: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "current_mode": str(self.current_mode or "unknown"),
            "owner": str(self.owner or "unknown"),
            "owner_class": str(self.owner_class or "unknown"),
            "lifecycle_state": str(self.lifecycle_state or "unknown"),
            "lifecycle_scope": str(self.lifecycle_scope or "unknown"),
            "eviction_policy": str(self.eviction_policy or "unknown"),
            "requested": bool(self.requested),
            "enabled": bool(self.enabled),
            "ownership": str(self.ownership or "unknown"),
            "launcher": str(self.launcher or "unknown"),
            "target_mode": str(self.target_mode or "unknown"),
            "target_status": str(self.target_status or "unknown"),
            "safety_reason": str(self.safety_reason or ""),
        }


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


@dataclass(slots=True)
class WarmSessionOwnerEvent:
    event: str
    session_id: str
    owner_class: str
    monotonic_ms: int
    detail: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "event": str(self.event or "unknown"),
            "session_id": str(self.session_id or ""),
            "owner_class": str(self.owner_class or "unknown"),
            "monotonic_ms": int(self.monotonic_ms or 0),
            "detail": str(self.detail or ""),
        }


@dataclass(slots=True)
class WarmSessionOwnerRecord:
    session_id: str
    owner_class: str
    state: str
    lifecycle_phase: str
    reusable: bool
    reusability_reason: str
    chat_id: int | None = None
    job_id: int | None = None
    owner_pid: int | None = None
    last_outcome: str | None = None
    last_started_monotonic_ms: int | None = None
    last_finished_monotonic_ms: int | None = None
    reusable_until_monotonic_ms: int | None = None
    attach_transport_kind: str | None = None
    attach_worker_endpoint: str | None = None
    attach_resume_token: str | None = None
    attach_resume_deadline_ms: int | None = None
    run_count: int = 0
    last_health_monotonic_ms: int | None = None
    last_known_rss_kb: int | None = None
    last_known_thread_count: int | None = None
    health_status: str | None = None
    health_reason: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "session_id": str(self.session_id or ""),
            "owner_class": str(self.owner_class or "unknown"),
            "state": str(self.state or "unknown"),
            "lifecycle_phase": str(self.lifecycle_phase or "unknown"),
            "reusable": bool(self.reusable),
            "reusability_reason": str(self.reusability_reason or "unknown"),
            "chat_id": self.chat_id,
            "job_id": self.job_id,
            "owner_pid": self.owner_pid,
            "last_outcome": self.last_outcome,
            "last_started_monotonic_ms": self.last_started_monotonic_ms,
            "last_finished_monotonic_ms": self.last_finished_monotonic_ms,
            "reusable_until_monotonic_ms": self.reusable_until_monotonic_ms,
            "attach_transport_kind": self.attach_transport_kind,
            "attach_worker_endpoint": self.attach_worker_endpoint,
            "attach_resume_token": self.attach_resume_token,
            "attach_resume_deadline_ms": self.attach_resume_deadline_ms,
            "run_count": int(self.run_count or 0),
            "last_health_monotonic_ms": self.last_health_monotonic_ms,
            "last_known_rss_kb": self.last_known_rss_kb,
            "last_known_thread_count": self.last_known_thread_count,
            "health_status": self.health_status,
            "health_reason": self.health_reason,
        }


class WarmSessionRegistry(Protocol):
    """Abstraction for warm miniapp session ownership registries."""

    def get_or_create(
        self,
        *,
        session_id: str,
        model: str | None,
        max_iterations: int,
        create_agent: callable,
    ) -> _PersistentRuntime:
        ...

    def get_runtime(self, session_id: str) -> _PersistentRuntime | None:
        ...

    def evict(self, session_id: str, *, reason: str = "explicit_eviction") -> bool:
        ...

    def stats(self) -> dict[str, int]:
        ...

    def owner_events(self, *, limit: int = 16) -> list[dict[str, Any]]:
        ...

    def owner_state(self) -> dict[str, Any]:
        ...

    def select_reusable_candidate(self, session_id: str) -> dict[str, Any] | None:
        ...


class IsolatedWorkerWarmSessionRegistryScaffold:
    """Scaffold registry for future isolated-worker-owned warm sessions.

    This does not own live runtimes yet. It exists to give the architecture a
    distinct registry surface and diagnostics path while subprocess mode remains
    checkpoint-only.
    """

    def __init__(
        self,
        *,
        reusable_candidate_ttl_ms: int = 120000,
        warm_worker_reuse_enabled: bool = False,
        same_chat_only: bool = True,
        max_idle_workers: int = 2,
        max_total_workers: int = 4,
    ) -> None:
        self._lock = threading.RLock()
        self._owner_events: list[WarmSessionOwnerEvent] = []
        self._owner_events_limit = 128
        self._owner_records: dict[str, WarmSessionOwnerRecord] = {}
        self._reusable_candidate_ttl_ms = max(1000, int(reusable_candidate_ttl_ms or 120000))
        self._warm_worker_reuse_enabled = bool(warm_worker_reuse_enabled)
        self._same_chat_only = bool(same_chat_only)
        self._max_idle_workers = max(0, int(max_idle_workers or 0))
        self._max_total_workers = max(1, int(max_total_workers or 1))
        self._record_owner_event(
            event="scaffold_initialized",
            session_id="",
            detail=(
                f"reusable_candidate_ttl_ms={self._reusable_candidate_ttl_ms};"
                f"warm_worker_reuse_enabled={int(self._warm_worker_reuse_enabled)};"
                f"same_chat_only={int(self._same_chat_only)};"
                f"max_idle_workers={self._max_idle_workers};"
                f"max_total_workers={self._max_total_workers}"
            ),
        )

    def _replace_record(self, record: WarmSessionOwnerRecord, **updates: Any) -> WarmSessionOwnerRecord:
        return replace(record, **updates)

    def _monotonic_ms(self) -> int:
        return int(time.monotonic() * 1000)

    def _normalize_optional_int(self, value: Any) -> int | None:
        return int(value) if value not in {None, ""} else None

    def _normalize_optional_str(self, value: Any) -> str | None:
        return str(value or "") or None

    def _preserve_existing_runtime_fields(self, existing: WarmSessionOwnerRecord | None) -> dict[str, Any]:
        if not isinstance(existing, WarmSessionOwnerRecord):
            return {
                "run_count": 1,
                "last_health_monotonic_ms": None,
                "last_known_rss_kb": None,
                "last_known_thread_count": None,
                "health_status": None,
                "health_reason": None,
            }
        return {
            "run_count": int(existing.run_count or 0),
            "last_health_monotonic_ms": existing.last_health_monotonic_ms,
            "last_known_rss_kb": existing.last_known_rss_kb,
            "last_known_thread_count": existing.last_known_thread_count,
            "health_status": existing.health_status,
            "health_reason": existing.health_reason,
        }

    def _base_record_kwargs(self, session_key: str, existing: WarmSessionOwnerRecord | None) -> dict[str, Any]:
        preserved = self._preserve_existing_runtime_fields(existing)
        return {
            "session_id": session_key,
            "owner_class": type(self).__name__,
            "last_health_monotonic_ms": preserved["last_health_monotonic_ms"],
            "last_known_rss_kb": preserved["last_known_rss_kb"],
            "last_known_thread_count": preserved["last_known_thread_count"],
            "health_status": preserved["health_status"],
            "health_reason": preserved["health_reason"],
        }

    def _build_started_record(
        self,
        *,
        session_key: str,
        chat_id: int | None,
        job_id: int | None,
        owner_pid: int | None,
        started_ms: int,
        existing: WarmSessionOwnerRecord | None,
    ) -> WarmSessionOwnerRecord:
        base = self._base_record_kwargs(session_key, existing)
        preserved = self._preserve_existing_runtime_fields(existing)
        return WarmSessionOwnerRecord(
            **base,
            state="running",
            lifecycle_phase="active_attempt",
            reusable=False,
            reusability_reason="worker_attempt_in_progress",
            chat_id=chat_id,
            job_id=job_id,
            owner_pid=owner_pid,
            last_started_monotonic_ms=started_ms,
            reusable_until_monotonic_ms=None,
            attach_transport_kind=None,
            attach_worker_endpoint=None,
            attach_resume_token=None,
            attach_resume_deadline_ms=None,
            run_count=(preserved["run_count"] + 1) if isinstance(existing, WarmSessionOwnerRecord) else 1,
        )

    def _build_attach_ready_record(
        self,
        *,
        session_key: str,
        existing: WarmSessionOwnerRecord | None,
        owner_pid: int | None,
        transport_kind: str | None,
        worker_endpoint: str | None,
        resume_token: str | None,
        resume_deadline_ms: int | None,
    ) -> WarmSessionOwnerRecord:
        if not isinstance(existing, WarmSessionOwnerRecord):
            existing = WarmSessionOwnerRecord(
                session_id=session_key,
                owner_class=type(self).__name__,
                state="running",
                lifecycle_phase="active_attempt",
                reusable=False,
                reusability_reason="worker_attempt_in_progress",
            )
        return self._replace_record(
            existing,
            state="attachable_running",
            reusable=True,
            reusability_reason="worker_attach_live_available",
            owner_pid=owner_pid if owner_pid is not None else existing.owner_pid,
            attach_transport_kind=self._normalize_optional_str(transport_kind),
            attach_worker_endpoint=self._normalize_optional_str(worker_endpoint),
            attach_resume_token=self._normalize_optional_str(resume_token),
            attach_resume_deadline_ms=self._normalize_optional_int(resume_deadline_ms),
        )

    def _build_finished_record(
        self,
        *,
        session_key: str,
        existing: WarmSessionOwnerRecord | None,
        normalized_outcome: str,
        chat_id: int | None,
        job_id: int | None,
        owner_pid: int | None,
        started_ms: int | None,
        finished_ms: int,
    ) -> WarmSessionOwnerRecord:
        if isinstance(existing, WarmSessionOwnerRecord) and str(existing.state or "") == "evicted":
            return self._replace_record(
                existing,
                state="evicted",
                lifecycle_phase="invalidated",
                reusable=False,
                chat_id=existing.chat_id if existing.chat_id is not None else chat_id,
                job_id=existing.job_id if existing.job_id is not None else job_id,
                owner_pid=existing.owner_pid if existing.owner_pid is not None else owner_pid,
                last_outcome=normalized_outcome,
                last_started_monotonic_ms=started_ms,
                last_finished_monotonic_ms=finished_ms,
            )
        if (
            isinstance(existing, WarmSessionOwnerRecord)
            and str(existing.state or "") == "attachable_running"
            and bool(existing.attach_worker_endpoint)
            and bool(existing.attach_resume_token)
        ):
            return self._replace_record(
                existing,
                state="attachable_running",
                reusable=True,
                reusability_reason=existing.reusability_reason or "worker_attach_live_available",
                chat_id=existing.chat_id if existing.chat_id is not None else chat_id,
                job_id=existing.job_id if existing.job_id is not None else job_id,
                owner_pid=existing.owner_pid if existing.owner_pid is not None else owner_pid,
                last_outcome=normalized_outcome,
                last_started_monotonic_ms=started_ms,
                last_finished_monotonic_ms=finished_ms,
            )
        reusable = normalized_outcome in {"completed", "success", "warm_reusable_candidate"}
        reusable_until = finished_ms + self._reusable_candidate_ttl_ms if reusable else None
        reusability_reason = "isolated_worker_warm_reuse_not_implemented" if reusable else f"non_reusable_outcome:{normalized_outcome}"
        base = self._base_record_kwargs(session_key, existing)
        preserved = self._preserve_existing_runtime_fields(existing)
        return WarmSessionOwnerRecord(
            **base,
            state="reusable_candidate" if reusable else "finished",
            lifecycle_phase="post_attempt",
            reusable=reusable,
            reusability_reason=reusability_reason,
            chat_id=chat_id,
            job_id=job_id,
            owner_pid=owner_pid,
            last_outcome=normalized_outcome,
            last_started_monotonic_ms=started_ms,
            last_finished_monotonic_ms=finished_ms,
            reusable_until_monotonic_ms=reusable_until,
            attach_transport_kind=None,
            attach_worker_endpoint=None,
            attach_resume_token=None,
            attach_resume_deadline_ms=None,
            run_count=preserved["run_count"] if isinstance(existing, WarmSessionOwnerRecord) else 1,
        )

    def _build_owner_state_summary(self, records: list[dict[str, Any]]) -> dict[str, Any]:
        return helper_build_owner_state_summary(records)

    def _build_reusable_candidate_payload(self, record: WarmSessionOwnerRecord) -> dict[str, Any] | None:
        return helper_build_reusable_candidate_payload(record)


    def _build_owner_state_payload(
        self,
        *,
        records: list[dict[str, Any]],
        recent_events: list[dict[str, Any]],
    ) -> dict[str, Any]:
        return helper_build_owner_state_payload(
            owner_class=type(self).__name__,
            records=records,
            recent_events=recent_events,
            reusable_candidate_ttl_ms=self._reusable_candidate_ttl_ms,
            warm_worker_reuse_enabled=self._warm_worker_reuse_enabled,
            same_chat_only=self._same_chat_only,
            max_idle_workers=self._max_idle_workers,
            max_total_workers=self._max_total_workers,
        )

    def _update_owner_record(self, session_key: str, record: WarmSessionOwnerRecord) -> WarmSessionOwnerRecord:
        self._owner_records[session_key] = record
        return record

    def _build_worker_event_detail(
        self,
        *,
        chat_id: int | None = None,
        job_id: int | None = None,
        owner_pid: int | None = None,
        outcome: str | None = None,
        transport_kind: str | None = None,
        worker_endpoint: str | None = None,
        resume_deadline_ms: int | None = None,
        rss_kb: int | None = None,
        thread_count: int | None = None,
        health_status: str | None = None,
        health_reason: str | None = None,
    ) -> str:
        return helper_build_worker_event_detail(
            chat_id=chat_id,
            job_id=job_id,
            owner_pid=owner_pid,
            outcome=outcome,
            transport_kind=transport_kind,
            worker_endpoint=worker_endpoint,
            resume_deadline_ms=resume_deadline_ms,
            rss_kb=rss_kb,
            thread_count=thread_count,
            health_status=health_status,
            health_reason=health_reason,
        )

    def _record_owner_event_locked(self, *, event: str, session_id: str, detail: str = "") -> None:
        self._owner_events.append(
            WarmSessionOwnerEvent(
                event=str(event or "unknown"),
                session_id=str(session_id or ""),
                owner_class=type(self).__name__,
                monotonic_ms=int(time.monotonic() * 1000),
                detail=str(detail or ""),
            )
        )
        if len(self._owner_events) > self._owner_events_limit:
            overflow = len(self._owner_events) - self._owner_events_limit
            if overflow > 0:
                del self._owner_events[:overflow]

    def _record_owner_event(self, *, event: str, session_id: str, detail: str = "") -> None:
        with self._lock:
            self._record_owner_event_locked(event=event, session_id=session_id, detail=detail)

    def get_or_create(
        self,
        *,
        session_id: str,
        model: str | None,
        max_iterations: int,
        create_agent: callable,
    ) -> _PersistentRuntime:
        with self._lock:
            self._record_owner_event(event="create_rejected", session_id=session_id, detail="isolated_worker_not_implemented")
        raise HermesClientError("Isolated worker warm sessions are not implemented yet.")

    def get_runtime(self, session_id: str) -> _PersistentRuntime | None:
        with self._lock:
            self._record_owner_event(event="lookup", session_id=session_id, detail="no_live_owner")
            return None

    def evict(self, session_id: str, *, reason: str = "explicit_eviction") -> bool:
        with self._lock:
            session_key = str(session_id or "")
            safe_reason = str(reason or "explicit_eviction")
            existing = self._owner_records.get(session_key)
            if isinstance(existing, WarmSessionOwnerRecord):
                self._owner_records[session_key] = self._replace_record(
                    existing,
                    state="evicted",
                    lifecycle_phase="invalidated",
                    reusable=False,
                    reusability_reason=safe_reason,
                )
                self._record_owner_event(event="evicted_explicit", session_id=session_id, detail=f"invalidated_by={safe_reason}")
                return True
            self._record_owner_event(event="evict_noop", session_id=session_id, detail=f"reason={safe_reason};no_live_owner")
            return False

    def stats(self) -> dict[str, int | bool]:
        with self._lock:
            records = list(self._owner_records.values())
            return {
                "total": len(records),
                "bootstrapped": 0,
                "unbootstrapped": 0,
                "reusable_candidate_count": sum(1 for record in records if bool(record.reusable)),
                "warm_worker_reuse_enabled": self._warm_worker_reuse_enabled,
                "same_chat_only": self._same_chat_only,
                "max_idle_workers": self._max_idle_workers,
                "max_total_workers": self._max_total_workers,
            }

    def owner_events(self, *, limit: int = 16) -> list[dict[str, Any]]:
        with self._lock:
            tail = self._owner_events[-max(1, int(limit or 1)) :]
            return [item.as_dict() for item in tail]

    def owner_state(self) -> dict[str, Any]:
        with self._lock:
            self._prune_reusable_candidates(self._monotonic_ms())
            records = [record.as_dict() for _session_id, record in sorted(self._owner_records.items())]
            recent_events = [item.as_dict() for item in self._owner_events[-16:]]
        return self._build_owner_state_payload(records=records, recent_events=recent_events)

    def select_reusable_candidate(self, session_id: str) -> dict[str, Any] | None:
        with self._lock:
            self._prune_reusable_candidates(self._monotonic_ms())
            record = self._owner_records.get(str(session_id or ""))
            if not isinstance(record, WarmSessionOwnerRecord):
                return None
            return self._build_reusable_candidate_payload(record)

    def note_worker_health(
        self,
        *,
        session_id: str,
        rss_kb: int | None = None,
        thread_count: int | None = None,
        health_status: str | None = None,
        health_reason: str | None = None,
    ) -> None:
        with self._lock:
            session_key = str(session_id or "")
            existing = self._owner_records.get(session_key)
            if not isinstance(existing, WarmSessionOwnerRecord):
                return
            sampled_at = self._monotonic_ms()
            self._update_owner_record(
                session_key,
                self._replace_record(
                    existing,
                    last_health_monotonic_ms=sampled_at,
                    last_known_rss_kb=self._normalize_optional_int(rss_kb),
                    last_known_thread_count=self._normalize_optional_int(thread_count),
                    health_status=self._normalize_optional_str(health_status),
                    health_reason=self._normalize_optional_str(health_reason),
                ),
            )
            self._record_owner_event_locked(
                event="worker_health_sampled",
                session_id=session_id,
                detail=self._build_worker_event_detail(
                    rss_kb=rss_kb,
                    thread_count=thread_count,
                    health_status=health_status,
                    health_reason=health_reason,
                ),
            )

    def note_worker_started(self, *, session_id: str, chat_id: int | None = None, job_id: int | None = None, owner_pid: int | None = None) -> None:
        with self._lock:
            started_ms = self._monotonic_ms()
            session_key = str(session_id or "")
            existing = self._owner_records.get(session_key)
            self._update_owner_record(
                session_key,
                self._build_started_record(
                    session_key=session_key,
                    chat_id=chat_id,
                    job_id=job_id,
                    owner_pid=owner_pid,
                    started_ms=started_ms,
                    existing=existing,
                ),
            )
            self._record_owner_event_locked(
                event="worker_started",
                session_id=session_id,
                detail=self._build_worker_event_detail(chat_id=chat_id, job_id=job_id, owner_pid=owner_pid),
            )

    def note_worker_finished(
        self,
        *,
        session_id: str,
        outcome: str,
        chat_id: int | None = None,
        job_id: int | None = None,
        owner_pid: int | None = None,
    ) -> None:
        with self._lock:
            finished_ms = self._monotonic_ms()
            session_key = str(session_id or "")
            existing = self._owner_records.get(session_key)
            started_ms = existing.last_started_monotonic_ms if isinstance(existing, WarmSessionOwnerRecord) else None
            normalized_outcome = str(outcome or "finished")
            self._update_owner_record(
                session_key,
                self._build_finished_record(
                    session_key=session_key,
                    existing=existing,
                    normalized_outcome=normalized_outcome,
                    chat_id=chat_id,
                    job_id=job_id,
                    owner_pid=owner_pid,
                    started_ms=started_ms,
                    finished_ms=finished_ms,
                ),
            )
            self._record_owner_event_locked(
                event="worker_finished",
                session_id=session_id,
                detail=self._build_worker_event_detail(
                    chat_id=chat_id,
                    job_id=job_id,
                    owner_pid=owner_pid,
                    outcome=outcome,
                ),
            )

    def note_worker_attach_ready(
        self,
        *,
        session_id: str,
        owner_pid: int | None = None,
        transport_kind: str | None = None,
        worker_endpoint: str | None = None,
        resume_token: str | None = None,
        resume_deadline_ms: int | None = None,
    ) -> None:
        with self._lock:
            session_key = str(session_id or "")
            existing = self._owner_records.get(session_key)
            self._update_owner_record(
                session_key,
                self._build_attach_ready_record(
                    session_key=session_key,
                    existing=existing,
                    owner_pid=owner_pid,
                    transport_kind=transport_kind,
                    worker_endpoint=worker_endpoint,
                    resume_token=resume_token,
                    resume_deadline_ms=resume_deadline_ms,
                ),
            )
            self._record_owner_event_locked(
                event="worker_attach_ready",
                session_id=session_id,
                detail=self._build_worker_event_detail(
                    owner_pid=owner_pid,
                    transport_kind=transport_kind,
                    worker_endpoint=worker_endpoint,
                    resume_deadline_ms=resume_deadline_ms,
                ),
            )

    def _prune_reusable_candidates(self, now_ms: int | None = None) -> None:
        with self._lock:
            cutoff_ms = int(now_ms if now_ms is not None else time.monotonic() * 1000)
            for session_id, record in list(self._owner_records.items()):
                if not isinstance(record, WarmSessionOwnerRecord):
                    continue
                expiration = classify_reusable_candidate_expiration(record, cutoff_ms=cutoff_ms)
                if not expiration:
                    continue
                self._owner_records[session_id] = self._replace_record(
                    record,
                    state="expired",
                    lifecycle_phase="expired_candidate",
                    reusable=False,
                    reusability_reason=str(expiration["reason"]),
                )
                self._record_owner_event(
                    event=str(expiration["event"]),
                    session_id=session_id,
                    detail=str(expiration["detail"]),
                )



class PersistentSessionManager:
    """Owns long-lived AIAgent runtimes keyed by miniapp session_id."""

    def __init__(self, *, max_sessions: int = 64, idle_ttl_seconds: int = 1800) -> None:
        self.max_sessions = max(1, int(max_sessions or 64))
        self.idle_ttl_seconds = max(60, int(idle_ttl_seconds or 1800))
        self._lock = threading.Lock()
        self._runtimes: dict[str, _PersistentRuntime] = {}
        self._owner_events: list[WarmSessionOwnerEvent] = []
        self._owner_events_limit = 128

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
                self._record_owner_event_locked(event="attach", session_id=session_id)
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
            self._record_owner_event_locked(event="created", session_id=session_id)

            if len(self._runtimes) > self.max_sessions:
                oldest_session_id = min(self._runtimes.items(), key=lambda item: item[1].last_used_at)[0]
                if oldest_session_id != session_id:
                    self._runtimes.pop(oldest_session_id, None)
                    self._record_owner_event_locked(event="evicted_capacity", session_id=oldest_session_id)
            return runtime

    def get_runtime(self, session_id: str) -> _PersistentRuntime | None:
        now = time.time()
        with self._lock:
            self._prune_locked(now)
            runtime = self._runtimes.get(session_id)
            if runtime:
                runtime.last_used_at = now
                self._record_owner_event_locked(event="attach", session_id=session_id)
            return runtime

    def evict(self, session_id: str, *, reason: str = "explicit_eviction") -> bool:
        with self._lock:
            removed = self._runtimes.pop(session_id, None) is not None
            if removed:
                self._record_owner_event_locked(event="evicted_explicit", session_id=session_id, detail=str(reason or "explicit_eviction"))
            return removed

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

    def owner_events(self, *, limit: int = 16) -> list[dict[str, Any]]:
        with self._lock:
            tail = self._owner_events[-max(1, int(limit or 1)) :]
            return [item.as_dict() for item in tail]

    def owner_state(self) -> dict[str, Any]:
        now = time.time()
        with self._lock:
            self._prune_locked(now)
            session_ids = sorted(self._runtimes.keys())
            return {
                "owner_class": type(self).__name__,
                "active_owner_count": len(session_ids),
                "active_session_ids": session_ids,
                "idle_ttl_seconds": int(self.idle_ttl_seconds),
                "recent_events": [item.as_dict() for item in self._owner_events[-16:]],
            }

    def select_reusable_candidate(self, session_id: str) -> dict[str, Any] | None:
        now = time.time()
        with self._lock:
            self._prune_locked(now)
            runtime = self._runtimes.get(str(session_id or ""))
            if runtime is None:
                return None
            return {
                "session_id": str(runtime.session_id or ""),
                "owner_class": type(self).__name__,
                "state": "running",
                "reusable": True,
                "reusability_reason": "shared_backend_runtime_available",
            }

    def _record_owner_event_locked(self, *, event: str, session_id: str, detail: str = "") -> None:
        self._owner_events.append(
            WarmSessionOwnerEvent(
                event=str(event or "unknown"),
                session_id=str(session_id or ""),
                owner_class=type(self).__name__,
                monotonic_ms=int(time.monotonic() * 1000),
                detail=str(detail or ""),
            )
        )
        if len(self._owner_events) > self._owner_events_limit:
            overflow = len(self._owner_events) - self._owner_events_limit
            if overflow > 0:
                del self._owner_events[:overflow]

    def _prune_locked(self, now: float) -> None:
        cutoff = now - self.idle_ttl_seconds
        stale = [session_id for session_id, runtime in self._runtimes.items() if runtime.last_used_at < cutoff]
        for session_id in stale:
            self._runtimes.pop(session_id, None)
            self._record_owner_event_locked(event="evicted_idle", session_id=session_id)
