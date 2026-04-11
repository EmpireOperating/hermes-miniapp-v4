from __future__ import annotations

import json
import logging
import os
import queue
import signal
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Protocol, TYPE_CHECKING

import chat_worker_runner

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
class _SubprocessStreamState:
    saw_error_event: bool = False
    timed_out: bool = False
    detached_warm_worker: bool = False
    saw_attach_ready: bool = False
    saw_post_run_attach_ready: bool = False
    saw_done_event: bool = False
    saw_worker_terminal_success: bool = False
    reply_chunks: list[str] = field(default_factory=list)
    last_done_payload: dict[str, object] | None = None
    return_code: int | None = None
    stderr_excerpt: str | None = None
    failure_kind: str | None = None
    terminal_outcome: str | None = None
    terminal_error: str | None = None


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

    def describe(self) -> dict[str, object]:
        return {
            "name": self.name,
            "isolation": "process",
            "mode": "subprocess-stream",
            "script": str(self.script_path),
            "python": self.python_executable,
            "timeout_seconds": float(self.timeout_seconds),
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
        }

    def _stderr_excerpt_suffix(self, stderr_excerpt: str | None) -> str:
        excerpt = str(stderr_excerpt or "").strip()
        if not excerpt:
            return ""
        if len(excerpt) > 280:
            excerpt = excerpt[:277] + "..."
        return f" stderr: {excerpt}"

    def _subprocess_timeout_message(self, *, stderr_excerpt: str | None = None) -> str:
        return (
            f"Subprocess worker timed out after {self.timeout_seconds:.1f}s"
            f"{self._stderr_excerpt_suffix(stderr_excerpt)}"
        )

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
        self._last_terminal_outcome = None
        self._last_terminal_error = None
        self._last_limit_breach = None
        self._last_limit_breach_detail = None

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

    def _stdout_line_queue(self, proc: subprocess.Popen[str]) -> queue.Queue[str | None]:
        line_queue: queue.Queue[str | None] = queue.Queue()

        def _reader() -> None:
            try:
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

    def _handle_child_spawn_event(
        self,
        runtime: "JobRuntime",
        *,
        proc: subprocess.Popen[str],
        session_id: str,
        event: dict[str, object],
    ) -> bool:
        event_type = str(event.get("type") or "")
        if event_type == "child_spawn":
            observe_descendant_spawn = getattr(runtime.client, "observe_descendant_spawn", None)
            if callable(observe_descendant_spawn):
                observe_descendant_spawn(
                    transport=str(event.get("transport") or "unknown"),
                    pid=int(event.get("pid") or 0),
                    command=list(event.get("command") or []),
                    session_id=str(event.get("session_id") or session_id or ""),
                    parent_transport=self.transport,
                    parent_pid=int(proc.pid),
                )
            return True
        if event_type == "child_finish":
            observe_descendant_finish = getattr(runtime.client, "observe_descendant_finish", None)
            if callable(observe_descendant_finish):
                observe_descendant_finish(
                    pid=int(event.get("pid") or 0),
                    outcome=str(event.get("outcome") or "unknown"),
                    return_code=event.get("return_code"),
                    signal=event.get("signal"),
                    parent_transport=self.transport,
                    parent_pid=int(proc.pid),
                )
            return True
        return False

    def _handle_attach_ready_event(
        self,
        runtime: "JobRuntime",
        *,
        proc: subprocess.Popen[str],
        session_id: str,
        state: _SubprocessStreamState,
        event: dict[str, object],
    ) -> bool:
        if str(event.get("type") or "") != "attach_ready":
            return False
        if state.saw_attach_ready and (state.saw_done_event or state.saw_worker_terminal_success):
            state.saw_post_run_attach_ready = True
        state.saw_attach_ready = True
        note_attach_ready = getattr(runtime.client, "note_warm_session_worker_attach_ready", None)
        if callable(note_attach_ready):
            note_attach_ready(
                session_id=str(event.get("session_id") or session_id or ""),
                owner_pid=int(proc.pid),
                transport_kind=str(event.get("transport_kind") or "") or None,
                worker_endpoint=str(event.get("worker_endpoint") or "") or None,
                resume_token=str(event.get("resume_token") or "") or None,
                resume_deadline_ms=event.get("resume_deadline_ms"),
            )
        if state.saw_post_run_attach_ready:
            state.detached_warm_worker = True
            state.failure_kind = "detached_warm_worker"
            state.return_code = 0
        return True

    def _handle_worker_terminal_event(
        self,
        *,
        session_id: str,
        state: _SubprocessStreamState,
        event: dict[str, object],
    ) -> dict[str, object] | None:
        if str(event.get("type") or "") != "worker_terminal":
            return None
        state.terminal_outcome = str(event.get("outcome") or "").strip().lower() or None
        state.terminal_error = str(event.get("error") or "").strip() or None
        if state.terminal_outcome == "success" and state.saw_attach_ready:
            state.saw_worker_terminal_success = True
            if not state.saw_done_event:
                synthetic_done = {
                    "type": "done",
                    "reply": "".join(state.reply_chunks).strip(),
                    "source": "agent-persistent",
                    "latency_ms": 0,
                    "session_id": str(session_id or ""),
                    "persistent_mode": "warm-detached",
                    "warm_handoff": True,
                    "synthetic": True,
                }
                if synthetic_done.get("reply"):
                    state.saw_done_event = True
                    state.last_done_payload = dict(synthetic_done)
                    return dict(synthetic_done)
        return {}

    def _record_stream_event(self, state: _SubprocessStreamState, event: dict[str, object]) -> None:
        event_type = str(event.get("type") or "")
        if event_type == "chunk":
            chunk_text = str(event.get("text") or "")
            if chunk_text:
                state.reply_chunks.append(chunk_text)
        elif event_type == "done":
            state.saw_done_event = True
            state.last_done_payload = dict(event)
        if event_type == "error":
            state.saw_error_event = True

    def _iter_subprocess_events(
        self,
        runtime: "JobRuntime",
        *,
        proc: subprocess.Popen[str],
        session_id: str,
        state: _SubprocessStreamState,
    ) -> Iterable[dict[str, object]]:
        if proc.stdout is None:
            state.saw_error_event = True
            state.failure_kind = "stdout_missing"
            yield {"type": "error", "error": "Subprocess worker produced no stdout stream."}
            return

        line_queue = self._stdout_line_queue(proc)
        inactivity_timeout_seconds = max(1.0, float(self.timeout_seconds))
        last_progress_at = time.monotonic()
        while True:
            now = time.monotonic()
            idle_for = now - last_progress_at
            remaining = inactivity_timeout_seconds - idle_for
            if remaining <= 0:
                state.timed_out = True
                state.failure_kind = "timeout"
                break
            try:
                raw_line = line_queue.get(timeout=min(0.2, remaining))
            except queue.Empty:
                if proc.poll() is not None:
                    try:
                        raw_line = line_queue.get_nowait()
                    except queue.Empty:
                        break
                else:
                    continue
            if raw_line is None:
                break
            event = self._decode_subprocess_event(raw_line)
            if event is None:
                continue
            last_progress_at = time.monotonic()
            terminal_event = self._handle_worker_terminal_event(session_id=session_id, state=state, event=event)
            if terminal_event is not None:
                if terminal_event:
                    yield terminal_event
                continue
            if self._handle_child_spawn_event(runtime, proc=proc, session_id=session_id, event=event):
                continue
            if self._handle_attach_ready_event(runtime, proc=proc, session_id=session_id, state=state, event=event):
                if state.detached_warm_worker:
                    break
                continue
            self._record_stream_event(state, event)
            yield event

    def _emit_timeout_error(
        self,
        *,
        proc: subprocess.Popen[str],
        stderr_file,
        state: _SubprocessStreamState,
    ) -> dict[str, object] | None:
        if not state.timed_out:
            return None
        try:
            _signal_process_tree(proc, signal.SIGTERM)
        except Exception:
            LOGGER.debug("subprocess_worker_terminate_failed", exc_info=True)
        state.stderr_excerpt = _read_stderr_excerpt(stderr_file, self.stderr_excerpt_bytes)
        if state.saw_error_event:
            return None
        state.saw_error_event = True
        return {
            "type": "error",
            "error": self._subprocess_timeout_message(stderr_excerpt=state.stderr_excerpt),
        }

    def _wait_for_subprocess_exit(self, proc: subprocess.Popen[str], *, state: _SubprocessStreamState) -> None:
        if state.detached_warm_worker:
            return
        try:
            state.return_code = int(proc.wait(timeout=max(0.1, float(self.kill_grace_seconds))))
        except subprocess.TimeoutExpired:
            state.timed_out = True
            state.failure_kind = state.failure_kind or "kill_timeout"
            try:
                _signal_process_tree(proc, signal.SIGKILL)
            except Exception:
                LOGGER.debug("subprocess_worker_kill_failed", exc_info=True)
            try:
                state.return_code = int(proc.wait(timeout=1.0))
            except Exception:
                state.return_code = proc.returncode if isinstance(proc.returncode, int) else None
        except Exception:
            state.return_code = proc.returncode if isinstance(proc.returncode, int) else None

    def _emit_nonzero_exit_error(self, state: _SubprocessStreamState) -> dict[str, object] | None:
        if (
            state.detached_warm_worker
            or state.return_code in (0, None)
            or state.saw_error_event
            or state.saw_done_event
        ):
            return None
        state.failure_kind = state.failure_kind or "nonzero_exit"
        return {
            "type": "error",
            "error": self._subprocess_exit_message(return_code=state.return_code, stderr_excerpt=state.stderr_excerpt),
        }

    def _finalize_subprocess_stream(
        self,
        *,
        proc: subprocess.Popen[str],
        stderr_file,
        state: _SubprocessStreamState,
        deregister_child_spawn,
    ) -> None:
        if proc.poll() is None and not state.detached_warm_worker:
            try:
                _signal_process_tree(proc, signal.SIGKILL)
            except Exception:
                LOGGER.debug("subprocess_worker_kill_failed_finally", exc_info=True)
            try:
                proc.wait(timeout=1)
            except Exception:
                LOGGER.debug("subprocess_worker_wait_after_kill_failed", exc_info=True)

        if state.stderr_excerpt is None:
            state.stderr_excerpt = _read_stderr_excerpt(stderr_file, self.stderr_excerpt_bytes)
        stderr_file.close()

        if state.return_code is None and isinstance(proc.returncode, int):
            state.return_code = proc.returncode
        if state.failure_kind is None:
            if state.timed_out:
                state.failure_kind = "timeout"
            elif state.return_code == 0:
                state.failure_kind = "completed"
            else:
                state.failure_kind = "failed"
        self._last_failure_kind = state.failure_kind
        self._last_return_code = state.return_code
        self._last_stderr_excerpt = state.stderr_excerpt
        limit_breach, limit_detail = _classify_limit_breach(
            failure_kind=state.failure_kind,
            return_code=state.return_code,
            stderr_excerpt=state.stderr_excerpt,
            timed_out=state.timed_out,
        )
        self._last_limit_breach = limit_breach
        self._last_limit_breach_detail = limit_detail

        if state.terminal_outcome is None:
            if state.timed_out:
                state.terminal_outcome = "timeout_killed"
            elif (state.return_code == 0 or state.saw_done_event) and not state.saw_error_event:
                state.terminal_outcome = "success"
            else:
                state.terminal_outcome = "retryable_failure"
        if state.terminal_error is None and state.timed_out:
            state.terminal_error = self._subprocess_timeout_message(stderr_excerpt=state.stderr_excerpt)
        if state.terminal_error is None and state.return_code not in (0, None) and not (state.saw_done_event and not state.saw_error_event):
            state.terminal_error = self._subprocess_exit_message(return_code=state.return_code, stderr_excerpt=state.stderr_excerpt)

        self._last_terminal_outcome = state.terminal_outcome
        self._last_terminal_error = state.terminal_error

        if callable(deregister_child_spawn):
            try:
                if state.detached_warm_worker:
                    outcome = "detached_warm_worker"
                else:
                    outcome = "completed" if state.return_code == 0 and not state.timed_out else f"failed:{state.failure_kind}"
                deregister_child_spawn(
                    pid=int(proc.pid),
                    outcome=f"{self.transport}:{outcome}",
                    return_code=state.return_code,
                )
            except Exception:
                LOGGER.debug("subprocess_worker_deregister_failed", exc_info=True)

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

        state = _SubprocessStreamState()
        try:
            payload_error = self._write_payload(proc, payload)
            if payload_error:
                state.saw_error_event = True
                state.failure_kind = "stdin_write_failed"
                state.terminal_outcome = "retryable_failure"
                state.terminal_error = payload_error
                yield {"type": "error", "error": payload_error}
                return

            for event in self._iter_subprocess_events(runtime, proc=proc, session_id=session_id, state=state):
                yield event

            timeout_event = self._emit_timeout_error(proc=proc, stderr_file=stderr_file, state=state)
            if timeout_event is not None:
                yield timeout_event

            self._wait_for_subprocess_exit(proc, state=state)
            if state.stderr_excerpt is None:
                state.stderr_excerpt = _read_stderr_excerpt(stderr_file, self.stderr_excerpt_bytes)

            if state.saw_done_event and not state.saw_error_event and not state.detached_warm_worker:
                state.failure_kind = state.failure_kind or "completed"
                state.terminal_outcome = state.terminal_outcome or "success"
                state.terminal_error = None

            nonzero_exit_event = self._emit_nonzero_exit_error(state)
            if nonzero_exit_event is not None:
                yield nonzero_exit_event
        finally:
            self._finalize_subprocess_stream(
                proc=proc,
                stderr_file=stderr_file,
                state=state,
                deregister_child_spawn=deregister_child_spawn,
            )


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
