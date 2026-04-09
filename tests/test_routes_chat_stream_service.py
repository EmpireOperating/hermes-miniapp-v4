from __future__ import annotations

import queue
from types import SimpleNamespace

from routes_chat_stream_generator import StreamResponseFactory
from routes_chat_stream_service import (
    after_event_id_from_payload,
    build_stream_route_service,
    stream_segment_seconds_for_headers,
)
from server_test_utils import load_server


class _DummyHeaders(dict):
    def get(self, key, default=None):
        return super().get(key, default)


class _AlwaysEmptySubscriber:
    def get(self, timeout=None):
        raise queue.Empty


class _SingleEventSubscriber:
    def __init__(self, event: dict[str, object]) -> None:
        self._event = event
        self._used = False

    def get(self, timeout=None):
        if self._used:
            raise queue.Empty
        self._used = True
        return dict(self._event)


class _MonotonicTime:
    def __init__(self, ticks: list[float]):
        self._ticks = iter(ticks)

    def monotonic(self) -> float:
        return next(self._ticks, 12.0)


class _Logger:
    def __init__(self) -> None:
        self.calls: list[str] = []

    def info(self, message: str) -> None:
        self.calls.append(message)


class _StoreStub:
    def __init__(self) -> None:
        self.active_chat_calls: list[tuple[str, int]] = []
        self.dead_letter_calls: list[tuple[str, int, int, str]] = []
        self.skin = "obsidian"
        self.job_state = {
            "status": "running",
            "queued_ahead": 0,
            "running_total": 1,
            "attempts": 1,
            "max_attempts": 3,
            "started_at": "2026-04-09 20:00:00",
            "created_at": "2026-04-09 19:59:59",
        }
        self.chat_exists = True

    def set_active_chat(self, *, user_id: str, chat_id: int) -> None:
        self.active_chat_calls.append((user_id, chat_id))

    def get_chat(self, *, user_id: str, chat_id: int):
        if not self.chat_exists:
            raise KeyError("chat not found")
        return {"id": chat_id, "user_id": user_id}

    def add_message(self, *, user_id: str, chat_id: int, role: str, body: str) -> int:
        return 77

    def dead_letter_stale_open_job_for_chat(self, *, user_id: str, chat_id: int, timeout_seconds: int, error: str):
        self.dead_letter_calls.append((user_id, chat_id, timeout_seconds, error))
        return {"id": 33}

    def get_skin(self, user_id: str) -> str:
        return self.skin

    def get_job_state(self, job_id: int):
        return dict(self.job_state)


class _RuntimeStub:
    def __init__(self) -> None:
        self.job_stall_timeout_seconds = 5
        self.unsubscribe_calls: list[tuple[int, object]] = []

    def subscribe_job_events(self, job_id: int, after_event_id: int = 0):
        return _AlwaysEmptySubscriber()

    def unsubscribe_job_events(self, job_id: int, subscriber: object) -> None:
        self.unsubscribe_calls.append((job_id, subscriber))


class _ClientStub:
    def __init__(self, warm_candidate=None) -> None:
        self._warm_candidate = warm_candidate

    def select_warm_session_candidate(self, session_id: str):
        return self._warm_candidate


def _build_service(store, runtime, client, logger):
    return build_stream_route_service(
        store_getter=lambda: store,
        runtime_getter=lambda: runtime,
        client_getter=lambda: client,
        verify_for_sse_fn=lambda payload: (SimpleNamespace(user=SimpleNamespace(id=payload.get("user_id", "123"))), None),
        chat_id_from_payload_or_error_fn=lambda payload, user_id=None: (int(payload.get("chat_id") or 0), None),
        sse_error_fn=lambda message, status, **kwargs: ({"ok": False, "error": message, **kwargs}, status),
        sse_event_fn=lambda event, payload: f"event: {event}\ndata: {payload}\n\n",
        session_id_builder_fn=lambda user_id, chat_id: f"miniapp-{user_id}-{chat_id}",
        build_job_log_fn=lambda event, request_id, chat_id, job_id, extra=None: f"event={event} request_id={request_id} chat_id={chat_id} job_id={job_id} extra={extra}",
        logger=logger,
        stream_timing_debug=True,
        stream_efficiency_mode=False,
        stream_metrics_refresh_seconds=1,
        time_module=_MonotonicTime([0.0, 5.0, 10.0, 15.0]),
    )


def test_verified_user_and_chat_id_activates_chat_via_service_boundary() -> None:
    store = _StoreStub()
    service = _build_service(store, _RuntimeStub(), _ClientStub(), _Logger())

    user_id, chat_id, error = service.verified_user_and_chat_id({"user_id": "123", "chat_id": 9})

    assert error is None
    assert user_id == "123"
    assert chat_id == 9
    assert store.active_chat_calls == [("123", 9)]


def test_recover_stale_open_job_if_needed_dead_letters_with_min_timeout_and_logs() -> None:
    store = _StoreStub()
    logger = _Logger()
    service = _build_service(store, _RuntimeStub(), _ClientStub(), logger)

    stale = service.recover_stale_open_job_if_needed(user_id="123", chat_id=9, request_id="req-1")

    assert stale == {"id": 33}
    assert store.dead_letter_calls == [
        (
            "123",
            9,
            30,
            "E_STALE_OPEN_JOB_AFTER_RESTART: stale open job dead-lettered before new stream",
        )
    ]
    assert logger.calls == [
        "event=stream_stale_open_job_dead_lettered request_id=req-1 chat_id=9 job_id=33 extra={'user_id': '123'}"
    ]


def test_stream_response_factory_recovers_terminal_state_when_queue_is_silent() -> None:
    store = _StoreStub()
    store.job_state = {
        "status": "done",
        "queued_ahead": 0,
        "running_total": 0,
        "attempts": 1,
        "max_attempts": 3,
        "started_at": "2026-04-09 20:00:00",
        "created_at": "2026-04-09 19:59:59",
        "error": "",
    }
    runtime = _RuntimeStub()
    factory = StreamResponseFactory(
        runtime_getter=lambda: runtime,
        store_getter=lambda: store,
        client_getter=lambda: _ClientStub(),
        session_id_builder_fn=lambda user_id, chat_id: f"miniapp-{user_id}-{chat_id}",
        sse_event_fn=lambda event, payload: f"event: {event}\ndata: {payload}\n\n",
        logger=_Logger(),
        build_job_log_fn=lambda **kwargs: str(kwargs),
        stream_timing_debug=False,
        stream_efficiency_mode=False,
        stream_metrics_refresh_seconds=1,
        time_module=_MonotonicTime([0.0, 5.0, 10.0, 15.0]),
    )

    chunks = list(
        factory.generate(
            user_id="123",
            chat_id=9,
            job_id=44,
            request_id="req-1",
        )
    )

    combined = "".join(chunks)
    assert "event: done" in combined
    assert "stream recovered from terminal db state" in combined
    assert runtime.unsubscribe_calls and runtime.unsubscribe_calls[0][0] == 44


def test_stream_response_factory_emits_segment_rollover_meta_and_logs_when_debug_enabled() -> None:
    store = _StoreStub()
    runtime = _RuntimeStub()
    logger = _Logger()
    factory = StreamResponseFactory(
        runtime_getter=lambda: runtime,
        store_getter=lambda: store,
        client_getter=lambda: _ClientStub(),
        session_id_builder_fn=lambda user_id, chat_id: f"miniapp-{user_id}-{chat_id}",
        sse_event_fn=lambda event, payload: f"event: {event}\ndata: {payload}\n\n",
        logger=logger,
        build_job_log_fn=lambda event, request_id, chat_id, job_id, extra=None: f"event={event} request_id={request_id} chat_id={chat_id} job_id={job_id} extra={extra}",
        stream_timing_debug=True,
        stream_efficiency_mode=False,
        stream_metrics_refresh_seconds=1,
        time_module=_MonotonicTime([0.0, 1.0, 2.0, 3.0]),
    )

    chunks = list(
        factory.generate(
            user_id="123",
            chat_id=9,
            job_id=44,
            request_id="req-2",
            segment_seconds=2.5,
        )
    )

    combined = "".join(chunks)
    assert "stream segment rollover" in combined
    assert "resume_recommended" in combined
    assert logger.calls == [
        "event=stream_segment_rollover request_id=req-2 chat_id=9 job_id=44 extra={'user_id': '123', 'segment_seconds': 2.5}"
    ]


def test_stream_response_factory_emits_terminal_recovery_instead_of_silent_close_when_segment_deadline_hits() -> None:
    store = _StoreStub()
    store.job_state = {
        "status": "done",
        "queued_ahead": 0,
        "running_total": 0,
        "attempts": 1,
        "max_attempts": 3,
        "started_at": "2026-04-09 20:00:00",
        "created_at": "2026-04-09 19:59:59",
        "error": "",
    }
    runtime = _RuntimeStub()
    runtime.subscribe_job_events = lambda job_id, after_event_id=0: _SingleEventSubscriber(
        {"event": "chunk", "payload": {"chat_id": 9, "text": "partial"}, "event_id": 7}
    )
    factory = StreamResponseFactory(
        runtime_getter=lambda: runtime,
        store_getter=lambda: store,
        client_getter=lambda: _ClientStub(),
        session_id_builder_fn=lambda user_id, chat_id: f"miniapp-{user_id}-{chat_id}",
        sse_event_fn=lambda event, payload: f"event: {event}\ndata: {payload}\n\n",
        logger=_Logger(),
        build_job_log_fn=lambda **kwargs: str(kwargs),
        stream_timing_debug=False,
        stream_efficiency_mode=False,
        stream_metrics_refresh_seconds=1,
        time_module=_MonotonicTime([0.0, 3.0]),
    )

    chunks = list(
        factory.generate(
            user_id="123",
            chat_id=9,
            job_id=44,
            request_id="req-3",
            segment_seconds=2.5,
        )
    )

    combined = "".join(chunks)
    assert "event: chunk" in combined
    assert "'text': 'partial'" in combined
    assert "event: done" in combined
    assert "stream recovered from terminal db state" in combined
    assert "stream segment rollover" not in combined


def test_stream_segment_seconds_for_headers_prefers_mobile_user_agent(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_STREAM_SEGMENT_SECONDS", "30")
    monkeypatch.setenv("MINI_APP_STREAM_SEGMENT_SECONDS_MOBILE", "8")

    mobile = stream_segment_seconds_for_headers(_DummyHeaders({"User-Agent": "Telegram iPhone"}))
    desktop = stream_segment_seconds_for_headers(_DummyHeaders({"User-Agent": "Mozilla/5.0 (X11; Linux x86_64)"}))

    assert mobile == 8.0
    assert desktop == 30.0


def test_after_event_id_from_payload_clamps_invalid_values() -> None:
    assert after_event_id_from_payload({"after_event_id": "17"}) == 17
    assert after_event_id_from_payload({"after_event_id": -9}) == 0
    assert after_event_id_from_payload({"after_event_id": "bad"}) == 0


def test_direct_chat_management_service_contract_file_is_importable(monkeypatch, tmp_path) -> None:
    server = load_server(monkeypatch, tmp_path)
    assert server is not None
