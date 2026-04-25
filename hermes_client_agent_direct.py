from __future__ import annotations

import json
import logging
import os
import queue
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
            raise HermesClientError(f"Hermes agent returned an empty reply (source={source}).")
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
            "provider": self.provider,
            "base_url": self.base_url,
            "max_iterations": self.max_iterations,
            "tool_progress_mode": self.tool_progress_mode,
        }

        child_env = os.environ.copy()
        child_env["HOME"] = self.agent_home
        child_env["HERMES_HOME"] = self.agent_hermes_home
        child_env["VIRTUAL_ENV"] = self.agent_venv
        child_env["PATH"] = f"{self.agent_venv}/bin:{child_env.get('PATH', '')}"

        command = [self.agent_python, "-u", "-c", self._agent_runner_script()]
        self.assert_child_spawn_allowed(transport="agent-direct", session_id=str(payload.get("session_id") or ""))
        try:
            process = subprocess.Popen(
                command,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                env=child_env,
                cwd=self.agent_workdir,
            )
        except OSError as exc:
            raise HermesClientError(f"Failed to start Hermes direct agent: {exc}") from exc

        child_pid = int(getattr(process, "pid", 0) or 0)
        if child_pid <= 0:
            child_pid = id(process)

        try:
            self.register_child_spawn(
                transport="agent-direct",
                pid=child_pid,
                command=command,
                session_id=payload.get("session_id"),
            )
        except HermesClientError:
            process.kill()
            try:
                process.wait(timeout=1)
            except Exception:  # noqa: BLE001 - broad-except-policy: intentional-no-log direct-agent teardown must never mask the primary failure
                pass
            for stream in (process.stdin, process.stdout, process.stderr):
                try:
                    if stream is not None:
                        stream.close()
                except Exception:  # noqa: BLE001 - broad-except-policy: intentional-no-log direct-agent teardown must never mask the primary failure
                    pass
            raise

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
        last_event_at = started
        first_progress_seen = False
        initial_progress_grace_seconds = max(float(self.timeout_seconds), 5.0)

        def _build_timeout_message() -> str:
            idle_for = max(0.0, time.monotonic() - last_event_at)
            message = f"Hermes direct agent timed out after {self.timeout_seconds}s with no progress."
            message += f" idle_for={idle_for:.1f}s"
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

        spawn_outcome = "unknown"
        final_return_code: int | None = None

        try:
            yield {"type": "meta", "source": "agent"}

            while True:
                elapsed_since_progress = time.monotonic() - last_event_at
                timeout_budget = float(self.timeout_seconds)
                if not first_progress_seen:
                    timeout_budget = max(timeout_budget, initial_progress_grace_seconds)
                if elapsed_since_progress > timeout_budget:
                    spawn_outcome = "timeout_kill"
                    process.kill()
                    raise HermesClientError(_build_timeout_message())

                try:
                    item = stream_queue.get(timeout=0.2)
                except queue.Empty:
                    if stdout_done.is_set() and process.poll() is not None:
                        break
                    continue

                last_event_at = time.monotonic()
                first_progress_seen = True
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
                    spawn_outcome = "stream_error"
                    raise HermesClientError(str(item.get("error") or "Hermes agent run failed."))

            remaining = max(0.1, float(self.timeout_seconds) - (time.monotonic() - last_event_at))
            try:
                return_code = process.wait(timeout=remaining)
                final_return_code = int(return_code)
            except subprocess.TimeoutExpired as exc:
                spawn_outcome = "wait_timeout_kill"
                process.kill()
                raise HermesClientError(_build_timeout_message()) from exc

            if process.stderr is not None and not stderr_done.is_set():
                stderr_done.wait(timeout=0.2)
            stderr = "\n".join(stderr_lines).strip()
            if return_code != 0 and stderr:
                spawn_outcome = "nonzero_exit"
                raise HermesClientError(stderr)
            if return_code != 0:
                spawn_outcome = "nonzero_exit"
                raise HermesClientError(f"Hermes direct agent exited with status {return_code}.")
            spawn_outcome = "completed"
        finally:
            _safe_close_stream(process.stdin, stream_name="stdin")
            if process.poll() is None:
                spawn_outcome = "cleanup_kill" if spawn_outcome == "unknown" else spawn_outcome
                process.kill()
                try:
                    process.wait(timeout=1)
                except Exception:  # noqa: BLE001 - broad-except-policy: intentional-no-log direct-agent teardown must never mask the primary failure  # noqa: BLE001 - broad-except-policy: intentional-no-log teardown wait failures are non-fatal after kill
                    pass
            polled_return_code = process.poll()
            if final_return_code is None and isinstance(polled_return_code, int):
                final_return_code = int(polled_return_code)
            _safe_close_stream(process.stdout, stream_name="stdout")
            _safe_close_stream(process.stderr, stream_name="stderr")
            self.deregister_child_spawn(
                pid=child_pid,
                outcome=spawn_outcome,
                return_code=final_return_code,
            )

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
            attachment_lines: list[str] = []
            raw_attachments = message.get("attachments")
            if isinstance(raw_attachments, list):
                for attachment in raw_attachments:
                    if not isinstance(attachment, dict):
                        continue
                    filename = str(attachment.get("filename") or "attachment").strip() or "attachment"
                    kind = str(attachment.get("kind") or "file").strip() or "file"
                    content_type = str(attachment.get("content_type") or "").strip()
                    storage_path = str(attachment.get("storage_path") or "").strip()
                    preview_url = str(attachment.get("preview_url") or attachment.get("download_url") or "").strip()
                    size_bytes = attachment.get("size_bytes")
                    detail_bits = [bit for bit in (kind, content_type) if bit]
                    try:
                        parsed_size = int(size_bytes)
                    except (TypeError, ValueError):
                        parsed_size = 0
                    if parsed_size > 0:
                        detail_bits.append(f"{parsed_size} bytes")
                    attachment_lines.append(f"- {filename}" + (f" ({', '.join(detail_bits)})" if detail_bits else ""))
                    if storage_path:
                        attachment_lines.append(f"  local file path: {storage_path}")
                    elif preview_url:
                        attachment_lines.append(f"  preview url: {preview_url}")
            if attachment_lines:
                attachment_block = "Attached files:\n" + "\n".join(attachment_lines)
                content = f"{content}\n\n{attachment_block}" if content else attachment_block
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
            import contextlib
            import io
            import json
            import sys
            import time

            _protocol_stdout = getattr(sys, '__stdout__', None) or sys.stdout

            def emit(payload):
                _protocol_stdout.write(json.dumps(payload, ensure_ascii=False) + '\\n')
                _protocol_stdout.flush()

            payload = json.loads(sys.stdin.read() or '{}')
            from run_agent import AIAgent

            message = str(payload.get('message') or '').strip()
            if not message:
                emit({'kind': 'error', 'error': 'Message cannot be empty.'})
                raise SystemExit(1)

            tool_progress_mode = str(payload.get('tool_progress_mode') or 'all').strip().lower()
            last_tool = {'name': None}
            started = time.perf_counter()

            def progress_callback(*callback_args):
                if tool_progress_mode == 'off':
                    return
                if not callback_args:
                    return

                event_type = 'tool.started'
                tool_name = None
                preview = None
                args = None
                if len(callback_args) >= 4 and str(callback_args[0] or '').strip():
                    event_type = str(callback_args[0] or '').strip()
                    tool_name = callback_args[1]
                    preview = callback_args[2]
                    args = callback_args[3]
                else:
                    tool_name = callback_args[0]
                    preview = callback_args[1] if len(callback_args) >= 2 else None
                    args = callback_args[2] if len(callback_args) >= 3 else None

                if event_type != 'tool.started':
                    return
                tool_name = str(tool_name or '').strip()
                if not tool_name:
                    return
                if tool_progress_mode == 'new' and tool_name == last_tool['name']:
                    return
                last_tool['name'] = tool_name
                emit({
                    'kind': 'tool',
                    'tool_name': tool_name,
                    'preview': preview or '',
                    'args': args if isinstance(args, dict) else {},
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
            if payload.get('provider'):
                agent_kwargs['provider'] = payload['provider']
            if payload.get('base_url'):
                agent_kwargs['base_url'] = payload['base_url']

            try:
                agent = AIAgent(**agent_kwargs)
                with contextlib.redirect_stdout(io.StringIO()):
                    result = agent.run_conversation(
                        message,
                        conversation_history=payload.get('conversation_history') or [],
                        task_id=payload.get('session_id') or 'miniapp-agent',
                    )
                reply = str(result.get('final_response') or '').strip()
                if not reply:
                    emit({'kind': 'error', 'error': str(result.get('error') or 'Hermes agent returned an empty reply (source=agent).')})
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
