from __future__ import annotations

from typing import Any


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


def build_worker_event_detail(
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
    parts: list[str] = []
    if chat_id is not None:
        parts.append(f"chat_id={chat_id}")
    if job_id is not None:
        parts.append(f"job_id={job_id}")
    if owner_pid is not None:
        parts.append(f"owner_pid={owner_pid}")
    if outcome is not None:
        parts.append(f"outcome={outcome}")
    if transport_kind is not None:
        parts.append(f"transport_kind={transport_kind}")
    if worker_endpoint is not None:
        parts.append(f"worker_endpoint={worker_endpoint}")
    if resume_deadline_ms is not None:
        parts.append(f"resume_deadline_ms={resume_deadline_ms}")
    if rss_kb is not None:
        parts.append(f"rss_kb={rss_kb}")
    if thread_count is not None:
        parts.append(f"thread_count={thread_count}")
    if health_status is not None:
        parts.append(f"health_status={health_status}")
    if health_reason is not None:
        parts.append(f"health_reason={health_reason}")
    return " ".join(parts)


def _payload_from_record(record: Any) -> dict[str, Any]:
    if isinstance(record, dict):
        return dict(record)
    as_dict = getattr(record, "as_dict", None)
    if callable(as_dict):
        payload = as_dict()
        if isinstance(payload, dict):
            return dict(payload)
    return {}


def _payload_has_live_attach_ready(payload: dict[str, Any]) -> bool:
    return bool(
        str(payload.get("state") or "") == "attachable_running"
        and payload.get("attach_worker_endpoint")
        and payload.get("attach_resume_token")
    )


def build_owner_state_summary(records: list[dict[str, Any]]) -> dict[str, Any]:
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
        if _payload_has_live_attach_ready(record)
    ]
    idle_session_ids = [
        str(record["session_id"])
        for record in records
        if str(record.get("state") or "") in {"reusable_candidate", "attachable_running"}
        and bool(record.get("reusable"))
    ]
    state_counts: dict[str, int] = {}
    for record in records:
        state = str(record.get("state") or "unknown")
        state_counts[state] = int(state_counts.get(state, 0)) + 1
    return {
        "active_session_ids": active_session_ids,
        "attachable_session_ids": attachable_session_ids,
        "reusable_session_ids": reusable_session_ids,
        "live_attach_ready_session_ids": live_attach_ready_session_ids,
        "idle_session_ids": idle_session_ids,
        "state_counts": state_counts,
    }


def build_owner_state_payload(
    *,
    owner_class: str,
    records: list[dict[str, Any]],
    recent_events: list[dict[str, Any]],
    reusable_candidate_ttl_ms: int,
    warm_worker_reuse_enabled: bool,
    same_chat_only: bool,
    max_idle_workers: int,
    max_total_workers: int,
) -> dict[str, Any]:
    summary = build_owner_state_summary(records)
    return {
        "owner_class": str(owner_class or "unknown"),
        "active_owner_count": len(summary["active_session_ids"]),
        "active_session_ids": summary["active_session_ids"],
        "attachable_owner_count": len(summary["attachable_session_ids"]),
        "attachable_session_ids": summary["attachable_session_ids"],
        "live_attach_ready_count": len(summary["live_attach_ready_session_ids"]),
        "live_attach_ready_session_ids": summary["live_attach_ready_session_ids"],
        "reusable_candidate_count": len(summary["reusable_session_ids"]),
        "reusable_candidate_session_ids": summary["reusable_session_ids"],
        "idle_owner_count": len(summary["idle_session_ids"]),
        "idle_session_ids": summary["idle_session_ids"],
        "owner_state_counts": summary["state_counts"],
        "owner_records": records,
        "idle_ttl_seconds": None,
        "reusable_candidate_ttl_ms": int(reusable_candidate_ttl_ms),
        "warm_worker_reuse_enabled": bool(warm_worker_reuse_enabled),
        "same_chat_only": bool(same_chat_only),
        "max_idle_workers": int(max_idle_workers),
        "max_total_workers": int(max_total_workers),
        "recent_events": recent_events,
    }


def build_reusable_candidate_payload(record: Any) -> dict[str, Any] | None:
    payload = _payload_from_record(record)
    if not payload:
        return None
    contract = build_reuse_contract(payload) or {}
    attach_live_available = bool(
        contract.get("resume_supported")
        and contract.get("resume_capability") == "worker_attach"
        and contract.get("worker_endpoint")
        and contract.get("resume_token")
    )
    if not bool(payload.get("reusable")) and not attach_live_available:
        return None
    payload["reuse_contract"] = contract
    return payload


def classify_reusable_candidate_expiration(record: Any, *, cutoff_ms: int) -> dict[str, Any] | None:
    attach_deadline = getattr(record, "attach_resume_deadline_ms", None)
    if attach_deadline is not None and int(attach_deadline) <= int(cutoff_ms):
        return {
            "event": "attach_expired",
            "detail": f"expired_at={attach_deadline}",
            "reason": "attach_resume_deadline_expired",
        }
    if not bool(getattr(record, "reusable", False)):
        return None
    expiry = getattr(record, "reusable_until_monotonic_ms", None)
    if expiry is None or int(expiry) > int(cutoff_ms):
        return None
    return {
        "event": "candidate_expired",
        "detail": f"expired_at={expiry}",
        "reason": "candidate_ttl_expired",
    }
