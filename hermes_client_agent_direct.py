from __future__ import annotations

import json
import logging
import os
import queue
import re
import subprocess
import textwrap
import threading
import time
import uuid
from collections import deque
from typing import Any, Iterator

from hermes_client_types import HermesClientError


logger = logging.getLogger(__name__)


_TOOL_PROGRESS_EMOJIS: dict[str, str] = {
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

_CAMOFOX_FALLBACK_MARKER = "[miniapp-camofox-fallback]"
_CAMOFOX_ANTIBOT_PATTERN = re.compile(
    r"(cloudflare|captcha|bot\s*detect|anti[-\s]*bot|fingerprint|access\s*denied|forbidden|challenge)"
    r"|(?:\b4(?:01|03|29)\b)",
    re.IGNORECASE,
)


class HermesClientDirectAgentMixin:
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
        had_assistant_output = False
        try:
            for event in self._stream_via_agent_once(
                user_id=user_id,
                message=message,
                conversation_history=conversation_history,
                session_id=session_id,
            ):
                if event.get("type") in {"chunk", "done"}:
                    had_assistant_output = True
                yield event
            return
        except HermesClientError as exc:
            if had_assistant_output or not self._should_retry_with_camofox(message=message, error=exc):
                raise

            logger.warning(
                "Miniapp direct-agent hit anti-bot/fingerprint failure; retrying with camofox fallback guidance",
                extra={
                    "session_id": session_id or "",
                    "user_id": user_id,
                    "error": str(exc),
                    "camofox_base_url": self.camofox_base_url,
                },
            )
            fallback_message = self._build_camofox_fallback_message(message=message, error=exc)
            yield {
                "type": "meta",
                "source": "agent",
                "fallback": "camofox",
            }
            yield from self._stream_via_agent_once(
                user_id=user_id,
                message=fallback_message,
                conversation_history=conversation_history,
                session_id=session_id,
                camofox_fallback=True,
            )

    def _should_retry_with_camofox(self, *, message: str, error: HermesClientError) -> bool:
        if not getattr(self, "camofox_fallback_enabled", False):
            return False
        if not str(getattr(self, "camofox_base_url", "")).strip():
            return False
        if _CAMOFOX_FALLBACK_MARKER in str(message or ""):
            return False
        return bool(_CAMOFOX_ANTIBOT_PATTERN.search(str(error or "")))

    def _build_camofox_fallback_message(self, *, message: str, error: HermesClientError) -> str:
        base_url = str(getattr(self, "camofox_base_url", "http://127.0.0.1:9377") or "http://127.0.0.1:9377").rstrip("/")
        return (
            f"{_CAMOFOX_FALLBACK_MARKER}\n"
            "The normal browser tool path appears blocked by anti-bot/fingerprint protections.\n"
            "Retry this task using the local camofox-browser HTTP API instead of browser_* tools.\n"
            f"Base URL: {base_url}\n"
            "Authentication: send header x-api-key: $CAMOFOX_API_KEY if configured.\n"
            "Useful endpoints: POST /tabs/open, POST /navigate, GET /snapshot, POST /act, GET /health, POST /stop.\n"
            "Use terminal/execute_code to call those endpoints and continue the user task end-to-end.\n"
            f"Previous browser failure: {str(error).strip()}\n\n"
            f"Original user request:\n{message}"
        )

    def _stream_via_agent_once(
        self,
        *,
        user_id: str,
        message: str,
        conversation_history: list[dict[str, Any]] | None = None,
        session_id: str | None = None,
        camofox_fallback: bool = False,
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
        child_env["MINI_APP_CAMOFOX_FALLBACK_ACTIVE"] = "1" if camofox_fallback else "0"
        if str(getattr(self, "camofox_base_url", "")).strip():
            child_env["CAMOFOX_BASE_URL"] = str(self.camofox_base_url).strip().rstrip("/")
        if str(getattr(self, "camofox_api_key", "")).strip():
            child_env["CAMOFOX_API_KEY"] = str(self.camofox_api_key).strip()

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

        closed_stream_ids: set[int] = set()

        def _safe_close_stream(stream: Any | None, *, stream_name: str) -> None:
            if stream is None:
                return
            stream_id = id(stream)
            if stream_id in closed_stream_ids:
                return
            closed_stream_ids.add(stream_id)
            try:
                stream.close()
            except Exception as exc:  # noqa: BLE001 - broad-except-policy: close paths must be idempotent and never mask primary direct-agent failures
                logger.debug("Hermes direct-agent %s close failed", stream_name, exc_info=exc)

        try:
            assert process.stdin is not None
            process.stdin.write(json.dumps(payload, ensure_ascii=False))
            _safe_close_stream(process.stdin, stream_name="stdin")
        except OSError as exc:
            process.kill()
            _safe_close_stream(process.stdin, stream_name="stdin")
            raise HermesClientError(f"Failed to send payload to Hermes direct agent: {exc}") from exc

        stream_queue: queue.Queue[dict[str, Any]] = queue.Queue()
        stdout_done = threading.Event()
        stderr_done = threading.Event()
        stderr_lines: deque[str] = deque(maxlen=200)
        started = time.monotonic()

        def _build_timeout_message() -> str:
            timeout_message = f"Hermes direct agent timed out after {self.timeout_seconds}s."
            if stderr_lines:
                tail = stderr_lines[-1]
                if len(tail) > 300:
                    tail = tail[:297] + "..."
                timeout_message += f" stderr: {tail}"
            return timeout_message

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
            except Exception as exc:  # noqa: BLE001 - broad-except-policy: intentional-no-log reader must surface failures through stream_queue
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
            except Exception as exc:  # noqa: BLE001 - broad-except-policy: stderr capture is best-effort and should not break stream handling
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
                    tool_name = str(item.get("tool_name") or "")
                    preview = item.get("preview")
                    args = item.get("args") if isinstance(item.get("args"), dict) else {}
                    yield {
                        "type": "tool",
                        "tool_name": tool_name,
                        "preview": preview,
                        "args": args,
                        "display": self._format_tool_progress(tool_name, preview=preview, args=args),
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
            _safe_close_stream(process.stdin, stream_name="stdin")
            if process.poll() is None:
                process.kill()
                try:
                    process.wait(timeout=1)
                except Exception:  # noqa: BLE001 - broad-except-policy: intentional-no-log teardown wait failures are non-fatal after kill
                    pass
            _safe_close_stream(process.stdout, stream_name="stdout")
            _safe_close_stream(process.stderr, stream_name="stderr")

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
        emoji = _TOOL_PROGRESS_EMOJIS.get(tool_name, "⚙️")

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
            except Exception as exc:  # noqa: BLE001 - broad-except-policy: child runner must surface unexpected failures to parent stream
                emit({'kind': 'error', 'error': str(exc)})
                raise
            """
        )
