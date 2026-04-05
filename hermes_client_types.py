from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Any, Protocol


def build_reuse_contract(record: dict[str, Any] | None) -> dict[str, Any] | None:
    if not isinstance(record, dict):
        return None
    required_now = [
        "contract_version",
        "session_id",
        "owner_class",
        "owner_pid",
        "lifecycle_phase",
        "reusability_reason",
    ]
    reserved_for_future = [
        "resume_token",
        "worker_endpoint",
        "transport_kind",
        "resume_deadline_ms",
    ]
    transport_kind = record.get("attach_transport_kind")
    worker_endpoint = record.get("attach_worker_endpoint")
    resume_token = record.get("attach_resume_token")
    resume_deadline_ms = record.get("attach_resume_deadline_ms")
    attach_available = bool(transport_kind and worker_endpoint and resume_token)
    return {
        "contract_version": "warm-reuse-v1",
        "session_id": str(record.get("session_id") or ""),
        "owner_class": str(record.get("owner_class") or "unknown"),
        "owner_pid": record.get("owner_pid"),
        "lifecycle_phase": str(record.get("lifecycle_phase") or "unknown"),
        "reusability_reason": str(record.get("reusability_reason") or "unknown"),
        "resume_supported": bool(attach_available),
        "resume_capability": "worker_attach" if attach_available else "none",
        "supported_resume_modes": ["worker_attach"] if attach_available else [],
        "required_transport": "subprocess",
        "attach_mechanism": "pid_only",
        "required_now": required_now,
        "reserved_for_future": reserved_for_future,
        "resume_token": resume_token,
        "worker_endpoint": worker_endpoint,
        "transport_kind": transport_kind,
        "resume_deadline_ms": resume_deadline_ms,
    }



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

    def __init__(self, *, reusable_candidate_ttl_ms: int = 120000) -> None:
        self._owner_events: list[WarmSessionOwnerEvent] = []
        self._owner_events_limit = 128
        self._owner_records: dict[str, WarmSessionOwnerRecord] = {}
        self._reusable_candidate_ttl_ms = max(1000, int(reusable_candidate_ttl_ms or 120000))
        self._record_owner_event(event="scaffold_initialized", session_id="", detail=f"reusable_candidate_ttl_ms={self._reusable_candidate_ttl_ms}")

    def get_or_create(
        self,
        *,
        session_id: str,
        model: str | None,
        max_iterations: int,
        create_agent: callable,
    ) -> _PersistentRuntime:
        self._record_owner_event(event="create_rejected", session_id=session_id, detail="isolated_worker_not_implemented")
        raise HermesClientError("Isolated worker warm sessions are not implemented yet.")

    def get_runtime(self, session_id: str) -> _PersistentRuntime | None:
        self._record_owner_event(event="lookup", session_id=session_id, detail="no_live_owner")
        return None

    def evict(self, session_id: str, *, reason: str = "explicit_eviction") -> bool:
        session_key = str(session_id or "")
        safe_reason = str(reason or "explicit_eviction")
        existing = self._owner_records.get(session_key)
        if isinstance(existing, WarmSessionOwnerRecord):
            self._owner_records[session_key] = WarmSessionOwnerRecord(
                session_id=existing.session_id,
                owner_class=existing.owner_class,
                state="evicted",
                lifecycle_phase="invalidated",
                reusable=False,
                reusability_reason=safe_reason,
                chat_id=existing.chat_id,
                job_id=existing.job_id,
                owner_pid=existing.owner_pid,
                last_outcome=existing.last_outcome,
                last_started_monotonic_ms=existing.last_started_monotonic_ms,
                last_finished_monotonic_ms=existing.last_finished_monotonic_ms,
                reusable_until_monotonic_ms=existing.reusable_until_monotonic_ms,
                attach_transport_kind=existing.attach_transport_kind,
                attach_worker_endpoint=existing.attach_worker_endpoint,
                attach_resume_token=existing.attach_resume_token,
                attach_resume_deadline_ms=existing.attach_resume_deadline_ms,
            )
            self._record_owner_event(event="evicted_explicit", session_id=session_id, detail=f"invalidated_by={safe_reason}")
            return True
        self._record_owner_event(event="evict_noop", session_id=session_id, detail=f"reason={safe_reason};no_live_owner")
        return False

    def stats(self) -> dict[str, int]:
        return {"total": 0, "bootstrapped": 0, "unbootstrapped": 0}

    def owner_events(self, *, limit: int = 16) -> list[dict[str, Any]]:
        tail = self._owner_events[-max(1, int(limit or 1)) :]
        return [item.as_dict() for item in tail]

    def owner_state(self) -> dict[str, Any]:
        now_ms = int(time.monotonic() * 1000)
        self._prune_reusable_candidates(now_ms)
        records = [record.as_dict() for _session_id, record in sorted(self._owner_records.items())]
        active_session_ids = [
            str(record["session_id"])
            for record in records
            if str(record.get("state") or "") in {"running", "attachable_running"}
        ]
        attachable_session_ids = [
            str(record["session_id"])
            for record in records
            if str(record.get("state") or "") == "attachable_running"
        ]
        reusable_session_ids = [str(record["session_id"]) for record in records if bool(record.get("reusable"))]
        live_attach_ready_session_ids = [
            str(record["session_id"])
            for record in records
            if str(record.get("state") or "") == "attachable_running"
            and bool(record.get("attach_worker_endpoint"))
            and bool(record.get("attach_resume_token"))
        ]
        state_counts: dict[str, int] = {}
        for record in records:
            state = str(record.get("state") or "unknown")
            state_counts[state] = int(state_counts.get(state, 0)) + 1
        return {
            "owner_class": type(self).__name__,
            "active_owner_count": len(active_session_ids),
            "active_session_ids": active_session_ids,
            "attachable_owner_count": len(attachable_session_ids),
            "attachable_session_ids": attachable_session_ids,
            "live_attach_ready_count": len(live_attach_ready_session_ids),
            "live_attach_ready_session_ids": live_attach_ready_session_ids,
            "reusable_candidate_count": len(reusable_session_ids),
            "reusable_candidate_session_ids": reusable_session_ids,
            "owner_state_counts": state_counts,
            "owner_records": records,
            "idle_ttl_seconds": None,
            "reusable_candidate_ttl_ms": int(self._reusable_candidate_ttl_ms),
            "recent_events": [item.as_dict() for item in self._owner_events[-16:]],
        }

    def select_reusable_candidate(self, session_id: str) -> dict[str, Any] | None:
        now_ms = int(time.monotonic() * 1000)
        self._prune_reusable_candidates(now_ms)
        record = self._owner_records.get(str(session_id or ""))
        if not isinstance(record, WarmSessionOwnerRecord):
            return None
        contract = build_reuse_contract(record.as_dict()) or {}
        attach_live_available = bool(
            contract.get("resume_supported")
            and contract.get("resume_capability") == "worker_attach"
            and contract.get("worker_endpoint")
            and contract.get("resume_token")
        )
        if not bool(record.reusable) and not attach_live_available:
            return None
        payload = record.as_dict()
        payload["reuse_contract"] = contract
        return payload

    def note_worker_started(self, *, session_id: str, chat_id: int | None = None, job_id: int | None = None, owner_pid: int | None = None) -> None:
        detail = f"chat_id={chat_id} job_id={job_id} owner_pid={owner_pid}"
        started_ms = int(time.monotonic() * 1000)
        self._owner_records[str(session_id or "")] = WarmSessionOwnerRecord(
            session_id=str(session_id or ""),
            owner_class=type(self).__name__,
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
        )
        self._record_owner_event(event="worker_started", session_id=session_id, detail=detail)

    def note_worker_finished(
        self,
        *,
        session_id: str,
        outcome: str,
        chat_id: int | None = None,
        job_id: int | None = None,
        owner_pid: int | None = None,
    ) -> None:
        detail = f"chat_id={chat_id} job_id={job_id} owner_pid={owner_pid} outcome={outcome}"
        finished_ms = int(time.monotonic() * 1000)
        session_key = str(session_id or "")
        existing = self._owner_records.get(session_key)
        started_ms = existing.last_started_monotonic_ms if isinstance(existing, WarmSessionOwnerRecord) else None
        normalized_outcome = str(outcome or "finished")
        if isinstance(existing, WarmSessionOwnerRecord) and str(existing.state or "") == "evicted":
            self._owner_records[session_key] = WarmSessionOwnerRecord(
                session_id=existing.session_id,
                owner_class=existing.owner_class,
                state="evicted",
                lifecycle_phase="invalidated",
                reusable=False,
                reusability_reason=existing.reusability_reason,
                chat_id=existing.chat_id if existing.chat_id is not None else chat_id,
                job_id=existing.job_id if existing.job_id is not None else job_id,
                owner_pid=existing.owner_pid if existing.owner_pid is not None else owner_pid,
                last_outcome=normalized_outcome,
                last_started_monotonic_ms=started_ms,
                last_finished_monotonic_ms=finished_ms,
                reusable_until_monotonic_ms=existing.reusable_until_monotonic_ms,
                attach_transport_kind=existing.attach_transport_kind,
                attach_worker_endpoint=existing.attach_worker_endpoint,
                attach_resume_token=existing.attach_resume_token,
                attach_resume_deadline_ms=existing.attach_resume_deadline_ms,
            )
            self._record_owner_event(event="worker_finished", session_id=session_id, detail=detail)
            return
        if (
            isinstance(existing, WarmSessionOwnerRecord)
            and str(existing.state or "") == "attachable_running"
            and bool(existing.attach_worker_endpoint)
            and bool(existing.attach_resume_token)
        ):
            self._owner_records[session_key] = WarmSessionOwnerRecord(
                session_id=existing.session_id,
                owner_class=existing.owner_class,
                state="attachable_running",
                lifecycle_phase=existing.lifecycle_phase,
                reusable=True,
                reusability_reason=existing.reusability_reason or "worker_attach_live_available",
                chat_id=existing.chat_id if existing.chat_id is not None else chat_id,
                job_id=existing.job_id if existing.job_id is not None else job_id,
                owner_pid=existing.owner_pid if existing.owner_pid is not None else owner_pid,
                last_outcome=normalized_outcome,
                last_started_monotonic_ms=started_ms,
                last_finished_monotonic_ms=finished_ms,
                reusable_until_monotonic_ms=existing.reusable_until_monotonic_ms,
                attach_transport_kind=existing.attach_transport_kind,
                attach_worker_endpoint=existing.attach_worker_endpoint,
                attach_resume_token=existing.attach_resume_token,
                attach_resume_deadline_ms=existing.attach_resume_deadline_ms,
            )
            self._record_owner_event(event="worker_finished", session_id=session_id, detail=detail)
            return
        reusable = normalized_outcome in {"completed", "success", "warm_reusable_candidate"}
        reusable_until = finished_ms + self._reusable_candidate_ttl_ms if reusable else None
        reusability_reason = "isolated_worker_warm_reuse_not_implemented" if reusable else f"non_reusable_outcome:{normalized_outcome}"
        self._owner_records[session_key] = WarmSessionOwnerRecord(
            session_id=session_key,
            owner_class=type(self).__name__,
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
        )
        self._record_owner_event(event="worker_finished", session_id=session_id, detail=detail)

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
        session_key = str(session_id or "")
        existing = self._owner_records.get(session_key)
        if not isinstance(existing, WarmSessionOwnerRecord):
            existing = WarmSessionOwnerRecord(
                session_id=session_key,
                owner_class=type(self).__name__,
                state="running",
                lifecycle_phase="active_attempt",
                reusable=False,
                reusability_reason="worker_attempt_in_progress",
            )
        self._owner_records[session_key] = WarmSessionOwnerRecord(
            session_id=existing.session_id,
            owner_class=existing.owner_class,
            state="attachable_running",
            lifecycle_phase=existing.lifecycle_phase,
            reusable=True,
            reusability_reason="worker_attach_live_available",
            chat_id=existing.chat_id,
            job_id=existing.job_id,
            owner_pid=owner_pid if owner_pid is not None else existing.owner_pid,
            last_outcome=existing.last_outcome,
            last_started_monotonic_ms=existing.last_started_monotonic_ms,
            last_finished_monotonic_ms=existing.last_finished_monotonic_ms,
            reusable_until_monotonic_ms=existing.reusable_until_monotonic_ms,
            attach_transport_kind=str(transport_kind or "") or None,
            attach_worker_endpoint=str(worker_endpoint or "") or None,
            attach_resume_token=str(resume_token or "") or None,
            attach_resume_deadline_ms=int(resume_deadline_ms) if resume_deadline_ms not in {None, ""} else None,
        )
        self._record_owner_event(
            event="worker_attach_ready",
            session_id=session_id,
            detail=(
                f"owner_pid={owner_pid} transport_kind={transport_kind} "
                f"worker_endpoint={worker_endpoint} resume_deadline_ms={resume_deadline_ms}"
            ),
        )

    def _prune_reusable_candidates(self, now_ms: int | None = None) -> None:
        cutoff_ms = int(now_ms if now_ms is not None else time.monotonic() * 1000)
        for session_id, record in list(self._owner_records.items()):
            if not isinstance(record, WarmSessionOwnerRecord):
                continue
            attach_deadline = record.attach_resume_deadline_ms
            if attach_deadline is not None and int(attach_deadline) <= cutoff_ms:
                self._owner_records[session_id] = WarmSessionOwnerRecord(
                    session_id=record.session_id,
                    owner_class=record.owner_class,
                    state="expired",
                    lifecycle_phase="expired_candidate",
                    reusable=False,
                    reusability_reason="attach_resume_deadline_expired",
                    chat_id=record.chat_id,
                    job_id=record.job_id,
                    owner_pid=record.owner_pid,
                    last_outcome=record.last_outcome,
                    last_started_monotonic_ms=record.last_started_monotonic_ms,
                    last_finished_monotonic_ms=record.last_finished_monotonic_ms,
                    reusable_until_monotonic_ms=record.reusable_until_monotonic_ms,
                    attach_transport_kind=record.attach_transport_kind,
                    attach_worker_endpoint=record.attach_worker_endpoint,
                    attach_resume_token=record.attach_resume_token,
                    attach_resume_deadline_ms=record.attach_resume_deadline_ms,
                )
                self._record_owner_event(event="attach_expired", session_id=session_id, detail=f"expired_at={attach_deadline}")
                continue
            if not bool(record.reusable):
                continue
            expiry = record.reusable_until_monotonic_ms
            if expiry is None or int(expiry) > cutoff_ms:
                continue
            self._owner_records[session_id] = WarmSessionOwnerRecord(
                session_id=record.session_id,
                owner_class=record.owner_class,
                state="expired",
                lifecycle_phase="expired_candidate",
                reusable=False,
                reusability_reason="candidate_ttl_expired",
                chat_id=record.chat_id,
                job_id=record.job_id,
                owner_pid=record.owner_pid,
                last_outcome=record.last_outcome,
                last_started_monotonic_ms=record.last_started_monotonic_ms,
                last_finished_monotonic_ms=record.last_finished_monotonic_ms,
                reusable_until_monotonic_ms=record.reusable_until_monotonic_ms,
                attach_transport_kind=record.attach_transport_kind,
                attach_worker_endpoint=record.attach_worker_endpoint,
                attach_resume_token=record.attach_resume_token,
                attach_resume_deadline_ms=record.attach_resume_deadline_ms,
            )
            self._record_owner_event(event="candidate_expired", session_id=session_id, detail=f"expired_at={expiry}")

    def _record_owner_event(self, *, event: str, session_id: str, detail: str = "") -> None:
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
