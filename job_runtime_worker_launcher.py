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
from dataclasses import dataclass
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

    def _stream_events_via_subprocess(
        self,
        *,
        runtime: "JobRuntime",
        user_id: str,
        message: str,
        conversation_history: list[dict[str, object]],
        session_id: str,
    ) -> Iterable[dict[str, object]]:
        payload = {
            "user_id": str(user_id),
            "message": str(message),
            "conversation_history": list(conversation_history or []),
            "session_id": str(session_id),
        }
        if not self.script_path.exists():
            self._last_failure_kind = "missing_script"
            self._last_return_code = None
            self._last_stderr_excerpt = None
            self._last_terminal_outcome = "retryable_failure"
            self._last_terminal_error = f"Subprocess worker script missing: {self.script_path}"
            yield {
                "type": "error",
                "error": f"Subprocess worker script missing: {self.script_path}",
            }
            return

        command = [self.python_executable, str(self.script_path)]
        child_env = os.environ.copy()
        child_env["MINI_APP_JOB_WORKER_LAUNCHER"] = "inline"
        child_env["MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP"] = "shared"
        child_env["MINI_APP_PERSISTENT_SESSIONS"] = "1"

        assert_child_spawn_allowed = getattr(runtime.client, "assert_child_spawn_allowed", None)
        if callable(assert_child_spawn_allowed):
            try:
                assert_child_spawn_allowed(transport=self.transport, session_id=session_id)
            except Exception as exc:
                message = str(exc).strip() or "Subprocess worker launch blocked by child spawn cap."
                self._last_failure_kind = "spawn_blocked"
                self._last_return_code = None
                self._last_stderr_excerpt = None
                self._last_terminal_outcome = "retryable_failure"
                self._last_terminal_error = message
                yield {"type": "error", "error": message}
                return

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

        register_child_spawn = getattr(runtime.client, "register_child_spawn", None)
        deregister_child_spawn = getattr(runtime.client, "deregister_child_spawn", None)
        if callable(register_child_spawn):
            try:
                register_child_spawn(
                    transport=self.transport,
                    pid=int(proc.pid),
                    command=command,
                    session_id=session_id,
                )
            except Exception as exc:
                message = str(exc).strip() or "Subprocess worker launch could not be registered."
                self._last_failure_kind = "register_failed"
                self._last_return_code = None
                self._last_stderr_excerpt = None
                self._last_terminal_outcome = "retryable_failure"
                self._last_terminal_error = message
                try:
                    _signal_process_tree(proc, signal.SIGKILL)
                except Exception:
                    LOGGER.debug("subprocess_worker_register_failed_kill", exc_info=True)
                yield {"type": "error", "error": message}
                return

        saw_error_event = False
        timed_out = False
        detached_warm_worker = False
        saw_attach_ready = False
        saw_post_run_attach_ready = False
        saw_done_event = False
        saw_worker_terminal_success = False
        reply_chunks: list[str] = []
        last_done_payload: dict[str, object] | None = None
        return_code: int | None = None
        stderr_excerpt: str | None = None
        failure_kind: str | None = None
        terminal_outcome: str | None = None
        terminal_error: str | None = None
        inactivity_timeout_seconds = max(1.0, float(self.timeout_seconds))
        last_progress_at = time.monotonic()
        try:
            if proc.stdin is not None:
                try:
                    proc.stdin.write(json.dumps(payload, separators=(",", ":")))
                    proc.stdin.close()
                except (BrokenPipeError, OSError) as exc:
                    message = str(exc).strip() or "Subprocess worker exited before it could accept input."
                    saw_error_event = True
                    failure_kind = "stdin_write_failed"
                    terminal_outcome = "retryable_failure"
                    terminal_error = message
                    yield {"type": "error", "error": message}
                    return

            if proc.stdout is None:
                saw_error_event = True
                failure_kind = "stdout_missing"
                yield {"type": "error", "error": "Subprocess worker produced no stdout stream."}
            else:
                line_queue: queue.Queue[str | None] = queue.Queue()

                def _reader() -> None:
                    try:
                        for raw_line in proc.stdout:
                            line_queue.put(raw_line)
                    finally:
                        line_queue.put(None)

                reader = threading.Thread(target=_reader, name="subprocess-worker-stdout-reader", daemon=True)
                reader.start()
                while True:
                    now = time.monotonic()
                    idle_for = now - last_progress_at
                    remaining = inactivity_timeout_seconds - idle_for
                    if remaining <= 0:
                        timed_out = True
                        failure_kind = "timeout"
                        break
                    try:
                        raw_line = line_queue.get(timeout=min(0.2, remaining))
                    except queue.Empty:
                        if proc.poll() is not None:
                            try:
                                raw_line = line_queue.get_nowait()
                            except queue.Empty:
                                break
                        continue
                    if raw_line is None:
                        break
                    line = str(raw_line or "").strip()
                    if not line:
                        continue
                    last_progress_at = time.monotonic()
                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        LOGGER.warning("subprocess_worker_bad_json_line line=%r", line[:220])
                        continue
                    if not isinstance(event, dict):
                        continue
                    event_type = str(event.get("type") or "")
                    if event_type == "worker_terminal":
                        terminal_outcome = str(event.get("outcome") or "").strip().lower() or None
                        terminal_error = str(event.get("error") or "").strip() or None
                        if terminal_outcome == "success" and saw_attach_ready:
                            saw_worker_terminal_success = True
                            if not saw_done_event:
                                synthetic_done = {
                                    "type": "done",
                                    "reply": "".join(reply_chunks).strip(),
                                    "source": "agent-persistent",
                                    "latency_ms": 0,
                                    "session_id": str(session_id or ""),
                                    "persistent_mode": "warm-detached",
                                    "warm_handoff": True,
                                    "synthetic": True,
                                }
                                if synthetic_done.get("reply"):
                                    yield synthetic_done
                                    saw_done_event = True
                                    last_done_payload = dict(synthetic_done)
                        continue
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
                        continue
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
                        continue
                    if event_type == "attach_ready":
                        if saw_attach_ready and (saw_done_event or saw_worker_terminal_success):
                            saw_post_run_attach_ready = True
                        saw_attach_ready = True
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
                        if saw_post_run_attach_ready:
                            detached_warm_worker = True
                            failure_kind = "detached_warm_worker"
                            return_code = 0
                            break
                        continue
                    if event_type == "chunk":
                        chunk_text = str(event.get("text") or "")
                        if chunk_text:
                            reply_chunks.append(chunk_text)
                    elif event_type == "done":
                        saw_done_event = True
                        last_done_payload = dict(event)
                    if event_type == "error":
                        saw_error_event = True
                    yield event

            if timed_out:
                try:
                    _signal_process_tree(proc, signal.SIGTERM)
                except Exception:
                    LOGGER.debug("subprocess_worker_terminate_failed", exc_info=True)

                stderr_excerpt = _read_stderr_excerpt(stderr_file, self.stderr_excerpt_bytes)
                if not saw_error_event:
                    saw_error_event = True
                    yield {
                        "type": "error",
                        "error": self._subprocess_timeout_message(stderr_excerpt=stderr_excerpt),
                    }

            if detached_warm_worker:
                # Keep the parent's stdout pipe end open. Closing it here can race the child
                # worker's post-run attach_ready refresh and kill the warm worker before it
                # reaches its idle attach wait loop.
                pass
            else:
                try:
                    return_code = int(proc.wait(timeout=max(0.1, float(self.kill_grace_seconds))))
                except subprocess.TimeoutExpired:
                    timed_out = True
                    failure_kind = failure_kind or "kill_timeout"
                    try:
                        _signal_process_tree(proc, signal.SIGKILL)
                    except Exception:
                        LOGGER.debug("subprocess_worker_kill_failed", exc_info=True)
                    try:
                        return_code = int(proc.wait(timeout=1.0))
                    except Exception:
                        return_code = proc.returncode if isinstance(proc.returncode, int) else None
                except Exception:
                    return_code = proc.returncode if isinstance(proc.returncode, int) else None

            stderr_excerpt = _read_stderr_excerpt(stderr_file, self.stderr_excerpt_bytes)

            if saw_done_event and not saw_error_event and not detached_warm_worker:
                # Once a terminal `done` has been emitted upstream, treat late process
                # teardown as post-success cleanup rather than surfacing a synthetic
                # failure back into chat history. This can happen when the parent closes
                # the stream iterator immediately after `done` and the child exits via a
                # forced teardown path.
                failure_kind = failure_kind or "completed"
                terminal_outcome = terminal_outcome or "success"
                terminal_error = None
            elif not detached_warm_worker and return_code not in (0, None) and not saw_error_event:
                failure_kind = failure_kind or "nonzero_exit"
                yield {
                    "type": "error",
                    "error": self._subprocess_exit_message(return_code=return_code, stderr_excerpt=stderr_excerpt),
                }
        finally:
            if proc.poll() is None and not detached_warm_worker:
                try:
                    _signal_process_tree(proc, signal.SIGKILL)
                except Exception:
                    LOGGER.debug("subprocess_worker_kill_failed_finally", exc_info=True)
                try:
                    proc.wait(timeout=1)
                except Exception:
                    LOGGER.debug("subprocess_worker_wait_after_kill_failed", exc_info=True)

            if stderr_excerpt is None:
                stderr_excerpt = _read_stderr_excerpt(stderr_file, self.stderr_excerpt_bytes)
            stderr_file.close()

            if return_code is None and isinstance(proc.returncode, int):
                return_code = proc.returncode
            if failure_kind is None:
                if timed_out:
                    failure_kind = "timeout"
                elif return_code == 0:
                    failure_kind = "completed"
                else:
                    failure_kind = "failed"
            self._last_failure_kind = failure_kind
            self._last_return_code = return_code
            self._last_stderr_excerpt = stderr_excerpt
            limit_breach, limit_detail = _classify_limit_breach(
                failure_kind=failure_kind,
                return_code=return_code,
                stderr_excerpt=stderr_excerpt,
                timed_out=timed_out,
            )
            self._last_limit_breach = limit_breach
            self._last_limit_breach_detail = limit_detail

            if terminal_outcome is None:
                if timed_out:
                    terminal_outcome = "timeout_killed"
                elif (return_code == 0 or saw_done_event) and not saw_error_event:
                    terminal_outcome = "success"
                else:
                    terminal_outcome = "retryable_failure"
            if terminal_error is None and timed_out:
                terminal_error = self._subprocess_timeout_message(stderr_excerpt=stderr_excerpt)
            if terminal_error is None and return_code not in (0, None) and not (saw_done_event and not saw_error_event):
                terminal_error = self._subprocess_exit_message(return_code=return_code, stderr_excerpt=stderr_excerpt)
            self._last_terminal_outcome = terminal_outcome
            self._last_terminal_error = terminal_error

            if callable(deregister_child_spawn):
                try:
                    if detached_warm_worker:
                        outcome = "detached_warm_worker"
                    else:
                        outcome = "completed" if return_code == 0 and not timed_out else f"failed:{failure_kind}"
                    deregister_child_spawn(
                        pid=int(proc.pid),
                        outcome=f"{self.transport}:{outcome}",
                        return_code=return_code,
                    )
                except Exception:
                    LOGGER.debug("subprocess_worker_deregister_failed", exc_info=True)


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
