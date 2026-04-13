from __future__ import annotations

import contextlib
import io
import json
import socket
import sys
import platform
import tempfile
import threading
import time
import uuid
import queue
from pathlib import Path
from typing import Any, Callable

from hermes_client import HermesClient


TERMINAL_SUCCESS = "success"
TERMINAL_RETRYABLE = "retryable_failure"
TERMINAL_NON_RETRYABLE = "non_retryable_failure"
WARM_ATTACH_TRANSPORT = "unix_socket_jsonl"
WARM_ATTACH_TTL_MS = 60000
STREAM_HEARTBEAT_INTERVAL_SECONDS = 20.0


class _JsonlWriter:
    def __init__(self, send: Callable[[dict[str, Any]], None]) -> None:
        self._send = send

    def emit(self, event: dict[str, Any]) -> None:
        self._send(dict(event))


class _WarmAttachServer:
    def __init__(
        self,
        *,
        session_id: str,
        client: HermesClient,
        request_lock: threading.Lock,
        ttl_ms: int = WARM_ATTACH_TTL_MS,
    ) -> None:
        self.session_id = str(session_id or "")
        self.client = client
        self.request_lock = request_lock
        self.ttl_ms = max(1000, int(ttl_ms or WARM_ATTACH_TTL_MS))
        self._contract_lock = threading.Lock()
        self.resume_token = uuid.uuid4().hex
        self.resume_deadline_ms = int(time.monotonic() * 1000) + self.ttl_ms
        self.tmpdir = tempfile.TemporaryDirectory(prefix="miniapp-warm-attach-")
        self.socket_path = str(Path(self.tmpdir.name) / "attach.sock")
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server.bind(self.socket_path)
        self.server.listen(4)
        self.server.settimeout(0.2)
        self.stop_event = threading.Event()
        self.thread = threading.Thread(target=self._serve, name="miniapp-warm-attach-server", daemon=True)
        self.thread.start()

    def ready_event(self) -> dict[str, Any]:
        with self._contract_lock:
            return {
                "type": "attach_ready",
                "session_id": self.session_id,
                "transport_kind": WARM_ATTACH_TRANSPORT,
                "worker_endpoint": self.socket_path,
                "resume_token": self.resume_token,
                "resume_deadline_ms": self.resume_deadline_ms,
            }

    def refresh_contract(self) -> dict[str, Any]:
        with self._contract_lock:
            self.resume_token = uuid.uuid4().hex
            self.resume_deadline_ms = int(time.monotonic() * 1000) + self.ttl_ms
        return self.ready_event()

    def close(self) -> None:
        self.stop_event.set()
        try:
            self.server.close()
        except Exception:
            pass
        try:
            self.thread.join(timeout=0.5)
        except Exception:
            pass
        try:
            self.tmpdir.cleanup()
        except Exception:
            pass

    def _serve(self) -> None:
        while not self.stop_event.is_set():
            if int(time.monotonic() * 1000) > int(self.resume_deadline_ms):
                break
            try:
                conn, _addr = self.server.accept()
            except socket.timeout:
                continue
            except Exception:
                if self.stop_event.is_set():
                    break
                continue
            thread = threading.Thread(target=self._handle_conn, args=(conn,), daemon=True)
            thread.start()

    def _handle_conn(self, conn: socket.socket) -> None:
        reader = None
        try:
            conn.settimeout(5.0)
            reader = conn.makefile("rb")
            raw_line = reader.readline()
            if not raw_line:
                return
            try:
                payload = json.loads(raw_line.decode("utf-8", errors="ignore"))
            except json.JSONDecodeError:
                conn.sendall(b'{"type":"attach_ack","accepted":false,"reason":"invalid_json"}\n')
                return
            if not isinstance(payload, dict):
                conn.sendall(b'{"type":"attach_ack","accepted":false,"reason":"invalid_shape"}\n')
                return
            if str(payload.get("type") or "") != "warm_attach_resume":
                conn.sendall(b'{"type":"attach_ack","accepted":false,"reason":"wrong_type"}\n')
                return
            if str(payload.get("session_id") or "") != self.session_id:
                conn.sendall(b'{"type":"attach_ack","accepted":false,"reason":"session_mismatch"}\n')
                return
            with self._contract_lock:
                expected_token = str(self.resume_token or "")
                expected_deadline_ms = int(self.resume_deadline_ms)
            if str(payload.get("resume_token") or "") != expected_token:
                conn.sendall(b'{"type":"attach_ack","accepted":false,"reason":"resume_token_invalid"}\n')
                return
            if int(time.monotonic() * 1000) > expected_deadline_ms:
                conn.sendall(b'{"type":"attach_ack","accepted":false,"reason":"resume_deadline_expired"}\n')
                return
            conn.sendall(b'{"type":"attach_ack","accepted":true,"reason":"attach_accepted"}\n')

            def _send(event: dict[str, Any]) -> None:
                line = json.dumps(event, separators=(",", ":")) + "\n"
                conn.sendall(line.encode("utf-8"))

            writer = _JsonlWriter(_send)
            with self.request_lock:
                _stream_request(
                    client=self.client,
                    user_id=str(payload.get("user_id") or ""),
                    message=str(payload.get("message") or ""),
                    history=payload.get("conversation_history"),
                    session_id=self.session_id,
                    writer=writer,
                    emit_terminal=False,
                    before_done=lambda: writer.emit(self.refresh_contract()),
                )
        finally:
            if reader is not None:
                try:
                    reader.close()
                except Exception:
                    pass
            try:
                conn.close()
            except Exception:
                pass


def _emit_stdout(event: dict[str, Any]) -> None:
    stream = getattr(sys, "__stdout__", None) or sys.stdout
    stream.write(json.dumps(event, separators=(",", ":")) + "\n")
    stream.flush()


def _emit_terminal(writer: _JsonlWriter, *, outcome: str, error: str | None = None) -> None:
    payload: dict[str, Any] = {"type": "worker_terminal", "outcome": str(outcome or TERMINAL_RETRYABLE)}
    if error:
        payload["error"] = str(error)
    writer.emit(payload)


def _normalize_history(history: Any) -> list[dict[str, Any]]:
    if not isinstance(history, list):
        return []
    return [item for item in history if isinstance(item, dict)]


def _warm_attach_runtime_supported(*, platform_name: str | None = None) -> bool:
    name = str(platform_name or sys.platform).lower()
    return (not name.startswith("win")) and hasattr(socket, "AF_UNIX")


def _warm_attach_enabled(client: HermesClient) -> bool:
    if not _warm_attach_runtime_supported():
        return False
    contract_fn = getattr(client, "warm_session_contract", None)
    if not callable(contract_fn):
        return False
    try:
        contract = contract_fn()
    except Exception:
        return False
    enabled = getattr(contract, "enabled", None)
    if enabled is not None:
        return bool(enabled)
    if isinstance(contract, dict):
        return bool(contract.get("enabled"))
    return False


def _stream_request(
    *,
    client: HermesClient,
    user_id: str,
    message: str,
    history: Any,
    session_id: str,
    writer: _JsonlWriter,
    emit_terminal: bool,
    before_done: Callable[[], None] | None = None,
) -> int:
    saw_done = False
    normalized_history = _normalize_history(history)
    queue_done = object()
    queue_error = object()
    event_queue: queue.Queue[object] = queue.Queue()

    def _reader() -> None:
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                for event in client.stream_events(
                    user_id=str(user_id or ""),
                    message=str(message or ""),
                    conversation_history=normalized_history,
                    session_id=str(session_id or ""),
                ):
                    event_queue.put(event)
        except Exception as exc:  # noqa: BLE001
            event_queue.put((queue_error, exc))
        finally:
            event_queue.put(queue_done)

    reader_thread = threading.Thread(target=_reader, name="miniapp-subprocess-stream-reader", daemon=True)
    reader_thread.start()
    heartbeat_interval = max(1.0, float(STREAM_HEARTBEAT_INTERVAL_SECONDS))

    while True:
        try:
            event = event_queue.get(timeout=heartbeat_interval)
        except queue.Empty:
            writer.emit({"type": "heartbeat", "session_id": session_id})
            continue

        if event is queue_done:
            break
        if isinstance(event, tuple) and len(event) == 2 and event[0] is queue_error:
            exc = event[1]
            if emit_terminal:
                _emit_terminal(writer, outcome=TERMINAL_RETRYABLE, error=f"Subprocess stream failure: {exc}")
            else:
                writer.emit({"type": "error", "error": f"Attached worker stream failure: {exc}"})
            return 10
        if not isinstance(event, dict):
            continue
        payload = dict(event)
        payload.setdefault("session_id", session_id)
        if str(payload.get("type") or "") == "done":
            if callable(before_done):
                before_done()
            saw_done = True
        writer.emit(payload)

    if saw_done:
        if emit_terminal:
            _emit_terminal(writer, outcome=TERMINAL_SUCCESS)
        return 0

    if emit_terminal:
        _emit_terminal(writer, outcome=TERMINAL_RETRYABLE, error="Subprocess stream ended without done event.")
    else:
        writer.emit({"type": "error", "error": "Attached worker stream ended without done event."})
    return 10


def main() -> int:
    raw_payload = sys.stdin.read()
    stdout_writer = _JsonlWriter(_emit_stdout)
    if not raw_payload:
        _emit_terminal(stdout_writer, outcome=TERMINAL_NON_RETRYABLE, error="Subprocess worker received empty payload.")
        return 2

    try:
        payload = json.loads(raw_payload)
    except json.JSONDecodeError:
        _emit_terminal(stdout_writer, outcome=TERMINAL_NON_RETRYABLE, error="Subprocess worker payload was invalid JSON.")
        return 2

    user_id = str(payload.get("user_id") or "")
    message = str(payload.get("message") or "")
    session_id = str(payload.get("session_id") or "")
    history = payload.get("conversation_history")

    client = HermesClient()
    if session_id:
        parsed_chat_id = None
        prefix = f"miniapp-{user_id}-"
        if user_id and session_id.startswith(prefix):
            suffix = session_id[len(prefix) :].strip()
            try:
                parsed_chat_id = int(suffix)
            except (TypeError, ValueError):
                parsed_chat_id = None
        set_spawn_trace_context = getattr(client, "set_spawn_trace_context", None)
        if callable(set_spawn_trace_context):
            set_spawn_trace_context(user_id=user_id, chat_id=parsed_chat_id, session_id=session_id)

    register_child_spawn = getattr(client, "register_child_spawn", None)
    deregister_child_spawn = getattr(client, "deregister_child_spawn", None)
    if callable(register_child_spawn):
        def _wrapped_register_child_spawn(*, transport, pid, command, session_id=None):
            spawn_id = register_child_spawn(transport=transport, pid=pid, command=command, session_id=session_id)
            stdout_writer.emit(
                {
                    "type": "child_spawn",
                    "transport": str(transport or "unknown"),
                    "pid": int(pid),
                    "command": [str(part) for part in list(command or [])],
                    "session_id": str(session_id or ""),
                }
            )
            return spawn_id

        client.register_child_spawn = _wrapped_register_child_spawn

    if callable(deregister_child_spawn):
        def _wrapped_deregister_child_spawn(*, pid, outcome, return_code=None, signal=None):
            result = deregister_child_spawn(pid=pid, outcome=outcome, return_code=return_code, signal=signal)
            stdout_writer.emit(
                {
                    "type": "child_finish",
                    "pid": int(pid),
                    "outcome": str(outcome or "unknown"),
                    "return_code": return_code,
                    "signal": signal,
                }
            )
            return result

        client.deregister_child_spawn = _wrapped_deregister_child_spawn

    if not _warm_attach_enabled(client):
        if not _warm_attach_runtime_supported():
            stdout_writer.emit(
                {
                    "type": "meta",
                    "source": "warm-attach",
                    "status": "disabled",
                    "reason": "unsupported_platform_warm_attach",
                    "detail": "Warm attach currently depends on AF_UNIX and is disabled on this platform.",
                    "platform": platform.system() or sys.platform,
                    "session_id": session_id,
                }
            )
        return _stream_request(
            client=client,
            user_id=user_id,
            message=message,
            history=history,
            session_id=session_id,
            writer=stdout_writer,
            emit_terminal=True,
        )

    request_lock = threading.Lock()
    attach_server = _WarmAttachServer(session_id=session_id, client=client, request_lock=request_lock)
    try:
        stdout_writer.emit(attach_server.ready_event())
        with request_lock:
            result = _stream_request(
                client=client,
                user_id=user_id,
                message=message,
                history=history,
                session_id=session_id,
                writer=stdout_writer,
                emit_terminal=True,
            )
        if result != 0:
            return result
        stdout_writer.emit(attach_server.refresh_contract())
        while int(time.monotonic() * 1000) <= int(attach_server.ready_event().get("resume_deadline_ms") or 0):
            time.sleep(0.1)
        return 0
    finally:
        attach_server.close()


if __name__ == "__main__":
    raise SystemExit(main())
