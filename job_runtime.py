from __future__ import annotations

import logging
import queue
import threading
import time
from dataclasses import asdict
from typing import Callable

from hermes_client import HermesClient, HermesClientError
from store import SessionStore


LOGGER = logging.getLogger(__name__)


class JobRetryableError(Exception):
    pass


class JobNonRetryableError(Exception):
    pass


class JobRuntime:
    def __init__(
        self,
        *,
        store: SessionStore,
        client: HermesClient,
        job_max_attempts: int,
        job_retry_base_seconds: int,
        job_worker_concurrency: int,
        job_stall_timeout_seconds: int,
        assistant_chunk_len: int,
        assistant_hard_limit: int,
        job_event_history_max_jobs: int,
        job_event_history_ttl_seconds: int,
        session_id_builder: Callable[[str, int], str],
    ) -> None:
        self.store = store
        self.client = client
        self.job_max_attempts = int(job_max_attempts)
        self.job_retry_base_seconds = int(job_retry_base_seconds)
        self.job_worker_concurrency = max(1, int(job_worker_concurrency))
        self.job_stall_timeout_seconds = max(60, int(job_stall_timeout_seconds))
        # Keep running jobs alive even when upstream model providers are silent for long stretches.
        self.job_keepalive_interval_seconds = max(5.0, min(30.0, self.job_stall_timeout_seconds / 6.0))
        self.assistant_chunk_len = int(assistant_chunk_len)
        self.assistant_hard_limit = int(assistant_hard_limit)
        self.job_event_history_max_jobs = max(32, int(job_event_history_max_jobs))
        self.job_event_history_ttl_seconds = max(60, int(job_event_history_ttl_seconds))
        self.session_id_builder = session_id_builder

        self._event_lock = threading.Lock()
        self._event_queues: dict[int, list[queue.Queue[dict[str, object]]]] = {}
        self._event_history: dict[int, list[dict[str, object]]] = {}
        self._event_timestamps: dict[int, float] = {}

        self.wake_event = threading.Event()
        self._worker_threads: list[threading.Thread] = []
        self._worker_start_lock = threading.Lock()
        self._watchdog_started = False
        self._watchdog_lock = threading.Lock()

        self.job_touch_min_interval_seconds = 1.5
        self._touch_lock = threading.Lock()
        self._last_touch_by_job: dict[int, float] = {}

        self._best_effort_failure_lock = threading.Lock()
        self._best_effort_failure_counts: dict[str, int] = {
            "touch_job_write": 0,
            "system_message_write": 0,
        }

    def publish_job_event(self, job_id: int, event_name: str, payload: dict[str, object]) -> None:
        event = {"event": event_name, "payload": payload}
        terminal_events = {"done", "error"}
        if event_name not in terminal_events:
            self._touch_job_best_effort(job_id)
        else:
            self._clear_touch_tracking(job_id)

        with self._event_lock:
            history = self._event_history.setdefault(job_id, [])
            history.append(event)
            if len(history) > 512:
                del history[: len(history) - 512]
            self._event_timestamps[job_id] = time.monotonic()
            subscribers = list(self._event_queues.get(job_id, []))

        self._prune_event_history()

        for subscriber in subscribers:
            try:
                subscriber.put_nowait(event)
                continue
            except queue.Full:
                pass

            if event_name not in terminal_events:
                # Non-terminal events can be dropped under backpressure.
                continue

            # Terminal events must be delivered so stream consumers can close.
            delivered = False
            for _ in range(4):
                try:
                    subscriber.get_nowait()
                except queue.Empty:
                    break
                try:
                    subscriber.put_nowait(event)
                    delivered = True
                    break
                except queue.Full:
                    continue

            if not delivered:
                LOGGER.warning("job_event_terminal_drop job_id=%s event=%s", job_id, event_name)

    def subscribe_job_events(self, job_id: int) -> queue.Queue[dict[str, object]]:
        subscriber: queue.Queue[dict[str, object]] = queue.Queue(maxsize=512)
        with self._event_lock:
            history = list(self._event_history.get(job_id, []))
            self._event_queues.setdefault(job_id, []).append(subscriber)

        for event in history:
            try:
                subscriber.put_nowait(event)
            except queue.Full:
                break
        return subscriber

    def unsubscribe_job_events(self, job_id: int, subscriber: queue.Queue[dict[str, object]]) -> None:
        with self._event_lock:
            listeners = self._event_queues.get(job_id, [])
            if subscriber in listeners:
                listeners.remove(subscriber)
            if not listeners:
                self._event_queues.pop(job_id, None)
                terminal_events = {"done", "error"}
                history = self._event_history.get(job_id, [])
                if history and str(history[-1].get("event") or "") in terminal_events:
                    self._event_history.pop(job_id, None)
                    self._event_timestamps.pop(job_id, None)

    def _clear_touch_tracking(self, job_id: int) -> None:
        with self._touch_lock:
            self._last_touch_by_job.pop(int(job_id), None)

    def _record_best_effort_failure(self, kind: str, **context: object) -> int:
        with self._best_effort_failure_lock:
            next_count = int(self._best_effort_failure_counts.get(kind, 0)) + 1
            self._best_effort_failure_counts[kind] = next_count

        details = " ".join(f"{key}={value}" for key, value in sorted(context.items()))
        if details:
            LOGGER.warning("best_effort_write_failure kind=%s count=%s %s", kind, next_count, details)
        else:
            LOGGER.warning("best_effort_write_failure kind=%s count=%s", kind, next_count)
        return next_count

    def best_effort_failure_counts(self) -> dict[str, int]:
        with self._best_effort_failure_lock:
            return dict(self._best_effort_failure_counts)

    def _touch_job_best_effort(self, job_id: int, *, force: bool = False) -> None:
        job_id = int(job_id)
        now = time.monotonic()
        if not force:
            with self._touch_lock:
                last = self._last_touch_by_job.get(job_id, 0.0)
                if now - last < self.job_touch_min_interval_seconds:
                    return
                self._last_touch_by_job[job_id] = now
        else:
            with self._touch_lock:
                self._last_touch_by_job[job_id] = now

        try:
            self.store.touch_job(job_id)
        except Exception as exc:  # noqa: BLE001
            self._record_best_effort_failure("touch_job_write", job_id=job_id, force=bool(force), error=type(exc).__name__)
            LOGGER.debug("touch_job_best_effort_exception job_id=%s", job_id, exc_info=exc)

    def is_stale_chat_job_error(self, exc: Exception) -> bool:
        if not isinstance(exc, KeyError):
            return False
        text = str(exc)
        return "Chat" in text and "not found" in text

    def start_once(self) -> None:
        with self._watchdog_lock:
            if not self._watchdog_started:
                watchdog = threading.Thread(target=self._watchdog_loop, name="miniapp-job-watchdog", daemon=True)
                watchdog.start()
                self._watchdog_started = True

        with self._worker_start_lock:
            alive_workers = [worker for worker in self._worker_threads if worker.is_alive()]
            self._worker_threads[:] = alive_workers

            missing = max(0, self.job_worker_concurrency - len(alive_workers))
            if missing <= 0:
                return

            for _ in range(missing):
                worker_index = len(self._worker_threads) + 1
                worker = threading.Thread(target=self._worker_loop, name=f"miniapp-job-worker-{worker_index}", daemon=True)
                worker.start()
                self._worker_threads.append(worker)

            self.wake_event.set()

    def ensure_pending_jobs(self, user_id: str) -> None:
        for chat_id, operator_message_id in self.store.list_recoverable_pending_turns(user_id):
            job_id = self.store.enqueue_chat_job(
                user_id=user_id,
                chat_id=chat_id,
                operator_message_id=operator_message_id,
                max_attempts=self.job_max_attempts,
            )
            self.publish_job_event(job_id, "meta", {"chat_id": chat_id, "source": "recovered"})
            self.wake_event.set()

    def run_chat_job(self, job: dict[str, object]) -> None:
        job_id = int(job["id"])
        user_id = str(job["user_id"])
        chat_id = int(job["chat_id"])
        operator_message_id = int(job["operator_message_id"])

        # Avoid stale throttle state leaking across retries/tests for the same job id lifecycle.
        self._clear_touch_tracking(job_id)

        try:
            operator_turn = self.store.get_message(user_id=user_id, chat_id=chat_id, message_id=operator_message_id)
        except KeyError as exc:
            raise JobNonRetryableError(f"Missing operator turn: {exc}") from exc

        message = operator_turn.body
        session_id = self.session_id_builder(user_id, chat_id)
        include_history = self.client.should_include_conversation_history(session_id=session_id)
        history: list[dict[str, object]] = []

        if include_history:
            checkpoint_history = self.store.get_runtime_checkpoint(session_id)
            if checkpoint_history:
                history = list(checkpoint_history)
            else:
                history = [
                    asdict(turn)
                    for turn in self.store.get_history_before(
                        user_id=user_id,
                        chat_id=chat_id,
                        before_message_id=operator_message_id,
                        limit=120,
                    )
                ]

                context_brief = self._build_recent_context_brief(history)
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

        runtime_stats = self.client.persistent_stats()
        self.publish_job_event(
            job_id,
            "meta",
            {
                "skin": self.store.get_skin(user_id),
                "source": "stream",
                "chat_id": chat_id,
                "persistent_mode": "bootstrap" if include_history else "live",
                "persistent_enabled": bool(runtime_stats.get("enabled")),
                "persistent_runtime_total": int(runtime_stats.get("total", 0)),
            },
        )

        keepalive_stop = threading.Event()

        def _keepalive_loop() -> None:
            interval = max(0.5, float(self.job_keepalive_interval_seconds))
            while not keepalive_stop.wait(interval):
                # Keepalive should not be suppressed by event throttle state.
                self._touch_job_best_effort(job_id, force=True)

        keepalive_thread = threading.Thread(
            target=_keepalive_loop,
            name=f"miniapp-job-keepalive-{job_id}",
            daemon=True,
        )
        keepalive_thread.start()

        try:
            for event in self.client.stream_events(
                user_id=user_id,
                message=message,
                conversation_history=history,
                session_id=session_id,
            ):
                event_type = str(event.get("type") or "")
                if event_type == "meta":
                    payload = {"chat_id": chat_id, **{k: v for k, v in event.items() if k != "type"}}
                    self.publish_job_event(job_id, "meta", payload)
                elif event_type == "tool":
                    payload = {"chat_id": chat_id, **{k: v for k, v in event.items() if k != "type"}}
                    display = str(payload.get("display") or payload.get("preview") or payload.get("tool_name") or "Tool running").strip()
                    if display:
                        tool_trace_lines.append(display)
                    self.publish_job_event(job_id, "tool", payload)
                elif event_type == "chunk":
                    chunk = str(event.get("text") or "")
                    if chunk:
                        reply_text += chunk
                        self.publish_job_event(job_id, "chunk", {"text": chunk, "chat_id": chat_id})
                elif event_type == "done":
                    reply_text = str(event.get("reply") or reply_text).strip()
                    latency_ms = int(event.get("latency_ms") or 0)
                    checkpoint_payload = event.get("runtime_checkpoint")
                    if isinstance(checkpoint_payload, list):
                        runtime_checkpoint = [item for item in checkpoint_payload if isinstance(item, dict)]
                elif event_type == "error":
                    raise HermesClientError(str(event.get("error") or "Hermes stream failed."))
        except HermesClientError as exc:
            raise JobRetryableError(str(exc)) from exc
        finally:
            keepalive_stop.set()

        state = self.store.get_job_state(job_id)
        if not state or state.get("status") != "running":
            return

        if not reply_text:
            raise JobRetryableError("Empty response from Hermes.")

        was_hard_truncated = False
        if len(reply_text) > self.assistant_hard_limit:
            trunc_notice = "\n\n[response truncated by miniapp hard limit]"
            keep = max(0, self.assistant_hard_limit - len(trunc_notice))
            reply_text = (reply_text[:keep]).rstrip() + trunc_notice
            was_hard_truncated = True

        reply_parts = self._chunk_assistant_reply(reply_text, self.assistant_chunk_len)
        if not reply_parts:
            raise JobRetryableError("Hermes response could not be chunked.")

        if latency_ms <= 0:
            latency_ms = int((time.perf_counter() - started) * 1000)

        if tool_trace_lines:
            tool_trace_text = "\n".join(tool_trace_lines)
            max_tool_trace_len = 15000
            if len(tool_trace_text) > max_tool_trace_len:
                suffix = "\n… [tool trace truncated]"
                keep = max(0, max_tool_trace_len - len(suffix))
                tool_trace_text = tool_trace_text[:keep].rstrip() + suffix
            self.store.add_message(user_id=user_id, chat_id=chat_id, role="tool", body=tool_trace_text)

        if len(reply_parts) == 1:
            self.store.add_message(user_id=user_id, chat_id=chat_id, role="hermes", body=reply_parts[0])
        else:
            total = len(reply_parts)
            for index, part in enumerate(reply_parts, start=1):
                chunk_body = f"[part {index}/{total}]\n{part}"
                self.store.add_message(user_id=user_id, chat_id=chat_id, role="hermes", body=chunk_body)

        if runtime_checkpoint:
            self.store.set_runtime_checkpoint(
                session_id=session_id,
                user_id=user_id,
                chat_id=chat_id,
                history=runtime_checkpoint,
            )

        self.store.complete_job(job_id)
        self.publish_job_event(
            job_id,
            "done",
            {
                "reply": reply_text,
                "latency_ms": latency_ms,
                "turn_count": self.store.get_turn_count(user_id, chat_id=chat_id),
                "chat_id": chat_id,
                "hard_truncated": was_hard_truncated,
                "parts": len(reply_parts),
            },
        )

    def _safe_add_system_message(self, user_id: str, chat_id: int, text: str) -> None:
        try:
            self.store.add_message(user_id=user_id, chat_id=chat_id, role="system", body=text)
        except Exception as exc:  # noqa: BLE001
            self._record_best_effort_failure(
                "system_message_write",
                user_id=user_id,
                chat_id=int(chat_id),
                text_len=len(text),
                error=type(exc).__name__,
            )
            LOGGER.debug(
                "safe_add_system_message_exception user_id=%s chat_id=%s",
                user_id,
                chat_id,
                exc_info=exc,
            )
            return

    def _sweep_stale_running_jobs(self) -> None:
        stale_jobs = self.store.dead_letter_stale_running_jobs(
            timeout_seconds=self.job_stall_timeout_seconds,
            error=f"Job timed out after {self.job_stall_timeout_seconds}s without progress",
        )
        for stale in stale_jobs:
            stale_job_id = int(stale.get("id") or 0)
            stale_chat_id = int(stale.get("chat_id") or 0)
            stale_user_id = str(stale.get("user_id") or "")
            if stale_job_id:
                self.publish_job_event(
                    stale_job_id,
                    "error",
                    {
                        "chat_id": stale_chat_id,
                        "error": f"Job timed out after {self.job_stall_timeout_seconds}s without progress",
                        "retrying": False,
                    },
                )
            if stale_user_id and stale_chat_id:
                self._safe_add_system_message(
                    user_id=stale_user_id,
                    chat_id=stale_chat_id,
                    text=f"Hermes timed out after {self.job_stall_timeout_seconds}s with no progress. Please retry.",
                )

    def _watchdog_loop(self) -> None:
        while True:
            time.sleep(5)
            self._sweep_stale_running_jobs()

    def _worker_loop(self) -> None:
        while True:
            self.wake_event.wait(timeout=0.6)
            self.wake_event.clear()

            self._sweep_stale_running_jobs()

            while True:
                job = self.store.claim_next_job()
                if not job:
                    break

                job_id = int(job["id"])
                user_id = str(job["user_id"])
                chat_id = int(job["chat_id"])
                attempts = int(job.get("attempts") or 0)
                max_attempts = int(job.get("max_attempts") or 1)

                try:
                    self.run_chat_job(job)
                except JobNonRetryableError as exc:
                    error_text = str(exc)
                    self.store.retry_or_dead_letter_job(job_id, error_text, retry_base_seconds=0)
                    self._clear_touch_tracking(job_id)
                    LOGGER.error(
                        "job_non_retryable job_id=%s user_id=%s chat_id=%s attempts=%s max_attempts=%s error=%s",
                        job_id,
                        user_id,
                        chat_id,
                        attempts,
                        max_attempts,
                        error_text,
                    )
                    self._safe_add_system_message(user_id=user_id, chat_id=chat_id, text=f"Hermes failed permanently: {error_text}")
                    self.publish_job_event(job_id, "error", {"error": error_text, "chat_id": chat_id, "retrying": False})
                except JobRetryableError as exc:
                    error_text = str(exc)
                    retrying = self.store.retry_or_dead_letter_job(job_id, error_text, retry_base_seconds=self.job_retry_base_seconds)
                    if retrying:
                        LOGGER.warning(
                            "job_retry_scheduled job_id=%s user_id=%s chat_id=%s attempts=%s max_attempts=%s error=%s",
                            job_id,
                            user_id,
                            chat_id,
                            attempts,
                            max_attempts,
                            error_text,
                        )
                        self.publish_job_event(
                            job_id,
                            "meta",
                            {
                                "chat_id": chat_id,
                                "source": "retry",
                                "attempt": attempts,
                                "max_attempts": max_attempts,
                                "detail": f"retrying after error: {error_text}",
                            },
                        )
                        self.wake_event.set()
                    else:
                        self._clear_touch_tracking(job_id)
                        LOGGER.error(
                            "job_retry_exhausted job_id=%s user_id=%s chat_id=%s attempts=%s max_attempts=%s error=%s",
                            job_id,
                            user_id,
                            chat_id,
                            attempts,
                            max_attempts,
                            error_text,
                        )
                        self._safe_add_system_message(user_id=user_id, chat_id=chat_id, text=f"Hermes failed after {attempts} attempts: {error_text}")
                        self.publish_job_event(job_id, "error", {"error": error_text, "chat_id": chat_id, "retrying": False})
                except Exception as exc:  # noqa: BLE001
                    if self.is_stale_chat_job_error(exc):
                        error_text = f"Stale chat job dropped: {exc}"
                        self.store.retry_or_dead_letter_job(job_id, error_text, retry_base_seconds=0)
                        self._clear_touch_tracking(job_id)
                        LOGGER.info(
                            "job_stale_chat_dropped job_id=%s user_id=%s chat_id=%s attempts=%s max_attempts=%s detail=%s",
                            job_id,
                            user_id,
                            chat_id,
                            attempts,
                            max_attempts,
                            exc,
                        )
                        self.publish_job_event(job_id, "meta", {"chat_id": chat_id, "source": "stale-chat", "detail": str(exc)})
                        continue
                    error_text = f"Unexpected worker failure: {exc}"
                    self.store.retry_or_dead_letter_job(job_id, error_text, retry_base_seconds=0)
                    self._clear_touch_tracking(job_id)
                    LOGGER.exception(
                        "job_unexpected_failure job_id=%s user_id=%s chat_id=%s attempts=%s max_attempts=%s",
                        job_id,
                        user_id,
                        chat_id,
                        attempts,
                        max_attempts,
                    )
                    self._safe_add_system_message(user_id=user_id, chat_id=chat_id, text=error_text)
                    self.publish_job_event(job_id, "error", {"error": error_text, "chat_id": chat_id, "retrying": False})

    def _prune_event_history(self) -> None:
        now = time.monotonic()
        cutoff = now - self.job_event_history_ttl_seconds
        with self._event_lock:
            removable: list[tuple[int, float]] = []
            for job_id, timestamp in self._event_timestamps.items():
                has_subscribers = bool(self._event_queues.get(job_id))
                if not has_subscribers and timestamp < cutoff:
                    removable.append((job_id, timestamp))

            if len(self._event_history) > self.job_event_history_max_jobs:
                overage = len(self._event_history) - self.job_event_history_max_jobs
                for job_id, _ in sorted(removable, key=lambda item: item[1])[:overage]:
                    self._event_history.pop(job_id, None)
                    self._event_timestamps.pop(job_id, None)

            for job_id, _ in removable:
                if job_id not in self._event_queues:
                    self._event_history.pop(job_id, None)
                    self._event_timestamps.pop(job_id, None)

    @staticmethod
    def _chunk_assistant_reply(text: str, chunk_len: int) -> list[str]:
        cleaned = str(text or "").strip()
        if not cleaned:
            return []

        safe_chunk_len = max(800, int(chunk_len or 12000))
        parts: list[str] = []
        cursor = 0
        text_len = len(cleaned)

        while cursor < text_len:
            end = min(text_len, cursor + safe_chunk_len)
            if end < text_len:
                split_candidates = ["\n\n", "\n", " "]
                best = -1
                for token in split_candidates:
                    idx = cleaned.rfind(token, cursor, end)
                    if idx > best:
                        best = idx
                if best > cursor:
                    end = best + 1
            piece = cleaned[cursor:end].strip()
            if piece:
                parts.append(piece)
            cursor = end

        return parts

    @staticmethod
    def _build_recent_context_brief(history: list[dict[str, object]], max_items: int = 8, max_chars: int = 1200) -> str:
        if not history:
            return ""

        lines: list[str] = []
        for turn in history:
            role = str(turn.get("role") or "").strip().lower()
            if role not in {"operator", "hermes", "system"}:
                continue

            body = str(turn.get("body") or turn.get("content") or "").strip()
            if not body:
                continue

            body_single = " ".join(body.split())
            if len(body_single) > 180:
                body_single = body_single[:177].rstrip() + "..."

            if role == "operator":
                label = "user"
            elif role == "hermes":
                label = "assistant"
            else:
                label = "system"

            lines.append(f"- {label}: {body_single}")

        if not lines:
            return ""

        selected = lines[-max_items:]
        brief = "\n".join(selected)
        if len(brief) > max_chars:
            brief = brief[-max_chars:]
            newline = brief.find("\n")
            if newline > 0:
                brief = brief[newline + 1 :]
        return brief
