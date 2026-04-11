from __future__ import annotations

import re
import time
from dataclasses import asdict
from typing import TYPE_CHECKING, Callable, Iterable

if TYPE_CHECKING:
    from job_runtime import JobRuntime


_TOOL_DEMO_REQUEST_RE = re.compile(r"\btool\b.*\b(demo|activity|call)\b|\b(demo|activity|call)\b.*\btool\b", re.IGNORECASE)
_TOOL_EXECUTION_CLAIM_RE = re.compile(
    r"\b(i|we)\s+(just\s+)?(ran|used|invoked|called|executed|checked)\b"
    r"|\blive\s+tool[ -]?call\s+demo\b"
    r"|\bterminal\s+tool\b"
    r"|\btool\s+activity\b",
    re.IGNORECASE,
)
_AMBIGUOUS_FOLLOWUP_RE = re.compile(
    r"^\s*(?:"
    r"do\s+it|continue|please\s+continue|go\s+ahead|proceed|keep\s+going|"
    r"do\s+that|do\s+this|fix\s+it|that|this|it|yes|yep|ok|okay"
    r")\s*[.!?]*\s*$",
    re.IGNORECASE,
)


def _is_tool_demo_request(message: str) -> bool:
    return bool(_TOOL_DEMO_REQUEST_RE.search(str(message or "")))


def _reply_claims_tool_execution(reply_text: str) -> bool:
    return bool(_TOOL_EXECUTION_CLAIM_RE.search(str(reply_text or "")))


def _build_chat_scoped_message(*, message: str, chat_title: str | None) -> str:
    cleaned = str(message or "").strip()
    title = str(chat_title or "").strip()
    if not cleaned or not title:
        return cleaned
    if not _AMBIGUOUS_FOLLOWUP_RE.match(cleaned):
        return cleaned
    return (
        f'Current thread title: "{title}". '
        "Interpret the operator's latest message only within this thread; do not switch to work from another chat.\n\n"
        f"Operator message: {cleaned}"
    )


def execute_chat_job(
    runtime: "JobRuntime",
    job: dict[str, object],
    *,
    retryable_error_cls: type[Exception],
    non_retryable_error_cls: type[Exception],
    client_error_cls: type[Exception],
    stream_events_fn: Callable[..., Iterable[dict[str, object]]] | None = None,
) -> None:
    job_id = int(job["id"])
    user_id = str(job["user_id"])
    chat_id = int(job["chat_id"])
    operator_message_id = int(job["operator_message_id"])

    # Avoid stale throttle state leaking across retries/tests for the same job id lifecycle.
    runtime._clear_touch_tracking(job_id)

    try:
        operator_turn = runtime.store.get_message(user_id=user_id, chat_id=chat_id, message_id=operator_message_id)
    except KeyError as exc:
        raise non_retryable_error_cls(f"Missing operator turn: {exc}") from exc

    message = operator_turn.body
    chat_title = None
    get_chat = getattr(runtime.store, "get_chat", None)
    if callable(get_chat):
        try:
            chat = get_chat(user_id, chat_id)
            chat_title = getattr(chat, "title", None)
        except Exception:  # noqa: BLE001 - best-effort thread guardrail only
            chat_title = None
    run_message = _build_chat_scoped_message(message=message, chat_title=chat_title)
    session_id = runtime.session_id_builder(user_id, chat_id)
    include_history = runtime.client.should_include_conversation_history(session_id=session_id)
    history: list[dict[str, object]] = []

    if include_history:
        checkpoint_history = runtime.store.get_runtime_checkpoint(session_id)
        if checkpoint_history:
            history = list(checkpoint_history)
        else:
            history = [
                asdict(turn)
                for turn in runtime.store.get_history_before(
                    user_id=user_id,
                    chat_id=chat_id,
                    before_message_id=operator_message_id,
                    limit=120,
                )
            ]

            context_brief = runtime._build_recent_context_brief(history)
            if context_brief:
                history.append(
                    {
                        "role": "system",
                        "body": (
                            "Recent thread context (most recent first-order turns). "
                            "Use this to resolve references like 'that', 'it', 'again', or 'last couple messages':\n"
                            f"{context_brief}"
                        ),
                    }
                )

    started = time.perf_counter()

    runtime_stats = runtime.client.persistent_stats()
    runtime.publish_job_event(
        job_id,
        "meta",
        {
            "skin": runtime.store.get_skin(user_id),
            "source": "stream",
            "chat_id": chat_id,
            "persistent_mode": "bootstrap" if include_history else "live",
            "persistent_enabled": bool(runtime_stats.get("enabled")),
            "persistent_runtime_total": int(runtime_stats.get("total", 0)),
        },
    )

    stream_events = stream_events_fn or runtime.client.stream_events

    def _consume_stream(run_message: str) -> tuple[bool, str, int, list[str], list[dict[str, str]], str]:
        reply_text = ""
        latency_ms = 0
        tool_trace_lines: list[str] = []
        runtime_checkpoint: list[dict[str, str]] = []
        last_event_source = ""
        saw_terminal_done = False
        event_iter = None

        def _persist_live_runtime_state() -> None:
            runtime.store.set_runtime_checkpoint(
                session_id=session_id,
                user_id=user_id,
                chat_id=chat_id,
                pending_tool_lines=tool_trace_lines,
                pending_assistant=reply_text,
            )
        set_spawn_trace_context = getattr(runtime.client, "set_spawn_trace_context", None)
        if callable(set_spawn_trace_context):
            set_spawn_trace_context(
                user_id=user_id,
                chat_id=chat_id,
                job_id=job_id,
                session_id=session_id,
            )
        try:
            event_iter = iter(
                stream_events(
                    user_id=user_id,
                    message=run_message,
                    conversation_history=history,
                    session_id=session_id,
                )
            )
            for event in event_iter:
                event_session_id = str(event.get("session_id") or "").strip()
                if event_session_id and event_session_id != session_id:
                    raise client_error_cls(
                        "Hermes stream session mismatch "
                        f"(expected {session_id}, got {event_session_id})."
                    )

                raw_event_chat_id = event.get("chat_id")
                if raw_event_chat_id not in (None, ""):
                    try:
                        event_chat_id = int(raw_event_chat_id)
                    except (TypeError, ValueError) as exc:
                        raise client_error_cls(f"Hermes stream emitted invalid chat_id={raw_event_chat_id!r}.") from exc
                    if event_chat_id != chat_id:
                        raise client_error_cls(
                            "Hermes stream chat mismatch "
                            f"(expected {chat_id}, got {event_chat_id})."
                        )

                event_type = str(event.get("type") or "")
                if event_type == "meta":
                    payload = {"chat_id": chat_id, **{k: v for k, v in event.items() if k != "type"}}
                    last_event_source = str(payload.get("source") or last_event_source).strip()
                    runtime.publish_job_event(job_id, "meta", payload)
                elif event_type == "tool":
                    payload = {"chat_id": chat_id, **{k: v for k, v in event.items() if k != "type"}}
                    display = str(payload.get("display") or payload.get("preview") or payload.get("tool_name") or "Tool running").strip()
                    if display:
                        tool_trace_lines.append(display)
                        _persist_live_runtime_state()
                    runtime.publish_job_event(job_id, "tool", payload)
                elif event_type == "chunk":
                    chunk = str(event.get("text") or "")
                    if chunk:
                        reply_text += chunk
                        _persist_live_runtime_state()
                        runtime.publish_job_event(job_id, "chunk", {"text": chunk, "chat_id": chat_id})
                elif event_type == "done":
                    saw_terminal_done = True
                    reply_text = str(event.get("reply") or reply_text).strip()
                    latency_ms = int(event.get("latency_ms") or 0)
                    checkpoint_payload = event.get("runtime_checkpoint")
                    if isinstance(checkpoint_payload, list):
                        runtime_checkpoint = [item for item in checkpoint_payload if isinstance(item, dict)]
                    _persist_live_runtime_state()
                    break
                elif event_type == "error":
                    raise client_error_cls(str(event.get("error") or "Hermes stream failed."))
        except client_error_cls as exc:
            raise retryable_error_cls(str(exc)) from exc
        finally:
            if event_iter is not None:
                close_iter = getattr(event_iter, "close", None)
                if callable(close_iter):
                    close_iter()
            clear_spawn_trace_context = getattr(runtime.client, "clear_spawn_trace_context", None)
            if callable(clear_spawn_trace_context):
                clear_spawn_trace_context()

        return saw_terminal_done, reply_text, latency_ms, tool_trace_lines, runtime_checkpoint, last_event_source

    saw_terminal_done, reply_text, latency_ms, tool_trace_lines, runtime_checkpoint, last_event_source = _consume_stream(run_message)

    state = runtime.store.get_job_state(job_id)
    if not state or state.get("status") != "running":
        return

    suspicious_missing_tool_demo = (
        _is_tool_demo_request(message)
        and not tool_trace_lines
        and _reply_claims_tool_execution(reply_text)
    )
    if suspicious_missing_tool_demo:
        runtime.publish_job_event(
            job_id,
            "meta",
            {
                "chat_id": chat_id,
                "source": "stream",
                "detail": "Re-running with explicit tool-use instruction because the first reply claimed tool usage without emitting tool activity.",
                "reason": "tool_demo_guard_retry",
            },
        )
        evict_session = getattr(runtime.client, "evict_session", None)
        if callable(evict_session):
            evict_session(session_id)
        forced_message = (
            f"{message.rstrip()}\n\n"
            "Important: the user is explicitly verifying visible tool activity in the mini app. "
            "You must actually call at least one tool before replying. "
            "Do not say you ran or checked anything unless a real tool call happened."
        )
        saw_terminal_done, reply_text, latency_ms, tool_trace_lines, runtime_checkpoint, last_event_source = _consume_stream(forced_message)

    if not saw_terminal_done:
        raise retryable_error_cls("Hermes stream ended without a terminal done event.")

    if not reply_text:
        source_hint = f" source={last_event_source}." if last_event_source else ""
        tool_hint = f" tools_seen={len(tool_trace_lines)}." if tool_trace_lines else ""
        raise retryable_error_cls(
            "Empty response from Hermes after terminal done event."
            f"{source_hint}{tool_hint}"
        )

    was_hard_truncated = False
    if len(reply_text) > runtime.assistant_hard_limit:
        trunc_notice = "\n\n[response truncated by miniapp hard limit]"
        keep = max(0, runtime.assistant_hard_limit - len(trunc_notice))
        reply_text = (reply_text[:keep]).rstrip() + trunc_notice
        was_hard_truncated = True

    reply_parts = runtime._chunk_assistant_reply(reply_text, runtime.assistant_chunk_len)
    if not reply_parts:
        raise retryable_error_cls("Hermes response could not be chunked.")

    if latency_ms <= 0:
        latency_ms = int((time.perf_counter() - started) * 1000)

    if tool_trace_lines:
        tool_trace_text = "\n".join(tool_trace_lines)
        max_tool_trace_len = 15000
        if len(tool_trace_text) > max_tool_trace_len:
            suffix = "\n… [tool trace truncated]"
            keep = max(0, max_tool_trace_len - len(suffix))
            tool_trace_text = tool_trace_text[:keep].rstrip() + suffix
        runtime.store.add_message(user_id=user_id, chat_id=chat_id, role="tool", body=tool_trace_text)

    if len(reply_parts) == 1:
        runtime.store.add_message(user_id=user_id, chat_id=chat_id, role="hermes", body=reply_parts[0])
    else:
        total = len(reply_parts)
        for index, part in enumerate(reply_parts, start=1):
            chunk_body = f"[part {index}/{total}]\n{part}"
            runtime.store.add_message(user_id=user_id, chat_id=chat_id, role="hermes", body=chunk_body)

    runtime.store.set_runtime_checkpoint(
        session_id=session_id,
        user_id=user_id,
        chat_id=chat_id,
        history=runtime_checkpoint if runtime_checkpoint else None,
        pending_tool_lines=[],
        pending_assistant="",
    )

    preserve_warm_owner = False
    warm_owner_state = getattr(runtime.client, "warm_session_owner_state", None)
    if callable(warm_owner_state):
        try:
            owner_state = warm_owner_state() or {}
        except Exception:
            owner_state = {}
        records = list((owner_state.get("owner_records") if isinstance(owner_state, dict) else None) or [])
        record = next((item for item in records if str((item or {}).get("session_id") or "") == str(session_id or "")), None)
        preserve_warm_owner = isinstance(record, dict) and str(record.get("state") or "") == "attachable_running"

    done_payload = {
        "reply": reply_text,
        "latency_ms": latency_ms,
        "turn_count": runtime.store.get_turn_count(user_id, chat_id=chat_id),
        "chat_id": chat_id,
        "hard_truncated": was_hard_truncated,
        "parts": len(reply_parts),
    }
    if preserve_warm_owner:
        done_payload["persistent_mode"] = "warm-detached"
        done_payload["warm_handoff"] = True
        done_payload["session_id"] = session_id
    runtime.publish_job_event(job_id, "done", done_payload)
    if not preserve_warm_owner:
        runtime.client.evict_session(session_id)
    runtime.store.complete_job(job_id)
