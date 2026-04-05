from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Iterable

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import hermes_client


def _print_json(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, indent=2, sort_keys=True, default=str))


def _run_events(client: hermes_client.HermesClient, events: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    return [dict(event) for event in events]


def scenario_fallback_cascade() -> dict[str, Any]:
    client = hermes_client.HermesClient()
    client.direct_agent_enabled = True
    client.persistent_sessions_enabled = True
    client.set_spawn_trace_context(user_id="repro-user", chat_id=71, job_id=9910, session_id="miniapp-repro-71")

    def persistent_fail(**kwargs):
        raise RuntimeError("synthetic persistent failure")

    def direct_fail(**kwargs):
        raise hermes_client.HermesClientError("synthetic direct failure")

    client._stream_via_persistent_agent = persistent_fail  # type: ignore[assignment]
    client._stream_via_agent = direct_fail  # type: ignore[assignment]
    client._stream_via_cli_progress = lambda **kwargs: iter(  # type: ignore[assignment]
        [
            {"type": "meta", "source": "cli"},
            {"type": "chunk", "text": "cli-fallback-ok"},
            {"type": "done", "reply": "cli-fallback-ok", "source": "cli", "latency_ms": 1},
        ]
    )

    events = _run_events(client, client.stream_events(user_id="repro-user", message="trigger fallback", session_id="miniapp-repro-71"))
    return {
        "scenario": "fallback_cascade",
        "events": events,
        "children": client.child_spawn_diagnostics(),
    }


def scenario_resume_cross_chat() -> dict[str, Any]:
    client = hermes_client.HermesClient()
    client.direct_agent_enabled = False
    client.persistent_sessions_enabled = False
    client._stream_via_cli_progress = lambda **kwargs: iter(  # type: ignore[assignment]
        [
            {"type": "meta", "source": "cli"},
            {"type": "done", "reply": "ok", "source": "cli", "latency_ms": 1},
        ]
    )

    sessions = [
        ("miniapp-repro-1001", 1001, 5001),
        ("miniapp-repro-1002", 1002, 5002),
    ]
    event_log: list[dict[str, Any]] = []

    for session_id, chat_id, job_id in sessions:
        client.set_spawn_trace_context(user_id="repro-user", chat_id=chat_id, job_id=job_id, session_id=session_id)
        event_log.extend(_run_events(client, client.stream_events(user_id="repro-user", message="/resume", session_id=session_id)))

    return {
        "scenario": "resume_cross_chat",
        "events": event_log,
        "children": client.child_spawn_diagnostics(),
    }


def scenario_child_fanout(cap_per_job: int) -> dict[str, Any]:
    client = hermes_client.HermesClient()
    client.child_spawn_caps_enabled = True
    client.child_spawn_cap_per_job = max(1, int(cap_per_job))
    client.child_spawn_cap_total = max(4, int(cap_per_job) + 1)
    client.child_spawn_cap_per_chat = max(4, int(cap_per_job) + 1)
    client.child_spawn_cap_per_session = max(4, int(cap_per_job) + 1)

    client.set_spawn_trace_context(user_id="repro-user", chat_id=55, job_id=777, session_id="miniapp-repro-55")

    cap_error = None
    spawned_pids: list[int] = []
    for idx in range(1, int(cap_per_job) + 2):
        pid = 52000 + idx
        try:
            client.register_child_spawn(
                transport="agent-direct",
                pid=pid,
                command=["python", "worker.py", f"--child={idx}"],
                session_id="miniapp-repro-55",
            )
            spawned_pids.append(pid)
        except Exception as exc:  # noqa: BLE001 - intentional local repro script
            cap_error = f"{exc.__class__.__name__}: {exc}"
            break

    diagnostics = client.child_spawn_diagnostics()

    for active_pid in spawned_pids:
        client.deregister_child_spawn(pid=int(active_pid), outcome="cleanup", return_code=0)

    return {
        "scenario": "child_fanout",
        "cap_error": cap_error,
        "children_before_cleanup": diagnostics,
        "children_after_cleanup": client.child_spawn_diagnostics(),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Safe local reproduction helper for miniapp fan-out forensics signatures.")
    parser.add_argument(
        "--scenario",
        choices=["fallback_cascade", "resume_cross_chat", "child_fanout", "all"],
        default="all",
        help="Scenario to run.",
    )
    parser.add_argument("--cap-per-job", type=int, default=3, help="Per-job cap used in child_fanout scenario.")
    args = parser.parse_args()

    results: list[dict[str, Any]] = []

    if args.scenario in {"fallback_cascade", "all"}:
        results.append(scenario_fallback_cascade())
    if args.scenario in {"resume_cross_chat", "all"}:
        results.append(scenario_resume_cross_chat())
    if args.scenario in {"child_fanout", "all"}:
        results.append(scenario_child_fanout(cap_per_job=args.cap_per_job))

    _print_json({"ok": True, "results": results})


if __name__ == "__main__":
    main()
