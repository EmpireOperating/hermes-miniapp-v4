from __future__ import annotations

import contextlib
import io
import signal
import subprocess
import time
from types import SimpleNamespace

import chat_worker_runner
import chat_worker_subprocess
from job_runtime_worker_launcher import (
    InlineJobWorkerLauncher,
    SubprocessJobWorkerLauncher,
    build_job_worker_launcher,
)
from server_test_utils import load_server


class RetryableError(Exception):
    pass


class NonRetryableError(Exception):
    pass


class ClientError(Exception):
    pass


def test_chat_worker_subprocess_stream_request_suppresses_stdout_noise() -> None:
    events: list[dict[str, object]] = []
    writer = chat_worker_subprocess._JsonlWriter(lambda event: events.append(dict(event)))

    class FakeClient:
        def stream_events(self, **_kwargs):
            print("[tool] noisy spinner output")
            yield {"type": "tool", "display": "tool event"}
            print("┊ 💻 $ noisy tool line")
            yield {"type": "done", "reply": "ok"}

    captured = io.StringIO()
    with contextlib.redirect_stdout(captured):
        result = chat_worker_subprocess._stream_request(
            client=FakeClient(),
            user_id="123",
            message="hello",
            history=[],
            session_id="miniapp-123-55",
            writer=writer,
            emit_terminal=False,
        )

    assert result == 0
    assert captured.getvalue() == ""
    assert [event["type"] for event in events] == ["tool", "done"]
    assert events[-1]["session_id"] == "miniapp-123-55"


def test_chat_worker_subprocess_skips_warm_attach_when_contract_disabled(monkeypatch) -> None:
    class FakeClient:
        def warm_session_contract(self):
            return SimpleNamespace(enabled=False)

    monkeypatch.setattr(chat_worker_subprocess, "HermesClient", FakeClient)
    stream_calls: list[dict[str, object]] = []
    attach_server_created = {"value": False}

    def fake_stream_request(**kwargs):
        stream_calls.append(dict(kwargs))
        return 0

    class UnexpectedAttachServer:
        def __init__(self, *args, **kwargs):
            attach_server_created["value"] = True
            raise AssertionError("warm attach server should not start when contract disabled")

    monkeypatch.setattr(chat_worker_subprocess, "_stream_request", fake_stream_request)
    monkeypatch.setattr(chat_worker_subprocess, "_WarmAttachServer", UnexpectedAttachServer)
    monkeypatch.setattr(chat_worker_subprocess.sys, "stdin", io.StringIO('{"user_id":"123","message":"hello","session_id":"miniapp-123-55"}'))

    result = chat_worker_subprocess.main()

    assert result == 0
    assert attach_server_created["value"] is False
    assert len(stream_calls) == 1
    assert stream_calls[0]["emit_terminal"] is True


def test_chat_worker_subprocess_stream_request_emits_heartbeat_during_silent_wait(monkeypatch) -> None:
    events: list[dict[str, object]] = []
    writer = chat_worker_subprocess._JsonlWriter(lambda event: events.append(dict(event)))

    class FakeClient:
        def stream_events(self, **_kwargs):
            yield {"type": "done", "reply": "ok"}

    original_get = chat_worker_subprocess.queue.Queue.get
    call_count = {"value": 0}

    def fake_get(self, *args, **kwargs):
        if call_count["value"] == 0:
            call_count["value"] += 1
            raise chat_worker_subprocess.queue.Empty
        return original_get(self, *args, **kwargs)

    monkeypatch.setattr(chat_worker_subprocess.queue.Queue, "get", fake_get)
    monkeypatch.setattr(chat_worker_subprocess, "STREAM_HEARTBEAT_INTERVAL_SECONDS", 0.01)

    result = chat_worker_subprocess._stream_request(
        client=FakeClient(),
        user_id="123",
        message="hello",
        history=[],
        session_id="miniapp-123-55",
        writer=writer,
        emit_terminal=False,
    )

    assert result == 0
    assert any(event.get("type") == "heartbeat" for event in events)
    assert events[-1]["type"] == "done"


def test_inline_worker_launcher_delegates_to_chat_worker_runner(monkeypatch) -> None:
    launcher = InlineJobWorkerLauncher()
    runtime = object()
    job = {"id": 991, "user_id": "123", "chat_id": 55, "operator_message_id": 100}
    called: list[tuple[object, dict[str, object]]] = []

    def fake_run_chat_worker_job(
        runtime_obj,
        job_payload,
        *,
        retryable_error_cls,
        non_retryable_error_cls,
        client_error_cls,
        stream_events_fn=None,
    ) -> None:
        called.append((runtime_obj, dict(job_payload)))
        assert retryable_error_cls is RetryableError
        assert non_retryable_error_cls is NonRetryableError
        assert client_error_cls is ClientError
        assert stream_events_fn is None

    monkeypatch.setattr(chat_worker_runner, "run_chat_worker_job", fake_run_chat_worker_job)

    launcher.launch(
        runtime=runtime,
        job=job,
        retryable_error_cls=RetryableError,
        non_retryable_error_cls=NonRetryableError,
        client_error_cls=ClientError,
    )

    assert called == [(runtime, job)]
    assert launcher.describe() == {"name": "inline", "isolation": "none", "mode": "in-process"}


def test_build_job_worker_launcher_selects_supported_modes() -> None:
    inline_launcher = build_job_worker_launcher(mode="inline")
    subprocess_launcher = build_job_worker_launcher(
        mode="subprocess",
        subprocess_timeout_seconds=7,
        subprocess_kill_grace_seconds=3,
        subprocess_stderr_excerpt_bytes=8192,
        subprocess_memory_limit_mb=1536,
        subprocess_max_tasks=96,
        subprocess_max_open_files=640,
    )

    assert isinstance(inline_launcher, InlineJobWorkerLauncher)
    assert isinstance(subprocess_launcher, SubprocessJobWorkerLauncher)
    assert subprocess_launcher.timeout_seconds == 7
    assert subprocess_launcher.kill_grace_seconds == 3
    assert subprocess_launcher.stderr_excerpt_bytes == 8192
    assert subprocess_launcher.memory_limit_mb == 1536
    assert subprocess_launcher.max_tasks == 96
    assert subprocess_launcher.max_open_files == 640


def test_subprocess_worker_stream_parses_events_tracks_spawn_and_stderr(monkeypatch, tmp_path) -> None:
    script_path = tmp_path / "chat_worker_subprocess.py"
    script_path.write_text("# synthetic test script placeholder\n", encoding="utf-8")

    launcher = SubprocessJobWorkerLauncher(script_path=script_path, python_executable="python3")

    class FakeProcess:
        def __init__(self) -> None:
            self.pid = 91234
            self.stdin = io.StringIO()
            self.stdout = io.StringIO(
                '{"type":"attach_ready","session_id":"miniapp-123-55","transport_kind":"unix_socket_jsonl","worker_endpoint":"/tmp/attach.sock","resume_token":"token-123","resume_deadline_ms":123456}\n'
                '{"type":"chunk","text":"hello"}\n'
                '{"type":"done","reply":"ok","latency_ms":1}\n'
                '{"type":"worker_terminal","outcome":"success"}\n'
                '{"type":"attach_ready","session_id":"miniapp-123-55","transport_kind":"unix_socket_jsonl","worker_endpoint":"/tmp/attach.sock","resume_token":"token-456","resume_deadline_ms":123999}\n'
            )
            self.returncode = 0

        def wait(self, timeout=None) -> int:
            self.returncode = 0
            return 0

        def poll(self):
            return self.returncode

        def terminate(self) -> None:
            self.returncode = -15

        def kill(self) -> None:
            self.returncode = -9

    fake_proc = FakeProcess()

    captured_popen_kwargs: dict[str, object] = {}

    def fake_popen(*_args, **kwargs):
        captured_popen_kwargs.update(kwargs)
        stderr_file = kwargs.get("stderr")
        assert stderr_file is not None
        stderr_file.write("worker stderr sample")
        stderr_file.flush()
        return fake_proc

    monkeypatch.setattr("job_runtime_worker_launcher.subprocess.Popen", fake_popen)

    tracked_spawns: list[tuple[str, int]] = []
    tracked_finishes: list[tuple[int, str, int | None]] = []
    tracked_attach_ready: list[tuple[str, int, str | None]] = []
    runtime = SimpleNamespace(
        client=SimpleNamespace(
            register_child_spawn=lambda *, transport, pid, command, session_id: tracked_spawns.append((transport, pid)),
            deregister_child_spawn=lambda *, pid, outcome, return_code=None, signal=None: tracked_finishes.append(
                (pid, outcome, return_code)
            ),
            note_warm_session_worker_attach_ready=lambda **kwargs: tracked_attach_ready.append(
                (str(kwargs.get("session_id") or ""), int(kwargs.get("owner_pid") or 0), kwargs.get("transport_kind"))
            ),
        )
    )

    events = list(
        launcher._stream_events_via_subprocess(
            runtime=runtime,
            user_id="123",
            message="hello",
            conversation_history=[],
            session_id="miniapp-123-55",
        )
    )

    assert [event["type"] for event in events] == ["chunk", "done"]
    assert tracked_spawns == [(launcher.transport, 91234)]
    assert tracked_attach_ready == [
        ("miniapp-123-55", 91234, "unix_socket_jsonl"),
        ("miniapp-123-55", 91234, "unix_socket_jsonl"),
    ]
    assert tracked_finishes == [(91234, f"{launcher.transport}:detached_warm_worker", 0)]
    info = launcher.describe()
    assert info["last_stderr_excerpt"] == "worker stderr sample"
    assert info["limits"] == {"memory_mb": 1024, "max_tasks": 64, "max_open_files": 256}
    assert callable(captured_popen_kwargs.get("preexec_fn"))
    assert captured_popen_kwargs["env"]["MINI_APP_JOB_WORKER_LAUNCHER"] == "inline"
    assert captured_popen_kwargs["env"]["MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP"] == "shared"
    assert captured_popen_kwargs["env"]["MINI_APP_PERSISTENT_SESSIONS"] == "1"


def test_subprocess_worker_stream_synthesizes_done_for_detached_warm_handoff(monkeypatch, tmp_path) -> None:
    script_path = tmp_path / "chat_worker_subprocess.py"
    script_path.write_text("# synthetic test script placeholder\n", encoding="utf-8")

    launcher = SubprocessJobWorkerLauncher(script_path=script_path, python_executable="python3")

    class FakeProcess:
        def __init__(self) -> None:
            self.pid = 91235
            self.stdin = io.StringIO()
            self.stdout = io.StringIO(
                '{"type":"attach_ready","session_id":"miniapp-123-55","transport_kind":"unix_socket_jsonl","worker_endpoint":"/tmp/attach.sock","resume_token":"token-123","resume_deadline_ms":123456}\n'
                '{"type":"chunk","text":"hello"}\n'
                '{"type":"worker_terminal","outcome":"success"}\n'
                '{"type":"attach_ready","session_id":"miniapp-123-55","transport_kind":"unix_socket_jsonl","worker_endpoint":"/tmp/attach.sock","resume_token":"token-456","resume_deadline_ms":123999}\n'
            )
            self.returncode = 0

        def wait(self, timeout=None) -> int:
            self.returncode = 0
            return 0

        def poll(self):
            return self.returncode

        def terminate(self) -> None:
            self.returncode = -15

        def kill(self) -> None:
            self.returncode = -9

    fake_proc = FakeProcess()
    monkeypatch.setattr("job_runtime_worker_launcher.subprocess.Popen", lambda *_args, **_kwargs: fake_proc)

    runtime = SimpleNamespace(client=SimpleNamespace(register_child_spawn=lambda **_kwargs: None, deregister_child_spawn=lambda **_kwargs: None, note_warm_session_worker_attach_ready=lambda **_kwargs: None))

    events = list(
        launcher._stream_events_via_subprocess(
            runtime=runtime,
            user_id="123",
            message="hello",
            conversation_history=[],
            session_id="miniapp-123-55",
        )
    )

    assert [event["type"] for event in events] == ["chunk", "done"]
    assert events[-1].get("persistent_mode") == "warm-detached"
    assert events[-1].get("warm_handoff") is True
    assert events[-1].get("reply") == "hello"


def test_subprocess_worker_stream_detaches_immediately_after_done_when_attach_ready_seen(monkeypatch, tmp_path) -> None:
    script_path = tmp_path / "chat_worker_subprocess.py"
    script_path.write_text("# synthetic test script placeholder\n", encoding="utf-8")

    launcher = SubprocessJobWorkerLauncher(script_path=script_path, python_executable="python3")

    class FakeProcess:
        def __init__(self) -> None:
            self.pid = 92345
            self.stdin = io.StringIO()
            self.stdout = io.StringIO(
                '{"type":"attach_ready","session_id":"miniapp-123-55","transport_kind":"unix_socket_jsonl","worker_endpoint":"/tmp/attach.sock","resume_token":"token-123","resume_deadline_ms":123456}\n'
                '{"type":"chunk","text":"hello"}\n'
                '{"type":"done","reply":"hello","latency_ms":1}\n'
                '{"type":"worker_terminal","outcome":"success"}\n'
                '{"type":"attach_ready","session_id":"miniapp-123-55","transport_kind":"unix_socket_jsonl","worker_endpoint":"/tmp/attach.sock","resume_token":"token-456","resume_deadline_ms":123999}\n'
            )
            self.returncode = None
            self.wait_called = False

        def wait(self, timeout=None) -> int:
            self.wait_called = True
            self.returncode = 0
            return 0

        def poll(self):
            return self.returncode

        def terminate(self) -> None:
            self.returncode = -15

        def kill(self) -> None:
            self.returncode = -9

    fake_proc = FakeProcess()
    finishes: list[tuple[int, str, int | None]] = []
    monkeypatch.setattr("job_runtime_worker_launcher.subprocess.Popen", lambda *_args, **_kwargs: fake_proc)

    runtime = SimpleNamespace(
        client=SimpleNamespace(
            register_child_spawn=lambda **_kwargs: None,
            deregister_child_spawn=lambda *, pid, outcome, return_code=None, signal=None: finishes.append((pid, outcome, return_code)),
            note_warm_session_worker_attach_ready=lambda **_kwargs: None,
        )
    )

    events = list(
        launcher._stream_events_via_subprocess(
            runtime=runtime,
            user_id="123",
            message="hello",
            conversation_history=[],
            session_id="miniapp-123-55",
        )
    )

    assert [event["type"] for event in events] == ["chunk", "done"]
    assert fake_proc.wait_called is False
    assert finishes == [(92345, f"{launcher.transport}:detached_warm_worker", 0)]


def test_subprocess_preexec_creates_new_session_before_applying_limits(monkeypatch) -> None:
    import job_runtime_worker_launcher as launcher_module

    calls: list[tuple[str, int | tuple[int, int]]] = []

    class _FakeResource:
        RLIMIT_AS = 1
        RLIMIT_NPROC = 2
        RLIMIT_NOFILE = 3

        @staticmethod
        def setrlimit(limit, value) -> None:
            calls.append(("setrlimit", int(limit), tuple(int(part) for part in value)))

    monkeypatch.setitem(__import__("sys").modules, "resource", _FakeResource)
    monkeypatch.setattr(launcher_module.os, "setsid", lambda: calls.append(("setsid", 0)))

    preexec = launcher_module._build_subprocess_preexec(
        memory_limit_mb=256,
        max_tasks=32,
        max_open_files=128,
    )
    assert callable(preexec)
    preexec()

    assert calls[0] == ("setsid", 0)
    assert any(call[0] == "setrlimit" and call[1] == _FakeResource.RLIMIT_AS for call in calls)


def test_signal_process_tree_prefers_killpg_on_posix(monkeypatch) -> None:
    import job_runtime_worker_launcher as launcher_module

    proc = SimpleNamespace(
        pid=99123,
        terminate=lambda: (_ for _ in ()).throw(AssertionError("terminate should not run")),
        kill=lambda: (_ for _ in ()).throw(AssertionError("kill should not run")),
    )
    calls: list[tuple[int, int]] = []

    monkeypatch.setattr(launcher_module.os, "getpgid", lambda pid: 88001)
    monkeypatch.setattr(launcher_module.os, "killpg", lambda pgid, sig: calls.append((int(pgid), int(sig))))

    launcher_module._signal_process_tree(proc, signal.SIGKILL)

    assert calls == [(88001, int(signal.SIGKILL))]


def test_subprocess_worker_stream_blocks_before_spawn_when_child_cap_reached(monkeypatch, tmp_path) -> None:
    script_path = tmp_path / "chat_worker_subprocess.py"
    script_path.write_text("# synthetic test script placeholder\n", encoding="utf-8")

    launcher = SubprocessJobWorkerLauncher(script_path=script_path, python_executable="python3")

    popen_called = {"value": False}

    def fake_popen(*_args, **_kwargs):
        popen_called["value"] = True
        raise AssertionError("Popen should not run when child spawn caps reject the launch")

    monkeypatch.setattr("job_runtime_worker_launcher.subprocess.Popen", fake_popen)

    runtime = SimpleNamespace(
        client=SimpleNamespace(
            assert_child_spawn_allowed=lambda **_kwargs: (_ for _ in ()).throw(RuntimeError("Child spawn cap reached")),
        )
    )

    events = list(
        launcher._stream_events_via_subprocess(
            runtime=runtime,
            user_id="123",
            message="hello",
            conversation_history=[],
            session_id="miniapp-123-55",
        )
    )

    assert popen_called["value"] is False
    assert events == [{"type": "error", "error": "Child spawn cap reached"}]
    info = launcher.describe()
    assert info["last_failure_kind"] == "spawn_blocked"
    assert info["last_terminal_outcome"] == "retryable_failure"


def test_subprocess_worker_stream_yields_error_when_input_pipe_breaks(monkeypatch, tmp_path) -> None:
    script_path = tmp_path / "chat_worker_subprocess.py"
    script_path.write_text("# synthetic test script placeholder\n", encoding="utf-8")

    launcher = SubprocessJobWorkerLauncher(script_path=script_path, python_executable="python3")

    class BrokenPipeProcess:
        def __init__(self) -> None:
            self.pid = 91235
            self.stdout = io.StringIO("")
            self.returncode = 1
            self.killed = False

            class _BrokenPipeStdin:
                def write(self, _value):
                    raise BrokenPipeError("broken pipe")

                def close(self):
                    return None

            self.stdin = _BrokenPipeStdin()

        def wait(self, timeout=None) -> int:
            self.returncode = 1
            return 1

        def poll(self):
            return self.returncode

        def terminate(self) -> None:
            self.returncode = -15

        def kill(self) -> None:
            self.killed = True
            self.returncode = -9

    fake_proc = BrokenPipeProcess()

    def fake_popen(*_args, **kwargs):
        stderr_file = kwargs.get("stderr")
        assert stderr_file is not None
        stderr_file.write("child exited before stdin write")
        stderr_file.flush()
        return fake_proc

    monkeypatch.setattr("job_runtime_worker_launcher.subprocess.Popen", fake_popen)

    finishes: list[tuple[int, str, int | None]] = []
    runtime = SimpleNamespace(
        client=SimpleNamespace(
            assert_child_spawn_allowed=lambda **_kwargs: None,
            register_child_spawn=lambda **_kwargs: None,
            deregister_child_spawn=lambda *, pid, outcome, return_code=None, signal=None: finishes.append(
                (pid, outcome, return_code)
            ),
        )
    )

    events = list(
        launcher._stream_events_via_subprocess(
            runtime=runtime,
            user_id="123",
            message="hello",
            conversation_history=[],
            session_id="miniapp-123-55",
        )
    )

    assert events == [{"type": "error", "error": "broken pipe"}]
    assert finishes == [(91235, f"{launcher.transport}:failed:stdin_write_failed", 1)]
    info = launcher.describe()
    assert info["last_failure_kind"] == "stdin_write_failed"
    assert info["last_terminal_outcome"] == "retryable_failure"
    assert info["last_terminal_error"] == "broken pipe"


def test_subprocess_worker_timeout_forces_termination(monkeypatch, tmp_path) -> None:
    script_path = tmp_path / "chat_worker_subprocess.py"
    script_path.write_text("# synthetic test script placeholder\n", encoding="utf-8")

    launcher = SubprocessJobWorkerLauncher(
        script_path=script_path,
        python_executable="python3",
        timeout_seconds=0.01,
        kill_grace_seconds=0.01,
    )

    class HangingStdout:
        def __iter__(self):
            return self

        def __next__(self):
            import time as _time

            _time.sleep(60)
            return ""

    class FakeProcess:
        def __init__(self) -> None:
            self.pid = 92345
            self.stdin = io.StringIO()
            self.stdout = HangingStdout()
            self.returncode = None
            self.terminated = False
            self.killed = False
            self.wait_calls = 0

        def wait(self, timeout=None) -> int:
            self.wait_calls += 1
            if self.wait_calls == 1:
                raise subprocess.TimeoutExpired(cmd="worker", timeout=timeout or 0)
            self.returncode = -9
            return -9

        def poll(self):
            return self.returncode

        def terminate(self) -> None:
            self.terminated = True

        def kill(self) -> None:
            self.killed = True
            self.returncode = -9

    fake_proc = FakeProcess()

    def fake_popen(*_args, **kwargs):
        stderr_file = kwargs.get("stderr")
        if stderr_file is not None:
            stderr_file.write("timed out stderr trail")
            stderr_file.flush()
        return fake_proc

    monotonic_values = iter([0.0, 1.0, 2.0, 3.0])
    monkeypatch.setattr("job_runtime_worker_launcher.subprocess.Popen", fake_popen)
    monkeypatch.setattr("job_runtime_worker_launcher.time.monotonic", lambda: next(monotonic_values, 3.0))

    finishes: list[tuple[int, str, int | None]] = []
    runtime = SimpleNamespace(
        client=SimpleNamespace(
            register_child_spawn=lambda **_kwargs: None,
            deregister_child_spawn=lambda *, pid, outcome, return_code=None, signal=None: finishes.append(
                (pid, outcome, return_code)
            ),
        )
    )

    events = list(
        launcher._stream_events_via_subprocess(
            runtime=runtime,
            user_id="123",
            message="hello",
            conversation_history=[],
            session_id="miniapp-123-55",
        )
    )

    timeout_error = next(str(evt.get("error", "")) for evt in events if "timed out" in str(evt.get("error", "")))
    assert "timed out stderr trail" in timeout_error
    assert fake_proc.terminated is True
    assert fake_proc.killed is True
    assert finishes == [(92345, f"{launcher.transport}:failed:timeout", -9)]
    info = launcher.describe()
    assert info["last_failure_kind"] == "timeout"
    assert info["last_return_code"] == -9
    assert "timed out stderr trail" in str(info["last_stderr_excerpt"])
    assert info["last_terminal_outcome"] == "timeout_killed"
    assert "timed out stderr trail" in str(info["last_terminal_error"])


def test_subprocess_worker_timeout_tracks_inactivity_not_total_elapsed_time(monkeypatch, tmp_path) -> None:
    script_path = tmp_path / "chat_worker_subprocess.py"
    script_path.write_text("# synthetic test script placeholder\n", encoding="utf-8")

    launcher = SubprocessJobWorkerLauncher(
        script_path=script_path,
        python_executable="python3",
        timeout_seconds=1.0,
        kill_grace_seconds=0.01,
    )

    class FakeProcess:
        def __init__(self) -> None:
            self.pid = 92346
            self.stdin = io.StringIO()
            self.stdout = io.StringIO(
                '[tool] still working...\n'
                '[tool] still working...\n'
                '[tool] still working...\n'
                '{"type":"done","reply":"ok","latency_ms":1}\n'
                '{"type":"worker_terminal","outcome":"success"}\n'
            )
            self.returncode = 0
            self.terminated = False
            self.killed = False

        def wait(self, timeout=None) -> int:
            self.returncode = 0
            return 0

        def poll(self):
            return self.returncode

        def terminate(self) -> None:
            self.terminated = True
            self.returncode = -15

        def kill(self) -> None:
            self.killed = True
            self.returncode = -9

    fake_proc = FakeProcess()

    monotonic_values = iter([0.0, 0.4, 0.4, 0.8, 0.8, 1.2, 1.2, 1.6, 1.6])
    monkeypatch.setattr("job_runtime_worker_launcher.subprocess.Popen", lambda *_args, **_kwargs: fake_proc)
    monkeypatch.setattr("job_runtime_worker_launcher.time.monotonic", lambda: next(monotonic_values, 1.6))

    runtime = SimpleNamespace(client=SimpleNamespace(register_child_spawn=lambda **_kwargs: None, deregister_child_spawn=lambda **_kwargs: None))

    events = list(
        launcher._stream_events_via_subprocess(
            runtime=runtime,
            user_id="123",
            message="hello",
            conversation_history=[],
            session_id="miniapp-123-55",
        )
    )

    assert [event["type"] for event in events] == ["done"]
    assert fake_proc.terminated is False
    assert fake_proc.killed is False
    info = launcher.describe()
    assert info["last_failure_kind"] == "completed"
    assert info["last_terminal_outcome"] == "success"


def test_subprocess_worker_classifies_limit_breach_from_stderr(monkeypatch, tmp_path) -> None:
    script_path = tmp_path / "chat_worker_subprocess.py"
    script_path.write_text("# synthetic test script placeholder\n", encoding="utf-8")

    launcher = SubprocessJobWorkerLauncher(script_path=script_path, python_executable="python3")

    class FakeProcess:
        def __init__(self) -> None:
            self.pid = 91236
            self.stdin = io.StringIO()
            self.stdout = io.StringIO('{"type":"error","error":"worker failed"}\n')
            self.returncode = 1

        def wait(self, timeout=None) -> int:
            self.returncode = 1
            return 1

        def poll(self):
            return self.returncode

        def terminate(self) -> None:
            self.returncode = -15

        def kill(self) -> None:
            self.returncode = -9

    fake_proc = FakeProcess()

    def fake_popen(*_args, **kwargs):
        stderr_file = kwargs.get("stderr")
        assert stderr_file is not None
        stderr_file.write("OSError: [Errno 24] Too many open files")
        stderr_file.flush()
        return fake_proc

    monkeypatch.setattr("job_runtime_worker_launcher.subprocess.Popen", fake_popen)

    runtime = SimpleNamespace(client=SimpleNamespace(register_child_spawn=lambda **_kwargs: None, deregister_child_spawn=lambda **_kwargs: None))

    _ = list(
        launcher._stream_events_via_subprocess(
            runtime=runtime,
            user_id="123",
            message="hello",
            conversation_history=[],
            session_id="miniapp-123-55",
        )
    )

    info = launcher.describe()
    assert info["last_limit_breach"] == "open_files"
    assert info["last_limit_breach_detail"] == "stderr_emfile"


def test_subprocess_worker_stream_reads_worker_terminal_outcome(monkeypatch, tmp_path) -> None:
    script_path = tmp_path / "chat_worker_subprocess.py"
    script_path.write_text("# synthetic test script placeholder\n", encoding="utf-8")

    launcher = SubprocessJobWorkerLauncher(script_path=script_path, python_executable="python3")

    class FakeProcess:
        def __init__(self) -> None:
            self.pid = 91235
            self.stdin = io.StringIO()
            self.stdout = io.StringIO(
                '{"type":"chunk","text":"hello"}\n'
                '{"type":"worker_terminal","outcome":"success"}\n'
            )
            self.returncode = 0

        def wait(self, timeout=None) -> int:
            self.returncode = 0
            return 0

        def poll(self):
            return self.returncode

        def terminate(self) -> None:
            self.returncode = -15

        def kill(self) -> None:
            self.returncode = -9

    fake_proc = FakeProcess()

    def fake_popen(*_args, **_kwargs):
        return fake_proc

    monkeypatch.setattr("job_runtime_worker_launcher.subprocess.Popen", fake_popen)

    runtime = SimpleNamespace(client=SimpleNamespace(register_child_spawn=lambda **_kwargs: None, deregister_child_spawn=lambda **_kwargs: None))

    events = list(
        launcher._stream_events_via_subprocess(
            runtime=runtime,
            user_id="123",
            message="hello",
            conversation_history=[],
            session_id="miniapp-123-55",
        )
    )

    assert [event["type"] for event in events] == ["chunk"]
    assert launcher.describe()["last_terminal_outcome"] == "success"



def test_subprocess_worker_stream_suppresses_late_nonzero_exit_after_done(monkeypatch, tmp_path) -> None:
    script_path = tmp_path / "chat_worker_subprocess.py"
    script_path.write_text("# synthetic test script placeholder\n", encoding="utf-8")

    launcher = SubprocessJobWorkerLauncher(script_path=script_path, python_executable="python3")

    class FakeProcess:
        def __init__(self) -> None:
            self.pid = 91236
            self.stdin = io.StringIO()
            self.stdout = io.StringIO(
                '{"type":"chunk","text":"hello"}\n'
                '{"type":"done","reply":"hello","latency_ms":1}\n'
            )
            self.returncode = None

        def wait(self, timeout=None) -> int:
            self.returncode = -9
            return -9

        def poll(self):
            return self.returncode

        def terminate(self) -> None:
            self.returncode = -15

        def kill(self) -> None:
            self.returncode = -9

    fake_proc = FakeProcess()
    monkeypatch.setattr("job_runtime_worker_launcher.subprocess.Popen", lambda *_args, **_kwargs: fake_proc)

    runtime = SimpleNamespace(client=SimpleNamespace(register_child_spawn=lambda **_kwargs: None, deregister_child_spawn=lambda **_kwargs: None))

    events = list(
        launcher._stream_events_via_subprocess(
            runtime=runtime,
            user_id="123",
            message="hello",
            conversation_history=[],
            session_id="miniapp-123-55",
        )
    )

    assert [event["type"] for event in events] == ["chunk", "done"]
    info = launcher.describe()
    assert info["last_terminal_outcome"] == "success"
    assert info["last_terminal_error"] is None
    assert info["last_failure_kind"] == "completed"



def test_subprocess_worker_stream_surfaces_stderr_on_nonzero_exit(monkeypatch, tmp_path) -> None:
    script_path = tmp_path / "chat_worker_subprocess.py"
    script_path.write_text("# synthetic test script placeholder\n", encoding="utf-8")

    launcher = SubprocessJobWorkerLauncher(script_path=script_path, python_executable="python3")

    class FakeProcess:
        def __init__(self) -> None:
            self.pid = 91237
            self.stdin = io.StringIO()
            self.stdout = io.StringIO("")
            self.returncode = 17

        def wait(self, timeout=None) -> int:
            self.returncode = 17
            return 17

        def poll(self):
            return self.returncode

        def terminate(self) -> None:
            self.returncode = -15

        def kill(self) -> None:
            self.returncode = -9

    def fake_popen(*_args, **kwargs):
        stderr_file = kwargs.get("stderr")
        assert stderr_file is not None
        stderr_file.write("fatal: provider credentials missing")
        stderr_file.flush()
        return FakeProcess()

    monkeypatch.setattr("job_runtime_worker_launcher.subprocess.Popen", fake_popen)

    runtime = SimpleNamespace(client=SimpleNamespace(register_child_spawn=lambda **_kwargs: None, deregister_child_spawn=lambda **_kwargs: None))

    events = list(
        launcher._stream_events_via_subprocess(
            runtime=runtime,
            user_id="123",
            message="hello",
            conversation_history=[],
            session_id="miniapp-123-56",
        )
    )

    error_message = next(str(event.get("error", "")) for event in events if event.get("type") == "error")
    assert "Subprocess worker exited rc=17" in error_message
    assert "provider credentials missing" in error_message
    info = launcher.describe()
    assert "provider credentials missing" in str(info["last_terminal_error"])



def test_subprocess_worker_stream_records_descendant_telemetry(monkeypatch, tmp_path) -> None:
    script_path = tmp_path / "chat_worker_subprocess.py"
    script_path.write_text("# synthetic test script placeholder\n", encoding="utf-8")

    launcher = SubprocessJobWorkerLauncher(script_path=script_path, python_executable="python3")

    class FakeProcess:
        def __init__(self) -> None:
            self.pid = 91237
            self.stdin = io.StringIO()
            self.stdout = io.StringIO(
                '{"type":"child_spawn","transport":"agent-direct","pid":50123,"command":["python","worker.py"],"session_id":"miniapp-123-55"}\n'
                '{"type":"chunk","text":"hello"}\n'
                '{"type":"child_finish","pid":50123,"outcome":"completed","return_code":0}\n'
                '{"type":"worker_terminal","outcome":"success"}\n'
            )
            self.returncode = 0

        def wait(self, timeout=None) -> int:
            self.returncode = 0
            return 0

        def poll(self):
            return self.returncode

        def terminate(self) -> None:
            self.returncode = -15

        def kill(self) -> None:
            self.returncode = -9

    fake_proc = FakeProcess()

    def fake_popen(*_args, **_kwargs):
        return fake_proc

    monkeypatch.setattr("job_runtime_worker_launcher.subprocess.Popen", fake_popen)

    observed_spawns: list[dict[str, object]] = []
    observed_finishes: list[dict[str, object]] = []
    runtime = SimpleNamespace(
        client=SimpleNamespace(
            register_child_spawn=lambda **_kwargs: None,
            deregister_child_spawn=lambda **_kwargs: None,
            observe_descendant_spawn=lambda **kwargs: observed_spawns.append(dict(kwargs)),
            observe_descendant_finish=lambda **kwargs: observed_finishes.append(dict(kwargs)),
        )
    )

    events = list(
        launcher._stream_events_via_subprocess(
            runtime=runtime,
            user_id="123",
            message="hello",
            conversation_history=[],
            session_id="miniapp-123-55",
        )
    )

    assert [event["type"] for event in events] == ["chunk"]
    assert observed_spawns == [
        {
            "transport": "agent-direct",
            "pid": 50123,
            "command": ["python", "worker.py"],
            "session_id": "miniapp-123-55",
            "parent_transport": launcher.transport,
            "parent_pid": 91237,
        }
    ]
    assert observed_finishes == [
        {
            "pid": 50123,
            "outcome": "completed",
            "return_code": 0,
            "signal": None,
            "parent_transport": launcher.transport,
            "parent_pid": 91237,
        }
    ]


def test_subprocess_worker_launcher_maps_retryable_terminal_outcome(monkeypatch, tmp_path) -> None:
    launcher = SubprocessJobWorkerLauncher(script_path=tmp_path / "chat_worker_subprocess.py", python_executable="python3")
    runtime = object()
    job = {"id": 1001, "user_id": "123", "chat_id": 55, "operator_message_id": 100}

    def fake_run_chat_worker_job(*_args, **_kwargs):
        launcher._last_terminal_outcome = "retryable_failure"
        launcher._last_terminal_error = "synthetic retryable"

    monkeypatch.setattr(chat_worker_runner, "run_chat_worker_job", fake_run_chat_worker_job)

    try:
        launcher.launch(
            runtime=runtime,
            job=job,
            retryable_error_cls=RetryableError,
            non_retryable_error_cls=NonRetryableError,
            client_error_cls=ClientError,
        )
        raise AssertionError("Expected retryable mapping")
    except RetryableError as exc:
        assert "synthetic retryable" in str(exc)


def test_subprocess_worker_launcher_maps_non_retryable_terminal_outcome(monkeypatch, tmp_path) -> None:
    launcher = SubprocessJobWorkerLauncher(script_path=tmp_path / "chat_worker_subprocess.py", python_executable="python3")
    runtime = object()
    job = {"id": 1002, "user_id": "123", "chat_id": 56, "operator_message_id": 101}

    def fake_run_chat_worker_job(*_args, **_kwargs):
        launcher._last_terminal_outcome = "non_retryable_failure"
        launcher._last_terminal_error = "synthetic non-retryable"

    monkeypatch.setattr(chat_worker_runner, "run_chat_worker_job", fake_run_chat_worker_job)

    try:
        launcher.launch(
            runtime=runtime,
            job=job,
            retryable_error_cls=RetryableError,
            non_retryable_error_cls=NonRetryableError,
            client_error_cls=ClientError,
        )
        raise AssertionError("Expected non-retryable mapping")
    except NonRetryableError as exc:
        assert "synthetic non-retryable" in str(exc)


def test_subprocess_worker_launcher_maps_timeout_terminal_outcome(monkeypatch, tmp_path) -> None:
    launcher = SubprocessJobWorkerLauncher(script_path=tmp_path / "chat_worker_subprocess.py", python_executable="python3")
    runtime = object()
    job = {"id": 1003, "user_id": "123", "chat_id": 57, "operator_message_id": 102}

    def fake_run_chat_worker_job(*_args, **_kwargs):
        launcher._last_terminal_outcome = "timeout_killed"
        launcher._last_terminal_error = "synthetic timeout"

    monkeypatch.setattr(chat_worker_runner, "run_chat_worker_job", fake_run_chat_worker_job)

    try:
        launcher.launch(
            runtime=runtime,
            job=job,
            retryable_error_cls=RetryableError,
            non_retryable_error_cls=NonRetryableError,
            client_error_cls=ClientError,
        )
        raise AssertionError("Expected timeout mapping")
    except RetryableError as exc:
        assert "synthetic timeout" in str(exc)


def test_subprocess_worker_launcher_remaps_retryable_exception_from_runner(monkeypatch, tmp_path) -> None:
    launcher = SubprocessJobWorkerLauncher(script_path=tmp_path / "chat_worker_subprocess.py", python_executable="python3")
    runtime = object()
    job = {"id": 1004, "user_id": "123", "chat_id": 58, "operator_message_id": 103}

    def fake_run_chat_worker_job(*_args, **_kwargs):
        launcher._last_terminal_outcome = "non_retryable_failure"
        launcher._last_terminal_error = "synthetic non-retryable remap"
        raise RetryableError("runner raised retryable")

    monkeypatch.setattr(chat_worker_runner, "run_chat_worker_job", fake_run_chat_worker_job)

    try:
        launcher.launch(
            runtime=runtime,
            job=job,
            retryable_error_cls=RetryableError,
            non_retryable_error_cls=NonRetryableError,
            client_error_cls=ClientError,
        )
        raise AssertionError("Expected non-retryable remap")
    except NonRetryableError as exc:
        assert "synthetic non-retryable remap" in str(exc)


def test_runtime_run_chat_job_uses_configured_worker_launcher(monkeypatch, tmp_path) -> None:
    server = load_server(monkeypatch, tmp_path)

    user_id = "123"
    chat_id = server.store.ensure_default_chat(user_id)
    operator_message_id = server.store.add_message(user_id, chat_id, "operator", "hello")
    server.store.enqueue_chat_job(user_id, chat_id, operator_message_id, max_attempts=1)
    job = server.store.claim_next_job()
    assert job is not None

    captured_job_ids: list[int] = []

    class FakeLauncher:
        def launch(
            self,
            *,
            runtime,
            job,
            retryable_error_cls,
            non_retryable_error_cls,
            client_error_cls,
        ) -> None:
            captured_job_ids.append(int(job["id"]))

        def describe(self) -> dict[str, object]:
            return {"name": "fake-launcher"}

    server.runtime.worker_launcher = FakeLauncher()

    server.runtime.run_chat_job(job)

    assert captured_job_ids == [int(job["id"])]
    assert server.runtime._try_start_job_runner(job_id=int(job["id"]), user_id=user_id, chat_id=chat_id) is True
    server.runtime._finish_job_runner(int(job["id"]))
