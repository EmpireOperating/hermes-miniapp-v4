from __future__ import annotations

import importlib
import logging
import queue
import sys
import threading
import time
from typing import Any, Iterator

from hermes_client_types import HermesClientError


logger = logging.getLogger(__name__)


class HermesClientPersistentAgentMixin:
    def _build_agent_kwargs(self, *, session_id: str, tool_progress_callback: callable) -> dict[str, Any]:
        session_db = getattr(self, "_session_db", None)
        agent_kwargs: dict[str, Any] = {
            "session_id": session_id,
            "max_iterations": self.max_iterations,
            "quiet_mode": True,
            "verbose_logging": False,
            "tool_progress_callback": tool_progress_callback,
            "platform": "telegram",
            "session_db": session_db,
        }

        if (
            session_db is None
            and getattr(self, "direct_agent_enabled", False)
            and getattr(self, "persistent_sessions_enabled", False)
            and not getattr(self, "_warned_missing_session_db_in_kwargs", False)
        ):
            logger.warning(
                "Persistent agent kwargs built without session_db; recall tools may be unavailable.",
                extra={"session_id": session_id},
            )
            setattr(self, "_warned_missing_session_db_in_kwargs", True)

        if self.model:
            agent_kwargs["model"] = self.model
        if self.provider:
            agent_kwargs["provider"] = self.provider
        if self.base_url:
            agent_kwargs["base_url"] = self.base_url
        return agent_kwargs

    def _import_aiagent_class(self):
        """Import run_agent.AIAgent with a robust fallback for miniapp cwd setups."""
        try:
            from run_agent import AIAgent

            return AIAgent
        except ModuleNotFoundError as exc:
            # Only handle root module import errors here; nested import failures
            # should still bubble with their original context.
            if getattr(exc, "name", None) not in {None, "run_agent"}:
                raise

            workdir = str(self.agent_workdir or "").strip()
            if workdir and workdir not in sys.path:
                sys.path.insert(0, workdir)
                importlib.invalidate_caches()

            try:
                from run_agent import AIAgent

                return AIAgent
            except ModuleNotFoundError as final_exc:
                raise HermesClientError(
                    "Unable to import run_agent.AIAgent for persistent miniapp sessions "
                    f"(MINI_APP_AGENT_WORKDIR={workdir or '<empty>'})."
                ) from final_exc

    def _stream_via_persistent_agent(
        self,
        *,
        user_id: str,
        message: str,
        conversation_history: list[dict[str, Any]] | None = None,
        session_id: str | None = None,
    ) -> Iterator[dict[str, Any]]:
        effective_session_id = session_id or f"miniapp-{user_id}"

        def _create_agent():
            AIAgent = self._import_aiagent_class()

            # Initial callback is a no-op; each request installs a per-request callback.
            return AIAgent(**self._build_agent_kwargs(session_id=effective_session_id, tool_progress_callback=lambda *a, **k: None))

        runtime = self._session_manager.get_or_create(
            session_id=effective_session_id,
            model=self.model,
            max_iterations=self.max_iterations,
            create_agent=_create_agent,
        )

        initial_bootstrapped = runtime.bootstrapped
        event_queue: queue.Queue[dict[str, Any]] = queue.Queue()
        request_started = time.perf_counter()
        last_tool_name = {"value": None}

        def progress_callback(tool_name, preview=None, args=None):
            if self.tool_progress_mode == "off":
                return
            if self.tool_progress_mode == "new" and tool_name == last_tool_name["value"]:
                return
            last_tool_name["value"] = tool_name
            event_queue.put(
                {
                    "kind": "tool",
                    "tool_name": tool_name,
                    "preview": preview or "",
                    "args": args or {},
                    "display": self._format_tool_progress(tool_name, preview=preview, args=args),
                }
            )

        def worker() -> None:
            try:
                with runtime.lock:
                    runtime.last_used_at = time.time()
                    runtime.agent.tool_progress_callback = progress_callback

                    include_history = not runtime.bootstrapped
                    if include_history:
                        normalized_history = self._normalize_conversation_history(conversation_history)
                    else:
                        live_checkpoint = list(runtime.checkpoint_history or [])
                        if live_checkpoint:
                            normalized_history = live_checkpoint
                        else:
                            # Defensive fallback: if runtime was marked bootstrapped but
                            # no in-memory checkpoint survived, rehydrate from caller-provided
                            # history instead of running context-free.
                            normalized_history = self._normalize_conversation_history(conversation_history)

                    result = runtime.agent.run_conversation(
                        message,
                        conversation_history=normalized_history,
                        task_id=effective_session_id,
                    )

                    reply = str(result.get("final_response") or "").strip()
                    if not reply:
                        raise HermesClientError(str(result.get("error") or "Hermes persistent runtime returned an empty reply."))

                    checkpoint_history: list[dict[str, str]] = []
                    for item in (result.get("messages") or []):
                        if not isinstance(item, dict):
                            continue
                        role = str(item.get("role") or "").strip().lower()
                        content = str(item.get("content") or "").strip()
                        if role not in {"user", "assistant", "system"} or not content:
                            continue
                        checkpoint_history.append({"role": role, "content": content})

                    # Some run_agent paths return only the latest turn (or no message trace).
                    # Keep our own running checkpoint so the next turn always has continuity.
                    if not checkpoint_history:
                        checkpoint_history = list(normalized_history or [])
                        checkpoint_history.append({"role": "user", "content": message})
                        checkpoint_history.append({"role": "assistant", "content": reply})
                    elif normalized_history and len(checkpoint_history) <= 2:
                        checkpoint_history = list(normalized_history)
                        checkpoint_history.append({"role": "user", "content": message})
                        checkpoint_history.append({"role": "assistant", "content": reply})

                    if len(checkpoint_history) > 160:
                        checkpoint_history = checkpoint_history[-160:]

                    runtime.checkpoint_history = list(checkpoint_history)
                    runtime.bootstrapped = True

                event_queue.put(
                    {
                        "kind": "done",
                        "reply": reply,
                        "source": "agent-persistent",
                        "latency_ms": int((time.perf_counter() - request_started) * 1000),
                        "runtime_checkpoint": checkpoint_history,
                    }
                )
            except Exception as exc:  # noqa: BLE001 - broad-except-policy: intentional-no-log worker forwards failures via event_queue error payload
                event_queue.put({"kind": "error", "error": str(exc)})
            finally:
                event_queue.put({"kind": "end"})

        threading.Thread(target=worker, name=f"miniapp-runtime-{effective_session_id}", daemon=True).start()

        yield {
            "type": "meta",
            "source": "agent-persistent",
            "persistent_mode": "live" if initial_bootstrapped else "bootstrap",
            "session_id": effective_session_id,
        }

        chunk_size = max(1, self.stream_chunk_size)
        timeout_seconds = max(1, int(getattr(self, "timeout_seconds", 120) or 120))
        last_event_at = time.monotonic()
        while True:
            idle_for = time.monotonic() - last_event_at
            remaining_idle = timeout_seconds - idle_for
            if remaining_idle <= 0:
                raise HermesClientError(
                    f"Hermes persistent runtime timed out after {timeout_seconds}s with no progress "
                    f"(session_id={effective_session_id})."
                )
            try:
                item = event_queue.get(timeout=min(0.2, max(0.05, remaining_idle)))
            except queue.Empty:
                continue

            # Count any queue activity as forward progress (tool/done/error/end).
            last_event_at = time.monotonic()
            kind = item.get("kind")
            if kind == "tool":
                yield {
                    "type": "tool",
                    "tool_name": item.get("tool_name"),
                    "preview": item.get("preview"),
                    "args": item.get("args"),
                    "display": item.get("display"),
                }
            elif kind == "done":
                reply = str(item.get("reply") or "")
                for index in range(0, len(reply), chunk_size):
                    yield {"type": "chunk", "text": reply[index : index + chunk_size]}
                yield {
                    "type": "done",
                    "reply": reply,
                    "source": item.get("source") or "agent-persistent",
                    "latency_ms": item.get("latency_ms"),
                    "runtime_checkpoint": item.get("runtime_checkpoint") or [],
                }
            elif kind == "error":
                raise HermesClientError(str(item.get("error") or "Hermes persistent runtime failed."))
            elif kind == "end":
                break
