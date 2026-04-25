from __future__ import annotations

import logging
import queue
import signal
import subprocess
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, TYPE_CHECKING

if TYPE_CHECKING:
    from job_runtime import JobRuntime


LOGGER = logging.getLogger(__name__)


@dataclass(slots=True)
class SubprocessStreamState:
    saw_error_event: bool = False
    timed_out: bool = False
    first_event_timeout: bool = False
    saw_stream_event: bool = False
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
    last_memory_sample_at: float | None = None


def mark_subprocess_setup_failure(
    state: SubprocessStreamState,
    *,
    failure_kind: str,
    terminal_outcome: str,
    terminal_error: str,
    saw_error_event: bool = True,
) -> None:
    state.saw_error_event = bool(saw_error_event)
    state.failure_kind = str(failure_kind)
    state.terminal_outcome = str(terminal_outcome)
    state.terminal_error = str(terminal_error)


class SubprocessStreamLifecycle:
    def __init__(
        self,
        *,
        transport: str,
        timeout_seconds: float,
        first_event_timeout_seconds: float,
        kill_grace_seconds: float,
        stderr_excerpt_bytes: int,
        decode_event: Callable[[str], dict[str, object] | None],
        stdout_line_queue: Callable[[subprocess.Popen[str]], queue.Queue[str | None]],
        read_stderr_excerpt: Callable[[Any, int], str | None],
        signal_process_tree: Callable[[subprocess.Popen[str], int], None],
        classify_limit_breach: Callable[..., tuple[str | None, str | None]],
        build_timeout_message: Callable[..., str],
        build_exit_message: Callable[..., str],
        monotonic_now: Callable[[], float] = time.monotonic,
        memory_sample_interval_seconds: float = 5.0,
    ) -> None:
        self.transport = transport
        self.timeout_seconds = float(timeout_seconds)
        self.first_event_timeout_seconds = float(first_event_timeout_seconds)
        self.kill_grace_seconds = float(kill_grace_seconds)
        self.stderr_excerpt_bytes = int(stderr_excerpt_bytes)
        self.decode_event = decode_event
        self.stdout_line_queue = stdout_line_queue
        self.read_stderr_excerpt = read_stderr_excerpt
        self.signal_process_tree = signal_process_tree
        self.classify_limit_breach = classify_limit_breach
        self.build_timeout_message = build_timeout_message
        self.build_exit_message = build_exit_message
        self.monotonic_now = monotonic_now
        self.memory_sample_interval_seconds = max(1.0, float(memory_sample_interval_seconds))

    def maybe_emit_memory_sample(
        self,
        runtime: 'JobRuntime',
        *,
        proc: subprocess.Popen[str],
        session_id: str,
        state: SubprocessStreamState,
        now: float,
    ) -> None:
        if state.detached_warm_worker or int(getattr(proc, 'pid', 0) or 0) <= 0:
            return
        last_sample_at = state.last_memory_sample_at
        if last_sample_at is not None and (now - float(last_sample_at)) < self.memory_sample_interval_seconds:
            return
        observe_child_process_sample = getattr(runtime.client, 'observe_child_process_sample', None)
        if not callable(observe_child_process_sample):
            state.last_memory_sample_at = now
            return
        try:
            observe_child_process_sample(pid=int(proc.pid), transport=self.transport, session_id=str(session_id or ''))
        except Exception:
            LOGGER.debug('subprocess_worker_memory_sample_failed', exc_info=True)
        state.last_memory_sample_at = now

    def handle_child_spawn_event(
        self,
        runtime: 'JobRuntime',
        *,
        proc: subprocess.Popen[str],
        session_id: str,
        event: dict[str, object],
    ) -> bool:
        event_type = str(event.get('type') or '')
        if event_type == 'child_spawn':
            observe_descendant_spawn = getattr(runtime.client, 'observe_descendant_spawn', None)
            if callable(observe_descendant_spawn):
                observe_descendant_spawn(
                    transport=str(event.get('transport') or 'unknown'),
                    pid=int(event.get('pid') or 0),
                    command=list(event.get('command') or []),
                    session_id=str(event.get('session_id') or session_id or ''),
                    parent_transport=self.transport,
                    parent_pid=int(proc.pid),
                )
            return True
        if event_type == 'child_finish':
            observe_descendant_finish = getattr(runtime.client, 'observe_descendant_finish', None)
            if callable(observe_descendant_finish):
                observe_descendant_finish(
                    pid=int(event.get('pid') or 0),
                    outcome=str(event.get('outcome') or 'unknown'),
                    return_code=event.get('return_code'),
                    signal=event.get('signal'),
                    parent_transport=self.transport,
                    parent_pid=int(proc.pid),
                )
            return True
        return False

    def handle_attach_ready_event(
        self,
        runtime: 'JobRuntime',
        *,
        proc: subprocess.Popen[str],
        session_id: str,
        state: SubprocessStreamState,
        event: dict[str, object],
    ) -> bool:
        if str(event.get('type') or '') != 'attach_ready':
            return False
        if state.saw_attach_ready and (state.saw_done_event or state.saw_worker_terminal_success):
            state.saw_post_run_attach_ready = True
        state.saw_attach_ready = True
        note_attach_ready = getattr(runtime.client, 'note_warm_session_worker_attach_ready', None)
        if callable(note_attach_ready):
            note_attach_ready(
                session_id=str(event.get('session_id') or session_id or ''),
                owner_pid=int(proc.pid),
                transport_kind=str(event.get('transport_kind') or '') or None,
                worker_endpoint=str(event.get('worker_endpoint') or '') or None,
                resume_token=str(event.get('resume_token') or '') or None,
                resume_deadline_ms=event.get('resume_deadline_ms'),
            )
        if state.saw_post_run_attach_ready:
            state.detached_warm_worker = True
            state.failure_kind = 'detached_warm_worker'
            state.return_code = 0
        return True

    def handle_worker_terminal_event(
        self,
        *,
        session_id: str,
        state: SubprocessStreamState,
        event: dict[str, object],
    ) -> dict[str, object] | None:
        if str(event.get('type') or '') != 'worker_terminal':
            return None
        state.terminal_outcome = str(event.get('outcome') or '').strip().lower() or None
        state.terminal_error = str(event.get('error') or '').strip() or None
        if state.terminal_outcome == 'success' and state.saw_attach_ready:
            state.saw_worker_terminal_success = True
            if not state.saw_done_event:
                synthetic_done = {
                    'type': 'done',
                    'reply': ''.join(state.reply_chunks).strip(),
                    'source': 'agent-persistent',
                    'latency_ms': 0,
                    'session_id': str(session_id or ''),
                    'persistent_mode': 'warm-detached',
                    'warm_handoff': True,
                    'synthetic': True,
                }
                if synthetic_done.get('reply'):
                    state.saw_done_event = True
                    state.last_done_payload = dict(synthetic_done)
                    return dict(synthetic_done)
        return {}

    def record_stream_event(self, state: SubprocessStreamState, event: dict[str, object]) -> None:
        event_type = str(event.get('type') or '')
        if event_type == 'chunk':
            chunk_text = str(event.get('text') or '')
            if chunk_text:
                state.reply_chunks.append(chunk_text)
        elif event_type == 'done':
            state.saw_done_event = True
            state.last_done_payload = dict(event)
        if event_type == 'error':
            state.saw_error_event = True

    def iter_events(
        self,
        runtime: 'JobRuntime',
        *,
        proc: subprocess.Popen[str],
        session_id: str,
        state: SubprocessStreamState,
    ) -> Iterable[dict[str, object]]:
        if proc.stdout is None:
            state.saw_error_event = True
            state.failure_kind = 'stdout_missing'
            yield {'type': 'error', 'error': 'Subprocess worker produced no stdout stream.'}
            return

        line_queue = self.stdout_line_queue(proc)
        inactivity_timeout_seconds = max(1.0, float(self.timeout_seconds))
        last_progress_at = self.monotonic_now()
        start_wait_at = last_progress_at
        while True:
            now = self.monotonic_now()
            if not state.saw_stream_event:
                idle_for = now - start_wait_at
                remaining = self.first_event_timeout_seconds - idle_for
            else:
                idle_for = now - last_progress_at
                remaining = inactivity_timeout_seconds - idle_for
            if remaining <= 0:
                state.timed_out = True
                if not state.saw_stream_event:
                    state.first_event_timeout = True
                    state.failure_kind = 'no_first_event_timeout'
                else:
                    state.failure_kind = 'timeout'
                break
            try:
                raw_line = line_queue.get(timeout=min(0.2, remaining))
            except queue.Empty:
                self.maybe_emit_memory_sample(runtime, proc=proc, session_id=session_id, state=state, now=now)
                if proc.poll() is not None:
                    try:
                        raw_line = line_queue.get_nowait()
                    except queue.Empty:
                        break
                else:
                    continue
            if raw_line is None:
                break
            event = self.decode_event(raw_line)
            if event is None:
                continue
            state.saw_stream_event = True
            last_progress_at = self.monotonic_now()
            terminal_event = self.handle_worker_terminal_event(session_id=session_id, state=state, event=event)
            if terminal_event is not None:
                if terminal_event:
                    yield terminal_event
                continue
            if self.handle_child_spawn_event(runtime, proc=proc, session_id=session_id, event=event):
                continue
            if self.handle_attach_ready_event(runtime, proc=proc, session_id=session_id, state=state, event=event):
                if state.detached_warm_worker:
                    break
                continue
            self.record_stream_event(state, event)
            yield event

    def emit_timeout_error(
        self,
        *,
        proc: subprocess.Popen[str],
        stderr_file: Any,
        state: SubprocessStreamState,
    ) -> dict[str, object] | None:
        if not state.timed_out:
            return None
        try:
            self.signal_process_tree(proc, signal.SIGTERM)
        except Exception:
            LOGGER.debug('subprocess_worker_terminate_failed', exc_info=True)
        state.stderr_excerpt = self.read_stderr_excerpt(stderr_file, self.stderr_excerpt_bytes)
        if state.saw_error_event:
            return None
        state.saw_error_event = True
        return {
            'type': 'error',
            'error': self.build_timeout_message(
                first_event=bool(state.first_event_timeout),
                stderr_excerpt=state.stderr_excerpt,
            ),
        }

    def wait_for_exit(self, proc: subprocess.Popen[str], *, state: SubprocessStreamState) -> None:
        if state.detached_warm_worker:
            return
        try:
            state.return_code = int(proc.wait(timeout=max(0.1, float(self.kill_grace_seconds))))
        except subprocess.TimeoutExpired:
            state.timed_out = True
            state.failure_kind = state.failure_kind or 'kill_timeout'
            try:
                self.signal_process_tree(proc, signal.SIGKILL)
            except Exception:
                LOGGER.debug('subprocess_worker_kill_failed', exc_info=True)
            try:
                state.return_code = int(proc.wait(timeout=1.0))
            except Exception:
                state.return_code = proc.returncode if isinstance(proc.returncode, int) else None
        except Exception:
            state.return_code = proc.returncode if isinstance(proc.returncode, int) else None

    def emit_nonzero_exit_error(self, state: SubprocessStreamState) -> dict[str, object] | None:
        if state.detached_warm_worker or state.return_code in (0, None) or state.saw_error_event or state.saw_done_event:
            return None
        state.failure_kind = state.failure_kind or 'nonzero_exit'
        return {
            'type': 'error',
            'error': self.build_exit_message(return_code=state.return_code, stderr_excerpt=state.stderr_excerpt),
        }

    def finalize(
        self,
        *,
        proc: subprocess.Popen[str],
        stderr_file: Any,
        state: SubprocessStreamState,
        deregister_child_spawn: Callable[..., object] | None,
    ) -> dict[str, object | None]:
        if proc.poll() is None and not state.detached_warm_worker:
            try:
                self.signal_process_tree(proc, signal.SIGKILL)
            except Exception:
                LOGGER.debug('subprocess_worker_kill_failed_finally', exc_info=True)
            try:
                proc.wait(timeout=1)
            except Exception:
                LOGGER.debug('subprocess_worker_wait_after_kill_failed', exc_info=True)

        if state.stderr_excerpt is None:
            state.stderr_excerpt = self.read_stderr_excerpt(stderr_file, self.stderr_excerpt_bytes)
        stderr_file.close()

        if state.return_code is None and isinstance(proc.returncode, int):
            state.return_code = proc.returncode
        if state.failure_kind is None:
            if state.timed_out:
                state.failure_kind = 'timeout'
            elif state.return_code == 0:
                state.failure_kind = 'completed'
            else:
                state.failure_kind = 'failed'
        limit_breach, limit_detail = self.classify_limit_breach(
            failure_kind=state.failure_kind,
            return_code=state.return_code,
            stderr_excerpt=state.stderr_excerpt,
            timed_out=state.timed_out,
        )

        if state.terminal_outcome is None:
            if state.timed_out:
                state.terminal_outcome = 'timeout_killed'
            elif (state.return_code == 0 or state.saw_done_event) and not state.saw_error_event:
                state.terminal_outcome = 'success'
            else:
                state.terminal_outcome = 'retryable_failure'
        if state.terminal_error is None and state.timed_out:
            state.terminal_error = self.build_timeout_message(
                first_event=bool(state.first_event_timeout),
                stderr_excerpt=state.stderr_excerpt,
            )
        if state.terminal_error is None and state.return_code not in (0, None) and not (state.saw_done_event and not state.saw_error_event):
            state.terminal_error = self.build_exit_message(return_code=state.return_code, stderr_excerpt=state.stderr_excerpt)

        if callable(deregister_child_spawn):
            try:
                outcome = 'detached_warm_worker' if state.detached_warm_worker else (
                    'completed' if state.return_code == 0 and not state.timed_out else f'failed:{state.failure_kind}'
                )
                deregister_child_spawn(
                    pid=int(proc.pid),
                    outcome=f'{self.transport}:{outcome}',
                    return_code=state.return_code,
                )
            except Exception:
                LOGGER.debug('subprocess_worker_deregister_failed', exc_info=True)

        return {
            'failure_kind': state.failure_kind,
            'return_code': state.return_code,
            'stderr_excerpt': state.stderr_excerpt,
            'terminal_outcome': state.terminal_outcome,
            'terminal_error': state.terminal_error,
            'limit_breach': limit_breach,
            'limit_breach_detail': limit_detail,
        }
