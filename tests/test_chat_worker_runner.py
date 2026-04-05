from __future__ import annotations

import chat_worker_runner


class RetryableError(Exception):
    pass


class NonRetryableError(Exception):
    pass


class ClientError(Exception):
    pass


def test_run_chat_worker_job_delegates_to_execute_chat_job() -> None:
    runtime = object()
    job = {"id": 501, "user_id": "u1", "chat_id": 77, "operator_message_id": 90}
    calls: list[dict[str, object]] = []

    def fake_execute_chat_job(runtime_obj, job_payload, *, retryable_error_cls, non_retryable_error_cls, client_error_cls, stream_events_fn=None):
        calls.append(
            {
                "runtime": runtime_obj,
                "job": dict(job_payload),
                "retryable": retryable_error_cls,
                "non_retryable": non_retryable_error_cls,
                "client_error": client_error_cls,
                "stream_events_fn": stream_events_fn,
            }
        )

    original = chat_worker_runner.execute_chat_job
    chat_worker_runner.execute_chat_job = fake_execute_chat_job
    try:
        chat_worker_runner.run_chat_worker_job(
            runtime,
            job,
            retryable_error_cls=RetryableError,
            non_retryable_error_cls=NonRetryableError,
            client_error_cls=ClientError,
        )
    finally:
        chat_worker_runner.execute_chat_job = original

    assert len(calls) == 1
    assert calls[0]["runtime"] is runtime
    assert calls[0]["job"] == job
    assert calls[0]["retryable"] is RetryableError
    assert calls[0]["non_retryable"] is NonRetryableError
    assert calls[0]["client_error"] is ClientError
    assert calls[0]["stream_events_fn"] is None


def test_run_chat_worker_job_passes_custom_stream_events_fn() -> None:
    runtime = object()
    job = {"id": 502, "user_id": "u2", "chat_id": 78, "operator_message_id": 91}

    def fake_stream_events(**_kwargs):
        return []

    seen_stream_fn: list[object] = []

    def fake_execute_chat_job(*_args, stream_events_fn=None, **_kwargs):
        seen_stream_fn.append(stream_events_fn)

    original = chat_worker_runner.execute_chat_job
    chat_worker_runner.execute_chat_job = fake_execute_chat_job
    try:
        chat_worker_runner.run_chat_worker_job(
            runtime,
            job,
            retryable_error_cls=RetryableError,
            non_retryable_error_cls=NonRetryableError,
            client_error_cls=ClientError,
            stream_events_fn=fake_stream_events,
        )
    finally:
        chat_worker_runner.execute_chat_job = original

    assert seen_stream_fn == [fake_stream_events]
