from __future__ import annotations

import json
import importlib
import logging
import os
import queue
import re
import subprocess
import sys
import textwrap
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator

import requests


logger = logging.getLogger(__name__)


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


class HermesClient:
    """Adapter over either a Hermes HTTP endpoint, in-process Hermes agent, or local CLI.

    Streaming strategy:
    - If HERMES_STREAM_URL is set, it is treated as the preferred true-stream endpoint.
    - Otherwise, if HERMES_API_URL is set, the client first attempts to read a chunked/SSE-like
      response from that endpoint and falls back to a normal JSON POST if needed.
    - Otherwise, when MINI_APP_DIRECT_AGENT is enabled (default), stream via the in-process
      Hermes agent so tool progress can be surfaced live.
    - If direct agent streaming is unavailable, the local CLI is used and the response is chunked locally.
    """

    def __init__(self) -> None:
        self.api_url = os.environ.get("HERMES_API_URL")
        self.stream_url = os.environ.get("HERMES_STREAM_URL")
        self.cli_command = os.environ.get("HERMES_CLI_COMMAND", "hermes")
        env_model = (os.environ.get("HERMES_MODEL") or "").strip()
        env_provider = (os.environ.get("HERMES_PROVIDER") or "").strip()
        env_base_url = (os.environ.get("HERMES_BASE_URL") or "").strip()
        self.timeout_seconds = int(os.environ.get("HERMES_TIMEOUT_SECONDS", "120"))
        self.stream_chunk_size = int(os.environ.get("HERMES_STREAM_CHUNK_SIZE", "28"))
        self.direct_agent_enabled = os.environ.get("MINI_APP_DIRECT_AGENT", "1") == "1"
        self.max_iterations = int(os.environ.get("HERMES_MAX_ITERATIONS", "90"))
        self.tool_progress_mode = (os.environ.get("HERMES_TOOL_PROGRESS_MODE") or "all").strip().lower()
        self.agent_python = os.environ.get("MINI_APP_AGENT_PYTHON") or "/home/hermes-agent/.hermes/hermes-agent/venv/bin/python"
        self.agent_home = os.environ.get("MINI_APP_AGENT_HOME") or "/home/hermes-agent"
        self.agent_hermes_home = os.environ.get("MINI_APP_AGENT_HERMES_HOME") or f"{self.agent_home}/.hermes"
        self.agent_workdir = os.environ.get("MINI_APP_AGENT_WORKDIR") or f"{self.agent_hermes_home}/hermes-agent"
        self.agent_venv = os.environ.get("MINI_APP_AGENT_VENV") or f"{self.agent_workdir}/venv"
        self.model = env_model if env_model and env_model.lower() != "auto" else self._load_default_model_from_config()
        self.provider, self.base_url = self._resolve_agent_routing(env_provider=env_provider, env_base_url=env_base_url)
        self.persistent_sessions_enabled = os.environ.get("MINI_APP_PERSISTENT_SESSIONS", "0") == "1"
        self.persistent_max_sessions = int(os.environ.get("MINI_APP_PERSISTENT_MAX_SESSIONS", "64"))
        self.persistent_idle_ttl_seconds = int(os.environ.get("MINI_APP_PERSISTENT_IDLE_TTL_SECONDS", "1800"))
        self._session_manager = PersistentSessionManager(
            max_sessions=self.persistent_max_sessions,
            idle_ttl_seconds=self.persistent_idle_ttl_seconds,
        )

    def _resolve_agent_routing(self, *, env_provider: str, env_base_url: str) -> tuple[str | None, str | None]:
        provider = env_provider if env_provider and env_provider.lower() != "auto" else None
        base_url = env_base_url if env_base_url and env_base_url.lower() != "auto" else None

        if provider is None:
            provider = self._load_active_provider_from_auth_store()

        if base_url is None:
            base_url = self._load_base_url_from_config()

        return provider, base_url

    def _load_active_provider_from_auth_store(self) -> str | None:
        auth_path = Path(self.agent_hermes_home) / "auth.json"
        if not auth_path.exists():
            return None
        try:
            data = json.loads(auth_path.read_text(encoding="utf-8"))
        except Exception:
            return None
        provider = data.get("active_provider")
        if isinstance(provider, str) and provider.strip():
            return provider.strip()
        return None

    def _load_base_url_from_config(self) -> str | None:
        model_cfg = self._load_model_cfg_from_config()
        if not isinstance(model_cfg, dict):
            return None
        base_url = model_cfg.get("base_url")
        if isinstance(base_url, str) and base_url.strip():
            return base_url.strip()
        return None

    def _load_default_model_from_config(self) -> str | None:
        model_cfg = self._load_model_cfg_from_config()
        if not isinstance(model_cfg, dict):
            return None
        default_model = model_cfg.get("default")
        if isinstance(default_model, str) and default_model.strip():
            return default_model.strip()
        return None

    def _load_model_cfg_from_config(self) -> dict[str, Any] | None:
        config_path = Path(self.agent_hermes_home) / "config.yaml"
        if not config_path.exists():
            return None
        try:
            import yaml

            data = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
        except Exception:
            return None
        model_cfg = data.get("model") if isinstance(data, dict) else None
        return model_cfg if isinstance(model_cfg, dict) else None

    def should_include_conversation_history(self, *, session_id: str | None) -> bool:
        """Whether caller should include DB history for this request.

        In persistent-session mode, only the first turn for a runtime should inject
        historical context. Subsequent turns rely on the live in-memory runtime.
        """
        if not (self.direct_agent_enabled and self.persistent_sessions_enabled):
            return True

        runtime = self._session_manager.get_runtime(session_id or "") if session_id else None
        if runtime is None:
            return True
        return not runtime.bootstrapped

    def evict_session(self, session_id: str) -> bool:
        if not session_id:
            return False
        return self._session_manager.evict(session_id)

    def persistent_stats(self) -> dict[str, int | bool]:
        stats = self._session_manager.stats()
        return {
            "enabled": self.persistent_sessions_enabled and self.direct_agent_enabled,
            "total": int(stats.get("total", 0)),
            "bootstrapped": int(stats.get("bootstrapped", 0)),
            "unbootstrapped": int(stats.get("unbootstrapped", 0)),
        }

    def runtime_status(self) -> dict[str, Any]:
        return {
            "persistent": self.persistent_stats(),
            "routing": {
                "model": self.model,
                "provider": self.provider,
                "base_url": self.base_url,
                "direct_agent_enabled": self.direct_agent_enabled,
                "persistent_sessions_enabled": self.persistent_sessions_enabled,
            },
        }

    def ask(self, user_id: str, message: str, *, conversation_history: list[dict[str, Any]] | None = None) -> HermesReply:
        """Send a message to Hermes and return the full reply."""
        cleaned = message.strip()
        if not cleaned:
            raise HermesClientError("Message cannot be empty.")

        started = time.perf_counter()
        if self.api_url:
            text, source = self._ask_via_http(user_id=user_id, message=cleaned)
        else:
            text, source = self._ask_via_cli(message=cleaned)
        latency_ms = int((time.perf_counter() - started) * 1000)
        return HermesReply(text=text, source=source, latency_ms=latency_ms)

    def stream_ask(self, user_id: str, message: str) -> Iterator[str]:
        """Yield the reply text in chunks only."""
        for event in self.stream_events(user_id=user_id, message=message):
            if event.get("type") == "chunk":
                text = str(event.get("text") or "")
                if text:
                    yield text

    def stream_events(
        self,
        user_id: str,
        message: str,
        *,
        conversation_history: list[dict[str, Any]] | None = None,
        session_id: str | None = None,
    ) -> Iterator[dict[str, Any]]:
        """Yield structured streaming events for the mini app.

        Event types:
        - {type: "meta", source: "..."}
        - {type: "tool", tool_name: "...", preview: "...", display: "..."}
        - {type: "chunk", text: "..."}
        - {type: "done", reply: "...", source: "...", latency_ms: N}
        """
        cleaned = message.strip()
        if not cleaned:
            raise HermesClientError("Message cannot be empty.")

        if self.stream_url:
            yield {"type": "meta", "source": "http-stream"}
            built = []
            started = time.perf_counter()
            for chunk in self._stream_via_http(self.stream_url, user_id=user_id, message=cleaned):
                if not chunk:
                    continue
                built.append(chunk)
                yield {"type": "chunk", "text": chunk}
            reply = "".join(built).strip()
            if not reply:
                raise HermesClientError("Hermes stream endpoint returned an empty reply.")
            yield {
                "type": "done",
                "reply": reply,
                "source": "http-stream",
                "latency_ms": int((time.perf_counter() - started) * 1000),
            }
            return

        if self.api_url:
            try:
                yielded_any = False
                built = []
                started = time.perf_counter()
                yield {"type": "meta", "source": "http"}
                for chunk in self._stream_via_http(self.api_url, user_id=user_id, message=cleaned):
                    yielded_any = True
                    built.append(chunk)
                    yield {"type": "chunk", "text": chunk}
                if yielded_any:
                    reply = "".join(built).strip()
                    yield {
                        "type": "done",
                        "reply": reply,
                        "source": "http",
                        "latency_ms": int((time.perf_counter() - started) * 1000),
                    }
                    return
            except HermesClientError:
                pass

        if self.direct_agent_enabled and self.persistent_sessions_enabled:
            try:
                yield from self._stream_via_persistent_agent(
                    user_id=user_id,
                    message=cleaned,
                    conversation_history=conversation_history,
                    session_id=session_id,
                )
                return
            except Exception as exc:
                # Fall back to existing subprocess/CLI path when persistent runtime fails.
                logger.warning(
                    "Persistent miniapp runtime failed; falling back to non-persistent path",
                    extra={
                        "session_id": session_id or "",
                        "user_id": user_id,
                        "error": str(exc),
                        "fallback_to": "agent" if self.direct_agent_enabled else "cli",
                    },
                    exc_info=True,
                )

        if self.direct_agent_enabled:
            try:
                yield from self._stream_via_agent(
                    user_id=user_id,
                    message=cleaned,
                    conversation_history=conversation_history,
                    session_id=session_id,
                )
                return
            except HermesClientError:
                pass

        yield from self._stream_via_cli_progress(message=cleaned)
        return

    def _request_payload(self, user_id: str, message: str) -> dict[str, str]:
        payload = {"user_id": user_id, "message": message}
        if self.model:
            payload["model"] = self.model
        return payload

    def _ask_via_http(self, user_id: str, message: str) -> tuple[str, str]:
        payload = self._request_payload(user_id=user_id, message=message)
        headers = {"Accept": "application/json, text/event-stream;q=0.9, text/plain;q=0.7"}
        try:
            response = requests.post(self.api_url, json=payload, timeout=self.timeout_seconds, headers=headers)
            response.raise_for_status()
        except requests.RequestException as exc:
            raise HermesClientError(f"Hermes HTTP call failed: {exc}") from exc

        content_type = response.headers.get("content-type", "")
        if "application/json" in content_type:
            try:
                data = response.json()
            except json.JSONDecodeError as exc:
                raise HermesClientError("Hermes HTTP endpoint returned invalid JSON.") from exc
            reply_text = (data.get("reply") or data.get("text") or data.get("content") or "").strip()
            if not reply_text:
                raise HermesClientError("Hermes HTTP endpoint returned an empty reply.")
            return reply_text, "http"

        reply_text = response.text.strip()
        if not reply_text:
            raise HermesClientError("Hermes HTTP endpoint returned an empty reply.")
        return reply_text, "http-text"

    def _stream_via_http(self, url: str, user_id: str, message: str) -> Iterator[str]:
        payload = self._request_payload(user_id=user_id, message=message)
        headers = {"Accept": "text/event-stream, application/x-ndjson, text/plain"}
        try:
            with requests.post(
                url,
                json=payload,
                timeout=self.timeout_seconds,
                headers=headers,
                stream=True,
            ) as response:
                response.raise_for_status()
                content_type = response.headers.get("content-type", "")
                if "text/event-stream" in content_type:
                    yield from self._yield_sse_chunks(response)
                    return
                if "application/x-ndjson" in content_type or "application/jsonl" in content_type:
                    yield from self._yield_ndjson_chunks(response)
                    return
                yield from self._yield_raw_chunks(response)
        except requests.RequestException as exc:
            raise HermesClientError(f"Hermes stream call failed: {exc}") from exc

    def _yield_sse_chunks(self, response: requests.Response) -> Iterator[str]:
        yielded_any = False
        for line in response.iter_lines(decode_unicode=True):
            if line is None:
                continue
            stripped = line.strip()
            if not stripped:
                continue
            if stripped.startswith("data:"):
                data = stripped[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    payload = json.loads(data)
                    chunk = str(
                        payload.get("chunk")
                        or payload.get("text")
                        or payload.get("delta")
                        or payload.get("content")
                        or ""
                    )
                except json.JSONDecodeError:
                    chunk = data
                if chunk:
                    yielded_any = True
                    yield chunk
        if not yielded_any:
            raise HermesClientError("Hermes stream endpoint did not yield any chunks.")

    def _yield_ndjson_chunks(self, response: requests.Response) -> Iterator[str]:
        yielded_any = False
        for line in response.iter_lines(decode_unicode=True):
            if not line:
                continue
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                continue
            chunk = str(payload.get("chunk") or payload.get("text") or payload.get("delta") or "")
            if chunk:
                yielded_any = True
                yield chunk
        if not yielded_any:
            raise HermesClientError("Hermes NDJSON stream endpoint did not yield any chunks.")

    def _yield_raw_chunks(self, response: requests.Response) -> Iterator[str]:
        yielded_any = False
        for chunk in response.iter_content(chunk_size=max(1, self.stream_chunk_size), decode_unicode=True):
            if not chunk:
                continue
            yielded_any = True
            yield chunk
        if not yielded_any:
            raise HermesClientError("Hermes raw stream endpoint did not yield any chunks.")

    def _build_agent_kwargs(self, *, session_id: str, tool_progress_callback: callable) -> dict[str, Any]:
        agent_kwargs: dict[str, Any] = {
            "session_id": session_id,
            "max_iterations": self.max_iterations,
            "quiet_mode": True,
            "verbose_logging": False,
            "tool_progress_callback": tool_progress_callback,
            "platform": "telegram",
        }
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
                        normalized_history = list(runtime.checkpoint_history or []) or None

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

                    # Some run_agent paths return only the latest turn when called without
                    # explicit conversation_history. Keep our own running checkpoint so the
                    # next turn always has continuity.
                    if normalized_history:
                        if not checkpoint_history or len(checkpoint_history) <= 2:
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
            except Exception as exc:  # noqa: BLE001
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
        while True:
            item = event_queue.get()
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

    def _ask_via_agent(
        self,
        *,
        user_id: str,
        message: str,
        conversation_history: list[dict[str, Any]] | None = None,
    ) -> tuple[str, str]:
        events = self._stream_via_agent(
            user_id=user_id,
            message=message,
            conversation_history=conversation_history,
            session_id=f"miniapp-{user_id}-{uuid.uuid4().hex[:8]}",
        )
        reply = ""
        source = "agent"
        for event in events:
            event_type = event.get("type")
            if event_type == "meta":
                source = str(event.get("source") or source)
            elif event_type == "chunk":
                reply += str(event.get("text") or "")
            elif event_type == "done":
                reply = str(event.get("reply") or reply)
                source = str(event.get("source") or source)
        if not reply.strip():
            raise HermesClientError("Hermes agent returned an empty reply.")
        return reply, source

    def _stream_via_agent(
        self,
        *,
        user_id: str,
        message: str,
        conversation_history: list[dict[str, Any]] | None = None,
        session_id: str | None = None,
    ) -> Iterator[dict[str, Any]]:
        if not os.path.exists(self.agent_python):
            raise HermesClientError(f"Hermes direct agent python not found: {self.agent_python}")

        payload = {
            "message": message,
            "conversation_history": self._normalize_conversation_history(conversation_history),
            "session_id": session_id or f"miniapp-{user_id}-{uuid.uuid4().hex[:8]}",
            "model": self.model,
            "max_iterations": self.max_iterations,
            "tool_progress_mode": self.tool_progress_mode,
        }

        child_env = os.environ.copy()
        child_env["HOME"] = self.agent_home
        child_env["HERMES_HOME"] = self.agent_hermes_home
        child_env["VIRTUAL_ENV"] = self.agent_venv
        child_env["PATH"] = f"{self.agent_venv}/bin:{child_env.get('PATH', '')}"

        try:
            process = subprocess.Popen(
                [self.agent_python, "-u", "-c", self._agent_runner_script()],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                env=child_env,
                cwd=self.agent_workdir,
            )
        except OSError as exc:
            raise HermesClientError(f"Failed to start Hermes direct agent: {exc}") from exc

        try:
            assert process.stdin is not None
            process.stdin.write(json.dumps(payload, ensure_ascii=False))
            process.stdin.close()
        except OSError as exc:
            process.kill()
            raise HermesClientError(f"Failed to send payload to Hermes direct agent: {exc}") from exc

        yield {"type": "meta", "source": "agent"}

        assert process.stdout is not None
        for raw_line in process.stdout:
            line = raw_line.strip()
            if not line:
                continue
            try:
                item = json.loads(line)
            except json.JSONDecodeError:
                continue
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
                chunk_size = max(1, self.stream_chunk_size)
                for index in range(0, len(reply), chunk_size):
                    yield {"type": "chunk", "text": reply[index : index + chunk_size]}
                yield {
                    "type": "done",
                    "reply": reply,
                    "source": item.get("source") or "agent",
                    "latency_ms": item.get("latency_ms"),
                }
            elif kind == "error":
                raise HermesClientError(str(item.get("error") or "Hermes agent run failed."))

        return_code = process.wait(timeout=self.timeout_seconds)
        stderr = ""
        if process.stderr is not None:
            stderr = process.stderr.read().strip()
        if return_code != 0 and stderr:
            raise HermesClientError(stderr)
        if return_code != 0:
            raise HermesClientError(f"Hermes direct agent exited with status {return_code}.")

    def _normalize_conversation_history(
        self,
        history: list[dict[str, Any]] | None,
    ) -> list[dict[str, str]]:
        if not history:
            return []

        normalized: list[dict[str, str]] = []
        for message in history:
            role = str(message.get("role") or "").strip().lower()
            content = str(message.get("content") or message.get("body") or "").strip()
            if not role or not content:
                continue
            if role in {"operator", "user"}:
                normalized.append({"role": "user", "content": content})
            elif role in {"hermes", "assistant"}:
                normalized.append({"role": "assistant", "content": content})
            elif role == "system":
                normalized.append({"role": "system", "content": content})
        return normalized

    def _format_tool_progress(
        self,
        tool_name: str,
        *,
        preview: str | None = None,
        args: dict[str, Any] | None = None,
    ) -> str:
        tool_emojis = {
            "terminal": "💻",
            "process": "⚙️",
            "web_search": "🔍",
            "web_extract": "📄",
            "read_file": "📖",
            "write_file": "✍️",
            "patch": "🔧",
            "search": "🔎",
            "search_files": "🔎",
            "image_generate": "🎨",
            "text_to_speech": "🔊",
            "browser_navigate": "🌐",
            "browser_click": "👆",
            "browser_type": "⌨️",
            "browser_snapshot": "📸",
            "browser_scroll": "📜",
            "browser_back": "◀️",
            "browser_press": "⌨️",
            "browser_close": "🚪",
            "browser_get_images": "🖼️",
            "browser_vision": "👁️",
            "vision_analyze": "👁️",
            "skill_view": "📚",
            "skills_list": "📋",
            "todo": "📋",
            "memory": "🧠",
            "session_search": "🔍",
            "send_message": "📨",
            "execute_code": "🐍",
            "delegate_task": "🔀",
            "clarify": "❓",
            "skill_manage": "📝",
        }
        emoji = tool_emojis.get(tool_name, "⚙️")

        if self.tool_progress_mode == "verbose" and args:
            args_str = json.dumps(args, ensure_ascii=False, default=str)
            if len(args_str) > 200:
                args_str = args_str[:197] + "..."
            return f"{emoji} {tool_name}({list(args.keys())})\n{args_str}"

        clean_preview = str(preview or "").strip()
        if clean_preview:
            if len(clean_preview) > 80:
                clean_preview = clean_preview[:77] + "..."
            return f"{emoji} {tool_name}: \"{clean_preview}\""
        return f"{emoji} {tool_name}..."

    def _agent_runner_script(self) -> str:
        return textwrap.dedent(
            """
            import json
            import sys
            import time

            def emit(payload):
                print(json.dumps(payload, ensure_ascii=False), flush=True)

            def format_tool_progress(tool_name, preview=None, args=None, mode='all'):
                tool_emojis = {
                    'terminal': '💻', 'process': '⚙️', 'web_search': '🔍', 'web_extract': '📄',
                    'read_file': '📖', 'write_file': '✍️', 'patch': '🔧', 'search': '🔎',
                    'search_files': '🔎', 'image_generate': '🎨', 'text_to_speech': '🔊',
                    'browser_navigate': '🌐', 'browser_click': '👆', 'browser_type': '⌨️',
                    'browser_snapshot': '📸', 'browser_scroll': '📜', 'browser_back': '◀️',
                    'browser_press': '⌨️', 'browser_close': '🚪', 'browser_get_images': '🖼️',
                    'browser_vision': '👁️', 'vision_analyze': '👁️', 'skill_view': '📚',
                    'skills_list': '📋', 'todo': '📋', 'memory': '🧠', 'session_search': '🔍',
                    'send_message': '📨', 'execute_code': '🐍', 'delegate_task': '🔀',
                    'clarify': '❓', 'skill_manage': '📝',
                }
                emoji = tool_emojis.get(tool_name, '⚙️')
                if mode == 'verbose' and args:
                    args_str = json.dumps(args, ensure_ascii=False, default=str)
                    if len(args_str) > 200:
                        args_str = args_str[:197] + '...'
                    return f"{emoji} {tool_name}({list(args.keys())})\\n{args_str}"
                preview = str(preview or '').strip()
                if preview:
                    if len(preview) > 80:
                        preview = preview[:77] + '...'
                    return f'{emoji} {tool_name}: "{preview}"'
                return f'{emoji} {tool_name}...'

            payload = json.loads(sys.stdin.read() or '{}')
            from run_agent import AIAgent

            message = str(payload.get('message') or '').strip()
            if not message:
                emit({'kind': 'error', 'error': 'Message cannot be empty.'})
                raise SystemExit(1)

            tool_progress_mode = str(payload.get('tool_progress_mode') or 'all').strip().lower()
            last_tool = {'name': None}
            started = time.perf_counter()

            def progress_callback(tool_name, preview=None, args=None):
                if tool_progress_mode == 'off':
                    return
                if tool_progress_mode == 'new' and tool_name == last_tool['name']:
                    return
                last_tool['name'] = tool_name
                emit({
                    'kind': 'tool',
                    'tool_name': tool_name,
                    'preview': preview or '',
                    'args': args or {},
                    'display': format_tool_progress(tool_name, preview=preview, args=args, mode=tool_progress_mode),
                })

            agent_kwargs = {
                'max_iterations': int(payload.get('max_iterations') or 90),
                'quiet_mode': True,
                'verbose_logging': False,
                'tool_progress_callback': progress_callback,
                'platform': 'telegram',
            }
            if payload.get('model'):
                agent_kwargs['model'] = payload['model']

            try:
                agent = AIAgent(**agent_kwargs)
                result = agent.run_conversation(
                    message,
                    conversation_history=payload.get('conversation_history') or [],
                    task_id=payload.get('session_id') or 'miniapp-agent',
                )
                reply = str(result.get('final_response') or '').strip()
                if not reply:
                    emit({'kind': 'error', 'error': str(result.get('error') or 'Hermes agent returned an empty reply.')})
                    raise SystemExit(1)
                emit({
                    'kind': 'done',
                    'reply': reply,
                    'source': 'agent',
                    'latency_ms': int((time.perf_counter() - started) * 1000),
                })
            except Exception as exc:
                emit({'kind': 'error', 'error': str(exc)})
                raise
            """
        )

    def _cli_env(self) -> dict[str, str]:
        env = os.environ.copy()
        env["HOME"] = self.agent_home
        env["HERMES_HOME"] = self.agent_hermes_home
        env["VIRTUAL_ENV"] = self.agent_venv
        env["PATH"] = f"{self.agent_venv}/bin:{env.get('PATH', '')}"
        return env

    def _normalize_cli_tool_line(self, line: str) -> str:
        emoji_match = re.search(r"(🔎|💻|⚙️|🌐|📖|✍️|🔧|👁️|📄|📋|🧠|⌨️|🚪)", line)
        cleaned = line[emoji_match.start():].strip() if emoji_match else line.strip()
        cleaned = re.sub(r"\s*\(\d+(?:\.\d+)?s\)$", "", cleaned).strip()
        cleaned = re.sub(r"\s{2,}", " ", cleaned)
        return cleaned or line.strip()

    def _stream_via_cli_progress(self, message: str) -> Iterator[dict[str, Any]]:
        command = [self.cli_command, "chat", "--query", message]
        if self.model:
            command.extend(["--model", self.model])

        try:
            process = subprocess.Popen(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                env=self._cli_env(),
                cwd=os.getcwd(),
                bufsize=1,
            )
        except OSError as exc:
            raise HermesClientError(f"Hermes CLI stream failed to start: {exc}") from exc

        yield {"type": "meta", "source": "cli"}

        assert process.stdout is not None
        in_query_section = False
        in_reply = False
        reply_lines: list[str] = []
        last_tool_line = ""
        buffer = ""

        while True:
            chunk = process.stdout.read(1)
            if chunk == "":
                break
            if chunk not in {"\n", "\r"}:
                buffer += chunk
                continue

            line = buffer.strip()
            buffer = ""
            if not line:
                continue
            if line.startswith("Query:"):
                in_query_section = True
                continue
            if not in_query_section:
                continue
            if "⚕ Hermes" in line:
                in_reply = True
                continue
            if in_reply:
                if line.startswith("Resume this session") or line.startswith("Session:") or line.startswith("Duration:") or line.startswith("Messages:"):
                    in_reply = False
                    continue
                if set(line) <= {"─", " ", "┄", "━"}:
                    continue
                reply_lines.append(line)
                continue
            if any(symbol in line for symbol in ("🔎", "💻", "⚙️", "🌐", "📖", "✍️", "🔧", "👁️", "📄", "📋", "🧠", "⌨️", "🚪")):
                normalized_line = self._normalize_cli_tool_line(line)
                if normalized_line and normalized_line != last_tool_line:
                    last_tool_line = normalized_line
                    yield {"type": "tool", "display": normalized_line}

        return_code = process.wait(timeout=self.timeout_seconds)
        if return_code != 0:
            raise HermesClientError("Hermes CLI stream failed.")

        reply = "\n".join(line for line in reply_lines if line).strip()
        if not reply:
            raise HermesClientError("Hermes CLI stream returned an empty reply.")

        chunk_size = max(1, self.stream_chunk_size)
        for index in range(0, len(reply), chunk_size):
            yield {"type": "chunk", "text": reply[index : index + chunk_size]}
        yield {"type": "done", "reply": reply, "source": "cli"}

    def _ask_via_cli(self, message: str) -> tuple[str, str]:
        command = [self.cli_command, "chat", "--quiet", "--query", message]
        if self.model:
            command.extend(["--model", self.model])

        try:
            result = subprocess.run(
                command,
                capture_output=True,
                check=False,
                text=True,
                timeout=self.timeout_seconds,
                env=self._cli_env(),
                cwd=os.getcwd(),
            )
        except (OSError, subprocess.SubprocessError) as exc:
            raise HermesClientError(f"Hermes CLI call failed: {exc}") from exc

        if result.returncode != 0:
            stderr = result.stderr.strip() or "Unknown Hermes CLI error."
            raise HermesClientError(stderr)

        reply_text = result.stdout.strip()
        if not reply_text:
            raise HermesClientError("Hermes CLI returned an empty reply.")
        return reply_text, "cli"
