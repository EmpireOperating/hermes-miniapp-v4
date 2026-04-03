# Miniapp Worker Isolation Runbook

Date: 2026-04-03

Purpose:
- Document subprocess worker isolation controls for chat job execution.
- Provide operator-facing guidance for configured OS-enforced limits.
- Define how to diagnose worker limit breaches from runtime status.

## Scope

This runbook applies when:
- `MINI_APP_JOB_WORKER_LAUNCHER=subprocess`

And covers the subprocess worker envelope used by:
- `job_runtime_worker_launcher.py`
- `chat_worker_subprocess.py`

## Isolation controls

Subprocess workers now run with a per-worker OS process boundary and rlimits on POSIX:

- Wall-time (launcher supervision):
  - `MINI_APP_JOB_WORKER_SUBPROCESS_TIMEOUT_SECONDS`
  - `MINI_APP_JOB_WORKER_SUBPROCESS_KILL_GRACE_SECONDS`
- Memory address space limit:
  - `MINI_APP_JOB_WORKER_SUBPROCESS_MEMORY_LIMIT_MB`
- Process/task cap:
  - `MINI_APP_JOB_WORKER_SUBPROCESS_MAX_TASKS`
- Open-file descriptor cap:
  - `MINI_APP_JOB_WORKER_SUBPROCESS_MAX_OPEN_FILES`
- Stderr forensic capture:
  - `MINI_APP_JOB_WORKER_SUBPROCESS_STDERR_EXCERPT_BYTES`

Defaults:
- timeout_seconds: 120
- kill_grace_seconds: 2 (config integer)
- memory_limit_mb: 1024
- max_tasks: 64
- max_open_files: 256
- stderr_excerpt_bytes: 4096

## Persistent runtime ownership model (A5)

Operator control:
- `MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP=auto|shared|checkpoint_only`

Resolution behavior:
- `auto` resolves to:
  - `checkpoint_only` when `MINI_APP_JOB_WORKER_LAUNCHER=subprocess`
  - `shared` otherwise
- `shared` under subprocess launcher is coerced to `checkpoint_only` for safety.

Operational meaning:
- `shared`: persistent in-process agent runtime ownership (legacy/default inline behavior).
- `checkpoint_only`: no shared persistent runtime ownership; continuity comes from checkpoint/history replay only.

## Runtime diagnostics visibility

`POST /api/runtime/status` includes:

- `runtime.incident_snapshot.workers.launcher`
  - `name`
  - `mode`
  - `isolation`
  - `limits.memory_mb`
  - `limits.max_tasks`
  - `limits.max_open_files`
  - `last_limit_breach`
  - `last_limit_breach_detail`
  - terminal/failure metadata (`last_failure_kind`, `last_terminal_outcome`, etc.)

- runtime routing/ownership signal:
  - `runtime.routing.persistent_sessions_requested`
  - `runtime.routing.persistent_sessions_enabled`
  - `runtime.routing.persistent_runtime_ownership`
  - `runtime.persistent_stats.requested`
  - `runtime.persistent_stats.enabled`
  - `runtime.persistent_stats.ownership`

- explicit isolation-boundary operator signal:
  - `runtime.isolation_boundary.active`
  - `runtime.isolation_boundary.enforced`
  - `runtime.isolation_boundary.reason`
  - mirrored under `runtime.incident_snapshot.workers` as:
    - `isolation_boundary`
    - `isolation_boundary_active`
    - `isolation_boundary_enforced`

- timeout concentration fields:
  - `runtime.child_timeouts`
  - `runtime.incident_snapshot.workers.child_timeout_total`
  - `runtime.incident_snapshot.workers.child_timeouts_by_job`
  - `runtime.incident_snapshot.workers.child_timeouts_by_chat`

## Limit breach attribution

Current launcher classifies probable limit hits from stderr/failure signature:

- memory:
  - stderr includes `MemoryError`, `cannot allocate memory`, or `out of memory`
  - or non-timeout `rc=-9` heuristic
- open_files:
  - stderr includes `Too many open files`
- tasks:
  - stderr includes `Resource temporarily unavailable` or `pthread_create`

The classification is surfaced as:
- `last_limit_breach`: `memory | open_files | tasks | null`
- `last_limit_breach_detail`: classifier reason code

## Operational response

1) Confirm isolation boundary is active/enforced
- Check `runtime.isolation_boundary.active == true`
- Check `runtime.incident_snapshot.workers.isolation_boundary_active == true`
- On POSIX deployments, check `...isolation_boundary_enforced == true`
- `runtime.isolation_boundary.reason` should report `process_boundary_with_posix_rlimits` when fully enforced.

2) Inspect latest failure metadata
- `last_terminal_outcome`
- `last_failure_kind`
- `last_return_code`
- `last_stderr_excerpt`
- `last_limit_breach`

3) Adjust limits based on observed breach
- memory breaches: increase `...MEMORY_LIMIT_MB`
- open-file breaches: increase `...MAX_OPEN_FILES`
- task/fork breaches: increase `...MAX_TASKS`

4) Re-validate
- Re-run failing scenario.
- Verify backend remains healthy and failures stay local to affected chat job.

## Confirmed trigger/fix mapping (Slice 3)

Confirmed trigger:
- During direct-agent saturation (`Hermes child spawn cap reached ...`), `stream_events()` previously attempted direct -> cli fallback.
- That extra fallback hop could launch another transport path under already-constrained conditions, amplifying fan-out pressure.

Minimal fix landed:
- If direct agent fails with child-spawn-cap error text, do not fallback to CLI.
- Emit transition attribution:
  - `previous_path=agent`
  - `next_path=agent`
  - `reason=direct_failure_no_cli_fallback:<ExceptionClass>`
- Re-raise the direct failure to keep failure local and avoid additional process launch attempts.

Verification:
- `tests/test_fanout_storm_forensics.py::test_forensics_signature_direct_spawn_cap_blocks_cli_fallback`
- Asserts CLI fallback is not invoked, the bounded transition reason is recorded, and no `agent -> cli direct_failure:*` transition is emitted for that run.

## Notes

- Limits are applied via `preexec_fn` + `resource.setrlimit(...)` on POSIX platforms.
- Non-POSIX platforms do not apply these rlimits through this mechanism.
- Worker terminal outcomes remain authoritative for retry vs non-retry mapping.
