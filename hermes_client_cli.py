from __future__ import annotations

import os
import re
import subprocess
from typing import Any, Iterator, TextIO

from hermes_client_types import HermesClientError


class HermesClientCLIMixin:
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

    def _iter_cli_stdout_lines(self, stdout: TextIO | Any) -> Iterator[str]:
        read_fn = getattr(stdout, "read", None)
        if callable(read_fn):
            buffer = ""
            while True:
                chunk = read_fn(1)
                if chunk == "":
                    break
                if chunk in {"\n", "\r"}:
                    if buffer:
                        yield buffer
                        buffer = ""
                    continue
                buffer += chunk
            if buffer:
                yield buffer
            return

        iterator = getattr(stdout, "__iter__", None)
        if not callable(iterator):
            raise HermesClientError("Hermes CLI stream failed: stdout is not readable.")

        for raw_line in stdout:
            if raw_line is None:
                continue
            line = str(raw_line)
            normalized = line.replace("\r\n", "\n").replace("\r", "\n")
            for segment in normalized.split("\n"):
                if segment:
                    yield segment

    def _is_cli_frame_line(self, line: str) -> bool:
        stripped = str(line or "").strip()
        if not stripped:
            return False
        return bool(re.fullmatch(r"[╭╮╰╯│┊├┤┌┐└┘─┄━\s]+", stripped))

    def _stream_via_cli_progress(self, message: str, *, session_id: str | None = None) -> Iterator[dict[str, Any]]:
        command = [self.cli_command, "chat", "--query", message]
        if self.model:
            command.extend(["--model", self.model])

        self.assert_child_spawn_allowed(transport="cli-stream", session_id=session_id)

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

        child_pid = int(getattr(process, "pid", 0) or 0)
        if child_pid <= 0:
            child_pid = id(process)

        try:
            self.register_child_spawn(
                transport="cli-stream",
                pid=child_pid,
                command=command,
                session_id=session_id,
            )
        except HermesClientError:
            process.kill()
            try:
                process.wait(timeout=1)
            except Exception:
                pass
            raise

        spawn_outcome = "unknown"
        final_return_code: int | None = None
        try:
            yield {"type": "meta", "source": "cli"}

            assert process.stdout is not None
            in_query_section = False
            in_reply = False
            reply_lines: list[str] = []
            last_tool_line = ""
            for raw_line in self._iter_cli_stdout_lines(process.stdout):
                line = raw_line.strip()
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
                    if self._is_cli_frame_line(line):
                        continue
                    reply_lines.append(line)
                    continue
                if any(symbol in line for symbol in ("🔎", "💻", "⚙️", "🌐", "📖", "✍️", "🔧", "👁️", "📄", "📋", "🧠", "⌨️", "🚪")):
                    normalized_line = self._normalize_cli_tool_line(line)
                    if normalized_line and normalized_line != last_tool_line:
                        last_tool_line = normalized_line
                        yield {"type": "tool", "display": normalized_line}

            return_code = process.wait(timeout=self.timeout_seconds)
            final_return_code = int(return_code)
            if return_code != 0:
                spawn_outcome = "nonzero_exit"
                raise HermesClientError("Hermes CLI stream failed.")

            reply = "\n".join(line for line in reply_lines if line).strip()
            if not reply:
                spawn_outcome = "empty_reply"
                raise HermesClientError("Hermes CLI stream returned an empty reply.")

            chunk_size = max(1, self.stream_chunk_size)
            for index in range(0, len(reply), chunk_size):
                yield {"type": "chunk", "text": reply[index : index + chunk_size]}
            spawn_outcome = "completed"
            yield {"type": "done", "reply": reply, "source": "cli"}
        except subprocess.TimeoutExpired as exc:
            spawn_outcome = "timeout_kill"
            process.kill()
            raise HermesClientError(f"Hermes CLI stream timed out after {self.timeout_seconds}s.") from exc
        finally:
            if process.poll() is None:
                spawn_outcome = "cleanup_kill" if spawn_outcome == "unknown" else spawn_outcome
                process.kill()
                try:
                    process.wait(timeout=1)
                except Exception:
                    pass
            polled_return_code = process.poll()
            if final_return_code is None and isinstance(polled_return_code, int):
                final_return_code = int(polled_return_code)
            self.deregister_child_spawn(
                pid=child_pid,
                outcome=spawn_outcome,
                return_code=final_return_code,
            )

    def _ask_via_cli(self, message: str) -> tuple[str, str]:
        command = [self.cli_command, "chat", "--quiet", "--query", message]
        if self.model:
            command.extend(["--model", self.model])

        self.assert_child_spawn_allowed(transport="cli-quiet")

        try:
            process = subprocess.Popen(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                env=self._cli_env(),
                cwd=os.getcwd(),
            )
        except OSError as exc:
            raise HermesClientError(f"Hermes CLI call failed: {exc}") from exc

        child_pid = int(getattr(process, "pid", 0) or 0)
        if child_pid <= 0:
            child_pid = id(process)

        try:
            self.register_child_spawn(
                transport="cli-quiet",
                pid=child_pid,
                command=command,
            )
        except HermesClientError:
            process.kill()
            try:
                process.wait(timeout=1)
            except Exception:
                pass
            raise

        spawn_outcome = "unknown"
        final_return_code: int | None = None
        try:
            try:
                communicate = getattr(process, "communicate", None)
                if callable(communicate):
                    stdout_text, stderr_text = communicate(timeout=self.timeout_seconds)
                else:
                    wait_fn = getattr(process, "wait", None)
                    if callable(wait_fn):
                        wait_fn(timeout=self.timeout_seconds)
                    stdout_text = ""
                    if process.stdout is not None:
                        read_stdout = getattr(process.stdout, "read", None)
                        if callable(read_stdout):
                            stdout_text = str(read_stdout() or "")
                    stderr_text = ""
                    if process.stderr is not None:
                        read_stderr = getattr(process.stderr, "read", None)
                        if callable(read_stderr):
                            stderr_text = str(read_stderr() or "")
            except subprocess.TimeoutExpired as exc:
                spawn_outcome = "timeout_kill"
                process.kill()
                raise HermesClientError(f"Hermes CLI call timed out after {self.timeout_seconds}s.") from exc

            final_return_code = int(process.returncode or 0)
            if final_return_code != 0:
                spawn_outcome = "nonzero_exit"
                stderr = str(stderr_text or "").strip() or "Unknown Hermes CLI error."
                raise HermesClientError(stderr)

            reply_text = str(stdout_text or "").strip()
            if not reply_text:
                spawn_outcome = "empty_reply"
                raise HermesClientError("Hermes CLI returned an empty reply.")
            spawn_outcome = "completed"
            return reply_text, "cli"
        finally:
            if process.poll() is None:
                spawn_outcome = "cleanup_kill" if spawn_outcome == "unknown" else spawn_outcome
                process.kill()
                try:
                    process.wait(timeout=1)
                except Exception:
                    pass
            polled_return_code = process.poll()
            if final_return_code is None and isinstance(polled_return_code, int):
                final_return_code = int(polled_return_code)
            self.deregister_child_spawn(
                pid=child_pid,
                outcome=spawn_outcome,
                return_code=final_return_code,
            )
