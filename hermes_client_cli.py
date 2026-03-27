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
