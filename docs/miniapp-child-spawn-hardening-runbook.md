# Miniapp Child Spawn Hardening Runbook

Purpose
- Prevent and quickly diagnose incident class: runaway miniapp child subprocesses causing FD exhaustion, OOM kills, and cross-chat instability.

Applies to
- `hermes_client.py`
- `hermes_client_cli.py`
- `hermes_client_agent_direct.py`
- `job_runtime.py`
- `hermes_client_agent_persistent.py`

What is hardened
1) Single active runner per job
- Runtime blocks duplicate concurrent runners for the same `job_id`.
- Counter: `duplicate_runner_reject`.

2) Child spawn caps (fail-fast)
- Global cap
- Per-chat cap
- Per-job cap
- Per-session cap
- On cap hit, spawn is rejected with a clean error (no flailing retries/spawn storms).

3) Aggressive child cleanup on terminal paths
- On stale timeout dead-letter, non-retryable dead, retryable error, stale chat dead, and unexpected dead paths, runtime attempts tracked child termination by `job_id`.

4) Spawn lineage + counters
- Each child spawn/exit logs lineage context (job/chat/session/transport/pid) and active counts.
- Runtime diagnostics expose active child counters and cap config.

5) Transport/fallback transition attribution
- Every transport hop logs a structured transition record with `previous_path`, `next_path`, `reason`, and lineage ids.
- Includes key paths:
  - persistent start
  - persistent failure -> direct fallback
  - direct failure -> CLI fallback
  - retry/relaunch and `/resume` relaunch markers
- Runtime diagnostics expose recent transport transitions for incident triage.

Environment controls
- `MINI_APP_CHILD_SPAWN_CAPS_ENABLED` (default: `1`; set to `0` only for emergency rollback/debugging)
- `MINI_APP_CHILD_SPAWN_CAP_TOTAL` (default: `16`)
- `MINI_APP_CHILD_SPAWN_CAP_PER_CHAT` (default: `4`)
- `MINI_APP_CHILD_SPAWN_CAP_PER_JOB` (default: `1`)
- `MINI_APP_CHILD_SPAWN_CAP_PER_SESSION` (default: `2`)

Recommended defaults
- Keep `PER_JOB=1` (critical anti-duplicate safeguard).
- Raise total/chat/session only if legitimate concurrency pressure appears.

When users report slowdown/failures again
1) Check service health
```bash
systemctl --user status hermes-miniapp-v4.service
journalctl --user -u hermes-miniapp-v4.service -n 200 --no-pager
```

2) Check runtime diagnostics
- `POST /api/runtime/status` (authenticated)
- Inspect:
  - `runtime.children.active_total`
  - `runtime.children.active_by_job`
  - `runtime.children.active_by_chat`
  - `runtime.children.caps`
  - `runtime.runtime_counters.duplicate_runner_reject`
  - `runtime.children.recent_transport_transitions`

3) Check logs for lineage
- Search for:
  - `Miniapp Hermes child spawned`
  - `Miniapp Hermes child finished`
  - `Miniapp Hermes child cleanup summary`
  - `job_child_cleanup_failed`
  - `Miniapp Hermes transport transition`

4) If cap pressure is real (not runaway)
- Increase headroom incrementally, restart service, re-test:
  - total: +8 or +16
  - per_chat: +2 or +4
  - per_session: +1 or +2
- Keep per_job at 1 unless there is a deliberate architecture change.

5) If failures persist despite normal counts
- Correlate failing `job_id/chat_id` with child lineage logs to isolate the exact path (timeout_kill, cleanup_kill, nonzero_exit, etc.).

6) Run deterministic local repro signatures (safe sandbox only)
```bash
source /home/hermes-agent/.hermes/hermes-agent/venv/bin/activate
cd /home/hermes-agent/workspace/active/hermes_miniapp_v4
python scripts/repro_fanout_storm.py --scenario all
```
- Scenarios emitted:
  - `fallback_cascade` (persistent -> direct -> cli transition chain)
  - `resume_cross_chat` (multi-chat `/resume` relaunch signatures)
  - `child_fanout` (single-job fan-out hotspot + cap-hit signature)
- Output includes event stream samples and `runtime.children`-style diagnostics payloads.

7) Regression tests for forensics signatures
```bash
source /home/hermes-agent/.hermes/hermes-agent/venv/bin/activate
cd /home/hermes-agent/workspace/active/hermes_miniapp_v4
python -m pytest -q tests/test_fanout_storm_forensics.py
```

Operational notes
- These caps are not a global ban on parallel usage; they are guardrails around miniapp child subprocess fan-out.
- Parallel work across different jobs/chats/sessions still works within configured caps.

Quick restart after env changes
```bash
systemctl --user restart hermes-miniapp-v4.service
systemctl --user is-active hermes-miniapp-v4.service
```