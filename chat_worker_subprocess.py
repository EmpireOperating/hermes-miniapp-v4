from __future__ import annotations

import json
import sys
from typing import Any

from hermes_client import HermesClient


TERMINAL_SUCCESS = "success"
TERMINAL_RETRYABLE = "retryable_failure"
TERMINAL_NON_RETRYABLE = "non_retryable_failure"


def _emit(event: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(event, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def _emit_terminal(*, outcome: str, error: str | None = None) -> None:
    payload: dict[str, Any] = {"type": "worker_terminal", "outcome": str(outcome or TERMINAL_RETRYABLE)}
    if error:
        payload["error"] = str(error)
    _emit(payload)


def main() -> int:
    raw_payload = sys.stdin.read()
    if not raw_payload:
        _emit_terminal(outcome=TERMINAL_NON_RETRYABLE, error="Subprocess worker received empty payload.")
        return 2

    try:
        payload = json.loads(raw_payload)
    except json.JSONDecodeError:
        _emit_terminal(outcome=TERMINAL_NON_RETRYABLE, error="Subprocess worker payload was invalid JSON.")
        return 2

    user_id = str(payload.get("user_id") or "")
    message = str(payload.get("message") or "")
    session_id = str(payload.get("session_id") or "")
    history = payload.get("conversation_history")
    if not isinstance(history, list):
        history = []

    client = HermesClient()
    saw_done = False
    try:
        for event in client.stream_events(
            user_id=user_id,
            message=message,
            conversation_history=history,
            session_id=session_id,
        ):
            if isinstance(event, dict):
                event_payload = dict(event)
                event_payload.setdefault("session_id", session_id)
                event_type = str(event_payload.get("type") or "")
                if event_type == "error":
                    _emit_terminal(
                        outcome=TERMINAL_RETRYABLE,
                        error=str(event_payload.get("error") or "Subprocess stream returned error event."),
                    )
                    return 10
                if event_type == "done":
                    saw_done = True
                _emit(event_payload)
    except Exception as exc:  # noqa: BLE001 - child process must serialize failures as stream error events
        _emit_terminal(outcome=TERMINAL_RETRYABLE, error=f"Subprocess stream failure: {exc}")
        return 10

    if saw_done:
        _emit_terminal(outcome=TERMINAL_SUCCESS)
        return 0

    _emit_terminal(outcome=TERMINAL_RETRYABLE, error="Subprocess stream ended without done event.")
    return 10



if __name__ == "__main__":
    raise SystemExit(main())
