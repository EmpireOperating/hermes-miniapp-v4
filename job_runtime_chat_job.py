from __future__ import annotations

import time
from dataclasses import asdict
from typing import TYPE_CHECKING, Callable, Iterable

if TYPE_CHECKING:
    from job_runtime import JobRuntime


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
    reply_text = ""
    latency_ms = 0
    tool_trace_lines: list[str] = []
    runtime_checkpoint: list[dict[str, str]] = []

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

    set_spawn_trace_context = getattr(runtime.client, "set_spawn_trace_context", None)
    if callable(set_spawn_trace_context):
        set_spawn_trace_context(
            user_id=user_id,
            chat_id=chat_id,
            job_id=job_id,
            session_id=session_id,
        )
    try:
        for event in stream_events(
            user_id=user_id,
            message=message,
            conversation_history=history,
            session_id=session_id,
        ):
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
                runtime.publish_job_event(job_id, "meta", payload)
            elif event_type == "tool":
                payload = {"chat_id": chat_id, **{k: v for k, v in event.items() if k != "type"}}
                display = str(payload.get("display") or payload.get("preview") or payload.get("tool_name") or "Tool running").strip()
                if display:
                    tool_trace_lines.append(display)
                runtime.publish_job_event(job_id, "tool", payload)
            elif event_type == "chunk":
                chunk = str(event.get("text") or "")
                if chunk:
                    reply_text += chunk
                    runtime.publish_job_event(job_id, "chunk", {"text": chunk, "chat_id": chat_id})
            elif event_type == "done":
                reply_text = str(event.get("reply") or reply_text).strip()
                latency_ms = int(event.get("latency_ms") or 0)
                checkpoint_payload = event.get("runtime_checkpoint")
                if isinstance(checkpoint_payload, list):
                    runtime_checkpoint = [item for item in checkpoint_payload if isinstance(item, dict)]
            elif event_type == "error":
                raise client_error_cls(str(event.get("error") or "Hermes stream failed."))
    except client_error_cls as exc:
        raise retryable_error_cls(str(exc)) from exc
    finally:
        clear_spawn_trace_context = getattr(runtime.client, "clear_spawn_trace_context", None)
        if callable(clear_spawn_trace_context):
            clear_spawn_trace_context()

    state = runtime.store.get_job_state(job_id)
    if not state or state.get("status") != "running":
        return

    if not reply_text:
        raise retryable_error_cls("Empty response from Hermes.")

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

    if runtime_checkpoint:
        runtime.store.set_runtime_checkpoint(
            session_id=session_id,
            user_id=user_id,
            chat_id=chat_id,
            history=runtime_checkpoint,
        )

    runtime.client.evict_session(session_id)
    runtime.store.complete_job(job_id)
    runtime.publish_job_event(
        job_id,
        "done",
        {
            "reply": reply_text,
            "latency_ms": latency_ms,
            "turn_count": runtime.store.get_turn_count(user_id, chat_id=chat_id),
            "chat_id": chat_id,
            "hard_truncated": was_hard_truncated,
            "parts": len(reply_parts),
        },
    )
