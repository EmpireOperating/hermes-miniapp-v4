from __future__ import annotations

import importlib
import json
import logging
import os
import queue
import sys
import subprocess
import textwrap
import threading
import time
import uuid
from collections import deque
from typing import Any, Iterator

from hermes_client_types import HermesClientError


logger = logging.getLogger(__name__)


class HermesClientAgentMixin:
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

        stream_queue: queue.Queue[dict[str, Any]] = queue.Queue()
        stdout_done = threading.Event()
        stderr_done = threading.Event()
        stderr_lines: deque[str] = deque(maxlen=200)
        started = time.monotonic()

        def _build_timeout_message() -> str:
            message = f"Hermes direct agent timed out after {self.timeout_seconds}s."
            if stderr_lines:
                tail = stderr_lines[-1]
                if len(tail) > 300:
                    tail = tail[:297] + "..."
                message += f" stderr: {tail}"
            return message

        def _stdout_reader() -> None:
            try:
                assert process.stdout is not None
                for raw_line in process.stdout:
                    line = raw_line.strip()
                    if not line:
                        continue
                    try:
                        item = json.loads(line)
                    except json.JSONDecodeError:
                        logger.debug("Skipping non-JSON direct-agent stdout line: %s", line[:200])
                        continue
                    stream_queue.put(item)
            except Exception as exc:  # noqa: BLE001
                stream_queue.put({"kind": "error", "error": f"Hermes agent stream read failed: {exc}"})
            finally:
                stdout_done.set()

        def _stderr_reader() -> None:
            try:
                if process.stderr is None:
                    return
                for raw_line in process.stderr:
                    line = raw_line.strip()
                    if line:
                        stderr_lines.append(line)
            except Exception as exc:  # noqa: BLE001
                logger.debug("Hermes direct-agent stderr capture failed: %s", exc)
            finally:
                stderr_done.set()

        threading.Thread(target=_stdout_reader, name="miniapp-direct-agent-stdout", daemon=True).start()
        threading.Thread(target=_stderr_reader, name="miniapp-direct-agent-stderr", daemon=True).start()

        try:
            yield {"type": "meta", "source": "agent"}

            while True:
                if (time.monotonic() - started) > float(self.timeout_seconds):
                    process.kill()
                    raise HermesClientError(_build_timeout_message())

                try:
                    item = stream_queue.get(timeout=0.2)
                except queue.Empty:
                    if stdout_done.is_set() and process.poll() is not None:
                        break
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

            remaining = max(0.1, float(self.timeout_seconds) - (time.monotonic() - started))
            try:
                return_code = process.wait(timeout=remaining)
            except subprocess.TimeoutExpired as exc:
                process.kill()
                raise HermesClientError(_build_timeout_message()) from exc

            if process.stderr is not None and not stderr_done.is_set():
                stderr_done.wait(timeout=0.2)
            stderr = "\n".join(stderr_lines).strip()
            if return_code != 0 and stderr:
                raise HermesClientError(stderr)
            if return_code != 0:
                raise HermesClientError(f"Hermes direct agent exited with status {return_code}.")
        finally:
            if process.poll() is None:
                process.kill()
                try:
                    process.wait(timeout=1)
                except Exception:  # noqa: BLE001
                    pass

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
