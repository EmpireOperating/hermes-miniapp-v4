from __future__ import annotations

import importlib
import logging
import os
import sys
import time
from pathlib import Path
from typing import Any, Iterator

from hermes_client_agent import HermesClientAgentMixin
from hermes_client_bootstrap import HermesClientBootstrap
from hermes_client_cli import HermesClientCLIMixin
from hermes_client_http import HermesClientHTTPMixin
from hermes_client_types import HermesClientError, HermesReply, PersistentSessionManager


logger = logging.getLogger(__name__)


class HermesClient(HermesClientHTTPMixin, HermesClientAgentMixin, HermesClientCLIMixin):
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
        self.camofox_fallback_enabled = os.environ.get("MINI_APP_CAMOFOX_FALLBACK_ENABLED", "0") == "1"
        self.camofox_base_url = (os.environ.get("MINI_APP_CAMOFOX_BASE_URL") or "http://127.0.0.1:9377").strip().rstrip("/")
        self.camofox_api_key = (os.environ.get("MINI_APP_CAMOFOX_API_KEY") or "").strip()
        self.agent_python = os.environ.get("MINI_APP_AGENT_PYTHON") or "/home/hermes-agent/.hermes/hermes-agent/venv/bin/python"
        self.agent_home = os.environ.get("MINI_APP_AGENT_HOME") or "/home/hermes-agent"
        self.agent_hermes_home = os.environ.get("MINI_APP_AGENT_HERMES_HOME") or f"{self.agent_home}/.hermes"
        self.agent_workdir = os.environ.get("MINI_APP_AGENT_WORKDIR") or f"{self.agent_hermes_home}/hermes-agent"
        self.agent_venv = os.environ.get("MINI_APP_AGENT_VENV") or f"{self.agent_workdir}/venv"
        self._session_db = self._init_session_db()
        self._bootstrap = HermesClientBootstrap(agent_hermes_home=self.agent_hermes_home, logger=logger)
        self.model = env_model if env_model and env_model.lower() != "auto" else self._load_default_model_from_config()
        self.provider, self.base_url = self._resolve_agent_routing(env_provider=env_provider, env_base_url=env_base_url)
        self.persistent_sessions_enabled = os.environ.get("MINI_APP_PERSISTENT_SESSIONS", "0") == "1"
        self.persistent_max_sessions = int(os.environ.get("MINI_APP_PERSISTENT_MAX_SESSIONS", "64"))
        self.persistent_idle_ttl_seconds = int(os.environ.get("MINI_APP_PERSISTENT_IDLE_TTL_SECONDS", "1800"))
        self._session_manager = PersistentSessionManager(
            max_sessions=self.persistent_max_sessions,
            idle_ttl_seconds=self.persistent_idle_ttl_seconds,
        )
        self._warn_if_recall_unavailable()
        self._log_startup_diagnostics()

    def _safe_info_log(self, message: str, **kwargs: Any) -> None:
        log_info = getattr(logger, "info", None)
        if not callable(log_info):
            return
        try:
            log_info(message, **kwargs)
        except Exception:  # noqa: BLE001 - broad-except-policy: intentional-no-log best-effort logger wrapper must never break caller
            pass

    def _safe_failure_reason(self, exc: Exception) -> str:
        return exc.__class__.__name__

    def _selected_transport(self) -> str:
        if self.stream_url:
            return "http-stream"
        if self.api_url:
            return "http"
        if self.direct_agent_enabled and self.persistent_sessions_enabled:
            return "agent-persistent"
        if self.direct_agent_enabled:
            return "agent"
        return "cli"

    def startup_diagnostics(self) -> dict[str, Any]:
        health = self._recall_health()
        return {
            "routing": {
                "selected_transport": self._selected_transport(),
                "stream_url_configured": bool(self.stream_url),
                "api_url_configured": bool(self.api_url),
                "direct_agent_enabled": self.direct_agent_enabled,
                "persistent_sessions_enabled": self.persistent_sessions_enabled,
                "provider_configured": bool(self.provider),
                "model_configured": bool(self.model),
                "base_url_configured": bool(self.base_url),
                "camofox_fallback_enabled": self.camofox_fallback_enabled,
                "camofox_base_url_configured": bool(self.camofox_base_url),
                "camofox_api_key_configured": bool(self.camofox_api_key),
            },
            "agent_runtime": {
                "agent_python_exists": Path(self.agent_python).exists(),
                "agent_workdir_exists": Path(self.agent_workdir).exists(),
                "agent_venv_exists": Path(self.agent_venv).exists(),
                "session_db_available": bool(health.get("session_db_available")),
                "session_search_ready": bool(health.get("session_search_ready")),
            },
            "limits": {
                "timeout_seconds": self.timeout_seconds,
                "stream_chunk_size": self.stream_chunk_size,
                "max_iterations": self.max_iterations,
                "persistent_max_sessions": self.persistent_max_sessions,
                "persistent_idle_ttl_seconds": self.persistent_idle_ttl_seconds,
            },
        }

    def _log_startup_diagnostics(self) -> None:
        payload = self.startup_diagnostics()
        self._safe_info_log("HermesClient startup diagnostics", extra={"startup": payload})

    def _init_session_db(self):
        try:
            workdir = str(self.agent_workdir or "").strip()
            if workdir and workdir not in sys.path:
                sys.path.insert(0, workdir)
                importlib.invalidate_caches()

            from hermes_state import SessionDB

            return SessionDB()
        except Exception as exc:  # noqa: BLE001 - broad-except-policy: optional runtime dependency fallback
            logger.debug("Miniapp session DB unavailable: %s", exc.__class__.__name__)
            return None

    def _resolve_agent_routing(self, *, env_provider: str, env_base_url: str) -> tuple[str | None, str | None]:
        return self._bootstrap.resolve_agent_routing(env_provider=env_provider, env_base_url=env_base_url)

    def _load_active_provider_from_auth_store(self) -> str | None:
        return self._bootstrap.load_active_provider_from_auth_store()

    def _load_base_url_from_config(self) -> str | None:
        return self._bootstrap.load_base_url_from_config()

    def _load_default_model_from_config(self) -> str | None:
        return self._bootstrap.load_default_model_from_config()

    def _load_model_cfg_from_config(self) -> dict[str, Any] | None:
        return self._bootstrap.load_model_cfg_from_config()

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

    def _recall_health(self) -> dict[str, bool]:
        session_db_available = self._session_db is not None
        kwargs_has_session_db = False
        kwargs_session_db_available = False

        if self.direct_agent_enabled and self.persistent_sessions_enabled:
            try:
                kwargs = self._build_agent_kwargs(
                    session_id="miniapp-healthcheck",
                    tool_progress_callback=lambda *_args, **_kwargs: None,
                )
            except Exception as exc:  # noqa: BLE001 - broad-except-policy: healthcheck kwargs construction is best-effort and should degrade gracefully
                logger.debug("Miniapp recall healthcheck failed building agent kwargs: %s", exc)
                kwargs = {}
            kwargs_has_session_db = "session_db" in kwargs
            kwargs_session_db_available = kwargs.get("session_db") is not None

        session_search_ready = session_db_available and kwargs_has_session_db and kwargs_session_db_available
        return {
            "session_db_available": session_db_available,
            "agent_kwargs_has_session_db": kwargs_has_session_db,
            "agent_kwargs_session_db_available": kwargs_session_db_available,
            "session_search_ready": session_search_ready,
        }

    def _warn_if_recall_unavailable(self) -> None:
        if not (self.direct_agent_enabled and self.persistent_sessions_enabled):
            return

        health = self._recall_health()
        if health.get("session_search_ready") is True:
            return

        logger.warning(
            "Persistent miniapp sessions have incomplete recall wiring; session_search may be unavailable.",
            extra={
                "session_db_available": bool(health.get("session_db_available")),
                "agent_kwargs_has_session_db": bool(health.get("agent_kwargs_has_session_db")),
                "agent_kwargs_session_db_available": bool(health.get("agent_kwargs_session_db_available")),
                "direct_agent_enabled": self.direct_agent_enabled,
                "persistent_sessions_enabled": self.persistent_sessions_enabled,
            },
        )

    def _persistent_session_id(self, *, user_id: str, session_id: str | None) -> str:
        return session_id or f"miniapp-{user_id}"

    def _recover_fallback_history(
        self,
        *,
        user_id: str,
        session_id: str | None,
        conversation_history: list[dict[str, Any]] | None,
    ) -> list[dict[str, str]]:
        normalized = self._normalize_conversation_history(conversation_history)
        if normalized:
            return list(normalized)

        effective_session_id = self._persistent_session_id(user_id=user_id, session_id=session_id)
        runtime = self._session_manager.get_runtime(effective_session_id)
        checkpoint_history = list(getattr(runtime, "checkpoint_history", []) or [])
        return [item for item in checkpoint_history if isinstance(item, dict)]

    def _build_fallback_runtime_checkpoint(
        self,
        *,
        recovered_history: list[dict[str, str]] | None,
        message: str,
        reply: str,
    ) -> list[dict[str, str]]:
        checkpoint_history = [
            {"role": str(item.get("role") or ""), "content": str(item.get("content") or "")}
            for item in (recovered_history or [])
            if isinstance(item, dict) and str(item.get("role") or "") and str(item.get("content") or "")
        ]
        checkpoint_history.append({"role": "user", "content": message})
        checkpoint_history.append({"role": "assistant", "content": reply})
        if len(checkpoint_history) > 160:
            checkpoint_history = checkpoint_history[-160:]
        return checkpoint_history

    def runtime_status(self) -> dict[str, Any]:
        return {
            "persistent": self.persistent_stats(),
            "routing": {
                "model": self.model,
                "provider": self.provider,
                "base_url": self.base_url,
                "direct_agent_enabled": self.direct_agent_enabled,
                "persistent_sessions_enabled": self.persistent_sessions_enabled,
                "camofox_fallback_enabled": self.camofox_fallback_enabled,
                "camofox_base_url": self.camofox_base_url,
            },
            "health": self._recall_health(),
            "startup": self.startup_diagnostics(),
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

        direct_fallback_history = conversation_history
        persistent_failed = False

        if self.direct_agent_enabled and self.persistent_sessions_enabled:
            try:
                yield from self._stream_via_persistent_agent(
                    user_id=user_id,
                    message=cleaned,
                    conversation_history=conversation_history,
                    session_id=session_id,
                )
                return
            except Exception as exc:  # broad-except-policy: persistent runtime failures must fall back to non-persistent transport
                persistent_failed = True
                direct_fallback_history = self._recover_fallback_history(
                    user_id=user_id,
                    session_id=session_id,
                    conversation_history=conversation_history,
                )
                effective_session_id = self._persistent_session_id(user_id=user_id, session_id=session_id)
                self._session_manager.evict(effective_session_id)
                # Fall back to existing subprocess/CLI path when persistent runtime fails.
                logger.warning(
                    "Persistent miniapp runtime failed; falling back to non-persistent path",
                    extra={
                        "session_id": effective_session_id,
                        "user_id": user_id,
                        "error": str(exc),
                        "fallback_to": "agent" if self.direct_agent_enabled else "cli",
                        "recovered_history_turns": len(direct_fallback_history or []),
                    },
                    exc_info=True,
                )

        if self.direct_agent_enabled:
            try:
                direct_events = self._stream_via_agent(
                    user_id=user_id,
                    message=cleaned,
                    conversation_history=direct_fallback_history,
                    session_id=session_id,
                )
                for event in direct_events:
                    if (
                        persistent_failed
                        and event.get("type") == "done"
                        and not isinstance(event.get("runtime_checkpoint"), list)
                    ):
                        reply = str(event.get("reply") or "").strip()
                        if reply:
                            yield {
                                **event,
                                "runtime_checkpoint": self._build_fallback_runtime_checkpoint(
                                    recovered_history=direct_fallback_history,
                                    message=cleaned,
                                    reply=reply,
                                ),
                            }
                            continue
                    yield event
                return
            except HermesClientError:
                pass

        yield from self._stream_via_cli_progress(message=cleaned)
        return
