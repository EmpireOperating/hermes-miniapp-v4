from __future__ import annotations

import json
import logging
import os
import signal
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Protocol, TYPE_CHECKING

import chat_worker_runner
from job_runtime_worker_launcher_subprocess import SubprocessStreamLifecycle, SubprocessStreamState

if TYPE_CHECKING:
    from job_runtime import JobRuntime


LOGGER = logging.getLogger(__name__)


class JobWorkerLauncher(Protocol):
    def launch(
        self,
        *,
        runtime: "JobRuntime",
        job: dict[str, object],
        retryable_error_cls: type[Exception],
        non_retryable_error_cls: type[Exception],
        client_error_cls: type[Exception],
    ) -> None:
        ...

    def describe(self) -> dict[str, object]:
        ...


@dataclass(slots=True)
class InlineJobWorkerLauncher:
    """Behavior-preserving in-process launcher for chat jobs."""

    name: str = "inline"

    def launch(
        self,
        *,
        runtime: "JobRuntime",
        job: dict[str, object],
        retryable_error_cls: type[Exception],
        non_retryable_error_cls: type[Exception],
        client_error_cls: type[Exception],
    ) -> None:
        chat_worker_runner.run_chat_worker_job(
            runtime,
            job,
            retryable_error_cls=retryable_error_cls,
            non_retryable_error_cls=non_retryable_error_cls,
            client_error_cls=client_error_cls,
        )

    def describe(self) -> dict[str, object]:
        return {"name": self.name, "isolation": "none", "mode": "in-process"}


@dataclass(slots=True)
class SubprocessJobWorkerLauncher:
    """Experimental process-isolated launcher for chat execution stream path.

    Parent runtime continues owning DB writes/event publication. Only the heavy
    stream_events call runs in the child process.
    """

    name: str = "subprocess"
    python_executable: str = sys.executable
    script_path: Path = Path(__file__).resolve().with_name("chat_worker_subprocess.py")
    transport: str = "chat-worker-subprocess"
    timeout_seconds: float = 120.0
    kill_grace_seconds: float = 1.5
    stderr_excerpt_bytes: int = 4096
    memory_limit_mb: int = 1024
    max_tasks: int = 64
    max_open_files: int = 256
    _last_failure_kind: str | None = None
    _last_return_code: int | None = None
    _last_stderr_excerpt: str | None = None
    _last_terminal_outcome: str | None = None
    _last_terminal_error: str | None = None
    _last_limit_breach: str | None = None
    _last_limit_breach_detail: str | None = None
    _last_child_pid: int | None = None

    def describe(self) -> dict[str, object]:
        return {
            "name": self.name,
            "isolation": "process",
            "mode": "subprocess-stream",
            "script": str(self.script_path),
            "python": self.python_executable,
            "timeout_seconds": float(self.timeout_seconds),
            "first_event_timeout_seconds": float(self._first_event_timeout_seconds()),
            "kill_grace_seconds": float(self.kill_grace_seconds),
            "limits": {
                "memory_mb": int(self.memory_limit_mb),
                "max_tasks": int(self.max_tasks),
                "max_open_files": int(self.max_open_files),
            },
            "last_failure_kind": self._last_failure_kind,
            "last_return_code": self._last_return_code,
            "last_stderr_excerpt": self._last_stderr_excerpt,
            "last_terminal_outcome": self._last_terminal_outcome,
            "last_terminal_error": self._last_terminal_error,
            "last_limit_breach": self._last_limit_breach,
            "last_limit_breach_detail": self._last_limit_breach_detail,
            "last_child_pid": self._last_child_pid,
            "transport": self.transport,
        }

    def _stderr_excerpt_suffix(self, stderr_excerpt: str | None) -> str:
        excerpt = str(stderr_excerpt or "").strip()
        if not excerpt:
            return ""
        if len(excerpt) > 280:
            excerpt = excerpt[:277] + "..."
        return f" stderr: {excerpt}"

    def _subprocess_timeout_message(self, *, stderr_excerpt: str | None = None) -> str:
        return self._subprocess_timeout_message_for_phase(
            first_event=False,
            stderr_excerpt=stderr_excerpt,
        )

    def _subprocess_timeout_message_for_phase(
        self,
        *,
        first_event: bool,
        stderr_excerpt: str | None = None,
    ) -> str:
        if first_event:
            return (
                f"Subprocess worker produced no first event within {self._first_event_timeout_seconds():.1f}s"
                f"{self._stderr_excerpt_suffix(stderr_excerpt)}"
            )
        return (
            f"Subprocess worker timed out after {self.timeout_seconds:.1f}s"
            f"{self._stderr_excerpt_suffix(stderr_excerpt)}"
        )

    def _first_event_timeout_seconds(self) -> float:
        return max(1.0, min(30.0, float(self.timeout_seconds) / 4.0))

    def _subprocess_exit_message(self, *, return_code: int | None, stderr_excerpt: str | None = None) -> str:
        base = f"Subprocess worker exited rc={return_code}"
        return f"{base}{self._stderr_excerpt_suffix(stderr_excerpt)}"

    def launch(
        self,
        *,
        runtime: "JobRuntime",
        job: dict[str, object],
        retryable_error_cls: type[Exception],
        non_retryable_error_cls: type[Exception],
        client_error_cls: type[Exception],
    ) -> None:
        self._last_failure_kind = None
        self._last_return_code = None
        self._last_stderr_excerpt = None
        self._last_terminal_outcome = None
        self._last_terminal_error = None
        self._last_limit_breach = None
        self._last_limit_breach_detail = None
        self._last_child_pid = None

        try:
            chat_worker_runner.run_chat_worker_job(
                runtime,
                job,
                retryable_error_cls=retryable_error_cls,
                non_retryable_error_cls=non_retryable_error_cls,
                client_error_cls=client_error_cls,
                stream_events_fn=lambda **kwargs: self._stream_events_via_subprocess(runtime=runtime, **kwargs),
            )
        except retryable_error_cls as exc:
            outcome = str(self._last_terminal_outcome or "").strip().lower()
            message = str(self._last_terminal_error or str(exc) or "Subprocess worker failed.").strip()
            if outcome == "non_retryable_failure":
                raise non_retryable_error_cls(message) from exc
            if outcome == "timeout_killed":
                raise retryable_error_cls(message) from exc
            raise

        outcome = str(self._last_terminal_outcome or "").strip().lower()
        if not outcome or outcome == "success":
            return

        message = str(self._last_terminal_error or "Subprocess worker reported a terminal outcome.").strip()
        if outcome == "non_retryable_failure":
            raise non_retryable_error_cls(message)
        if outcome in {"retryable_failure", "timeout_killed"}:
            raise retryable_error_cls(message)
        raise retryable_error_cls(f"Unknown subprocess terminal outcome: {outcome}. {message}")

    def _subprocess_lifecycle(self) -> SubprocessStreamLifecycle:
        return SubprocessStreamLifecycle(
            transport=self.transport,
            timeout_seconds=float(self.timeout_seconds),
            first_event_timeout_seconds=float(self._first_event_timeout_seconds()),
            kill_grace_seconds=float(self.kill_grace_seconds),
            stderr_excerpt_bytes=int(self.stderr_excerpt_bytes),
            decode_event=self._decode_subprocess_event,
            stdout_line_queue=self._stdout_line_queue,
            read_stderr_excerpt=_read_stderr_excerpt,
            signal_process_tree=_signal_process_tree,
            classify_limit_breach=_classify_limit_breach,
            build_timeout_message=self._subprocess_timeout_message_for_phase,
            build_exit_message=self._subprocess_exit_message,
            monotonic_now=time.monotonic,
        )

    def _build_stream_payload(
        self,
        *,
        user_id: str,
        message: str,
        conversation_history: list[dict[str, object]],
        session_id: str,
    ) -> dict[str, object]:
        return {
            "user_id": str(user_id),
            "message": str(message),
            "conversation_history": list(conversation_history or []),
            "session_id": str(session_id),
        }

    def _apply_spawn_blocked_error(self, message: str) -> dict[str, object]:
        self._last_failure_kind = "spawn_blocked"
        self._last_return_code = None
        self._last_stderr_excerpt = None
        self._last_terminal_outcome = "retryable_failure"
        self._last_terminal_error = message
        return {"type": "error", "error": message}

    def _missing_script_event(self) -> dict[str, object]:
        message = f"Subprocess worker script missing: {self.script_path}"
        self._last_failure_kind = "missing_script"
        self._last_return_code = None
        self._last_stderr_excerpt = None
        self._last_terminal_outcome = "retryable_failure"
        self._last_terminal_error = message
        return {"type": "error", "error": message}

    def _child_env(self) -> dict[str, str]:
        child_env = os.environ.copy()
        child_env["MINI_APP_JOB_WORKER_LAUNCHER"] = "inline"
        child_env["MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP"] = "shared"
        child_env["MINI_APP_PERSISTENT_SESSIONS"] = "1"
        child_env.setdefault("MINI_APP_SUBPROCESS_WARM_ATTACH", "0")
        return child_env

    def _assert_spawn_allowed(self, runtime: "JobRuntime", *, session_id: str) -> str | None:
        assert_child_spawn_allowed = getattr(runtime.client, "assert_child_spawn_allowed", None)
        if not callable(assert_child_spawn_allowed):
            return None
        try:
            assert_child_spawn_allowed(transport=self.transport, session_id=session_id)
        except Exception as exc:
            return str(exc).strip() or "Subprocess worker launch blocked by child spawn cap."
        return None

    def _spawn_subprocess(self, command: list[str], *, child_env: dict[str, str]) -> tuple[subprocess.Popen[str], Any]:
        preexec_fn = _build_subprocess_preexec(
            memory_limit_mb=int(self.memory_limit_mb),
            max_tasks=int(self.max_tasks),
            max_open_files=int(self.max_open_files),
        )
        stderr_file = tempfile.TemporaryFile(mode="w+t", encoding="utf-8")
        proc = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=stderr_file,
            text=True,
            cwd=str(self.script_path.parent),
            preexec_fn=preexec_fn,
            env=child_env,
        )
        return proc, stderr_file

    def _register_spawn(
        self,
        runtime: "JobRuntime",
        *,
        proc: subprocess.Popen[str],
        command: list[str],
        session_id: str,
    ) -> str | None:
        register_child_spawn = getattr(runtime.client, "register_child_spawn", None)
        if not callable(register_child_spawn):
            return None
        self._last_child_pid = int(proc.pid)
        try:
            register_child_spawn(
                transport=self.transport,
                pid=int(proc.pid),
                command=command,
                session_id=session_id,
            )
        except Exception as exc:
            return str(exc).strip() or "Subprocess worker launch could not be registered."
        return None

    def _write_payload(self, proc: subprocess.Popen[str], payload: dict[str, object]) -> str | None:
        if proc.stdin is None:
            return None
        try:
            proc.stdin.write(json.dumps(payload, separators=(",", ":")))
            proc.stdin.close()
        except (BrokenPipeError, OSError) as exc:
            return str(exc).strip() or "Subprocess worker exited before it could accept input."
        return None

    def _stdout_line_queue(self, proc: subprocess.Popen[str]):
        import queue
        import threading

        line_queue: queue.Queue[str | None] = queue.Queue()

        def _reader() -> None:
            try:
                assert proc.stdout is not None
                for raw_line in proc.stdout:
                    line_queue.put(raw_line)
            finally:
                line_queue.put(None)

        reader = threading.Thread(target=_reader, name="subprocess-worker-stdout-reader", daemon=True)
        reader.start()
        return line_queue

    def _decode_subprocess_event(self, raw_line: str) -> dict[str, object] | None:
        line = str(raw_line or "").strip()
        if not line:
            return None
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            LOGGER.warning("subprocess_worker_bad_json_line line=%r", line[:220])
            return None
        if not isinstance(event, dict):
            return None
        return event

    def _stream_events_via_subprocess(
        self,
        *,
        runtime: "JobRuntime",
        user_id: str,
        message: str,
        conversation_history: list[dict[str, object]],
        session_id: str,
    ) -> Iterable[dict[str, object]]:
        payload = self._build_stream_payload(
            user_id=user_id,
            message=message,
            conversation_history=conversation_history,
            session_id=session_id,
        )
        if not self.script_path.exists():
            yield self._missing_script_event()
            return

        spawn_blocked_message = self._assert_spawn_allowed(runtime, session_id=session_id)
        if spawn_blocked_message:
            yield self._apply_spawn_blocked_error(spawn_blocked_message)
            return

        command = [self.python_executable, str(self.script_path)]
        proc, stderr_file = self._spawn_subprocess(command, child_env=self._child_env())
        deregister_child_spawn = getattr(runtime.client, "deregister_child_spawn", None)
        register_error = self._register_spawn(runtime, proc=proc, command=command, session_id=session_id)
        if register_error:
            self._last_failure_kind = "register_failed"
            self._last_return_code = None
            self._last_stderr_excerpt = None
            self._last_terminal_outcome = "retryable_failure"
            self._last_terminal_error = register_error
            try:
                _signal_process_tree(proc, signal.SIGKILL)
            except Exception:
                LOGGER.debug("subprocess_worker_register_failed_kill", exc_info=True)
            yield {"type": "error", "error": register_error}
            return

        lifecycle = self._subprocess_lifecycle()
        state = SubprocessStreamState()
        try:
            payload_error = self._write_payload(proc, payload)
            if payload_error:
                state.saw_error_event = True
                state.failure_kind = "stdin_write_failed"
                state.terminal_outcome = "retryable_failure"
                state.terminal_error = payload_error
                yield {"type": "error", "error": payload_error}
                return

            for event in lifecycle.iter_events(runtime, proc=proc, session_id=session_id, state=state):
                yield event

            timeout_event = lifecycle.emit_timeout_error(proc=proc, stderr_file=stderr_file, state=state)
            if timeout_event is not None:
                yield timeout_event

            lifecycle.wait_for_exit(proc, state=state)
            if state.stderr_excerpt is None:
                state.stderr_excerpt = _read_stderr_excerpt(stderr_file, self.stderr_excerpt_bytes)

            if state.saw_done_event and not state.saw_error_event and not state.detached_warm_worker:
                state.failure_kind = state.failure_kind or "completed"
                state.terminal_outcome = state.terminal_outcome or "success"
                state.terminal_error = None

            nonzero_exit_event = lifecycle.emit_nonzero_exit_error(state)
            if nonzero_exit_event is not None:
                yield nonzero_exit_event
        finally:
            final_report = lifecycle.finalize(
                proc=proc,
                stderr_file=stderr_file,
                state=state,
                deregister_child_spawn=deregister_child_spawn,
            )
            self._last_failure_kind = str(final_report.get("failure_kind") or "") or None
            self._last_return_code = final_report.get("return_code") if isinstance(final_report.get("return_code"), int) else None
            self._last_stderr_excerpt = str(final_report.get("stderr_excerpt") or "") or None
            self._last_terminal_outcome = str(final_report.get("terminal_outcome") or "") or None
            self._last_terminal_error = str(final_report.get("terminal_error") or "") or None
            self._last_limit_breach = str(final_report.get("limit_breach") or "") or None
            self._last_limit_breach_detail = str(final_report.get("limit_breach_detail") or "") or None



def _read_stderr_excerpt(stderr_file, max_bytes: int) -> str | None:
    try:
        stderr_file.seek(0)
        content = stderr_file.read()
    except Exception:
        return None
    text = str(content or "").strip()
    if not text:
        return None
    safe_limit = max(64, int(max_bytes))
    if len(text) <= safe_limit:
        return text
    return text[-safe_limit:]


def _build_subprocess_preexec(*, memory_limit_mb: int, max_tasks: int, max_open_files: int):
    if os.name != "posix":
        return None

    def _preexec() -> None:
        import resource

        os.setsid()

        resource.setrlimit(resource.RLIMIT_AS, (_mb_to_bytes(memory_limit_mb), _mb_to_bytes(memory_limit_mb)))
        resource.setrlimit(resource.RLIMIT_NPROC, (int(max_tasks), int(max_tasks)))
        resource.setrlimit(resource.RLIMIT_NOFILE, (int(max_open_files), int(max_open_files)))

    return _preexec


def _signal_process_tree(proc: subprocess.Popen[str], sig: int) -> None:
    pid = int(getattr(proc, "pid", 0) or 0)
    if pid <= 0:
        return
    if os.name == "posix":
        try:
            pgid = os.getpgid(pid)
        except Exception:
            pgid = 0
        if pgid > 0:
            os.killpg(pgid, sig)
            return

    if sig == signal.SIGTERM:
        proc.terminate()
        return
    proc.kill()



def _mb_to_bytes(value_mb: int) -> int:
    return int(value_mb) * 1024 * 1024



def _classify_limit_breach(
    *,
    failure_kind: str | None,
    return_code: int | None,
    stderr_excerpt: str | None,
    timed_out: bool,
) -> tuple[str | None, str | None]:
    if timed_out:
        return None, None

    text = str(stderr_excerpt or "").lower()
    if "memoryerror" in text or "cannot allocate memory" in text or "out of memory" in text:
        return "memory", "stderr_oom"
    if "too many open files" in text:
        return "open_files", "stderr_emfile"
    if "resource temporarily unavailable" in text or "pthread_create" in text:
        return "tasks", "stderr_eagain"
    if failure_kind == "nonzero_exit" and isinstance(return_code, int) and return_code == -9:
        return "memory", "signal_kill_suspected_oom"
    return None, None



def build_job_worker_launcher(
    *,
    mode: str,
    python_executable: str | None = None,
    subprocess_timeout_seconds: float = 120.0,
    subprocess_kill_grace_seconds: float = 1.5,
    subprocess_stderr_excerpt_bytes: int = 4096,
    subprocess_memory_limit_mb: int = 1024,
    subprocess_max_tasks: int = 64,
    subprocess_max_open_files: int = 256,
) -> JobWorkerLauncher:
    safe_mode = str(mode or "inline").strip().lower()
    if safe_mode == "inline":
        return InlineJobWorkerLauncher()
    if safe_mode == "subprocess":
        return SubprocessJobWorkerLauncher(
            python_executable=python_executable or sys.executable,
            timeout_seconds=max(1.0, float(subprocess_timeout_seconds)),
            kill_grace_seconds=max(0.1, float(subprocess_kill_grace_seconds)),
            stderr_excerpt_bytes=max(256, int(subprocess_stderr_excerpt_bytes)),
            memory_limit_mb=max(128, int(subprocess_memory_limit_mb)),
            max_tasks=max(8, int(subprocess_max_tasks)),
            max_open_files=max(64, int(subprocess_max_open_files)),
        )
    raise ValueError(f"Unsupported MINI_APP_JOB_WORKER_LAUNCHER mode: {mode}")
