# Miniapp Two-Track Plan — Implementation Status and Next Slices

Linked primary plan:
- `docs/maintainers/archive/dated-plans/2026-04-02-miniapp-chat-isolation-two-track-plan.md`

Primary remaining-work checklist:
- `docs/maintainers/archive/dated-plans/2026-04-03-miniapp-backend-swap-updated-todo-checklist.md`

Warm-session ownership decision:
- `docs/maintainers/archive/dated-plans/2026-04-03-miniapp-warm-session-ownership-decision.md`

Purpose:
- Provide an at-a-glance implementation checkpoint for any agent picking up work.
- Mark strict status for Track A / Track B tasks.
- Define the next concrete implementation slices to reach true per-chat containment.

Date:
- 2026-04-03

---

## Status Legend

- Done: implemented and validated in code/tests.
- Partial: scaffolding/hardening exists, but target architecture/outcome not fully complete.
- Not started: no meaningful implementation toward the planned acceptance criteria.

---

## Track A — Containment Architecture Refactor

### A0: Baseline capture before changes
Status: Done
Evidence:
- `docs/maintainers/runbooks/miniapp-child-spawn-hardening-runbook.md` exists and documents incident class, controls, and diagnostics.

### A1: Isolated chat-runner entrypoint
Status: Partial
Evidence:
- `chat_worker_runner.py` exists as an explicit boundary.
Gap to close:
- Runner is currently mostly a behavior-preserving wrapper; full standalone one-job worker contract (with explicit outcome classes/status codes) is not complete.

### A2: Worker launcher abstraction in runtime
Status: Partial
Evidence:
- `job_runtime_worker_launcher.py` added.
- Runtime wired to launcher in `job_runtime.py` and `app_factory.py`.
- Config supports `MINI_APP_JOB_WORKER_LAUNCHER` = `inline|subprocess`.
Gap to close:
- Subprocess path is present, but not yet a complete per-chat fault-domain boundary for full claimed-turn lifecycle ownership.

### A3: Preserve SSE/event contract while execution splits
Status: Partial (major live regression now closed)
Evidence:
- Existing streaming/runtime tests remain green with launcher abstraction in place.
- First-turn queue/SSE handoff bug was fixed so the original stream now publishes a normal terminal `done` before job completion instead of falling back to synthetic terminal DB recovery.
- Live API and browser QA both verified that first and later turns return the UI/stream to a clean completed state.
Gap to close:
- Still needs broader reconnect/tab-switch/multi-chat sign-off, not just the bounded warm-owner path.

### A4: Add per-worker OS-enforced resource boundaries
Status: Partial
Evidence:
- Subprocess worker launcher now applies POSIX `setrlimit` hard limits for memory/tasks/open-files (RLIMIT_AS/RLIMIT_NPROC/RLIMIT_NOFILE).
Gap to close:
- Current enforcement is POSIX rlimit-based; no cgroup/systemd transient scope integration yet.

### A5: Persistent-runtime ownership decision and implementation
Status: Done
Evidence:
- `miniapp_config.py` now defines explicit `persistent_runtime_ownership` (`auto|shared|checkpoint_only`) with resolver semantics.
- Final decision implemented:
  - subprocess worker launcher enforces checkpoint-only continuity ownership;
  - inline launcher keeps shared ownership by default.
- `server.py` now publishes resolved ownership into Hermes client env via `MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP` before client creation.
- `hermes_client.py` now reports explicit ownership and requested-vs-enabled split in diagnostics:
  - `runtime.routing.persistent_sessions_requested`
  - `runtime.routing.persistent_runtime_ownership`
  - `runtime.persistent_stats.{requested,enabled,ownership}`
- Tests added/updated across config, client behavior, and startup diagnostics.

### A6: Runtime status reflects true isolation model
Status: Done
Evidence:
- Runtime diagnostics now expose explicit isolation-boundary operator signal:
  - `runtime.isolation_boundary.{active,enforced,reason}`
  - mirrored under `runtime.incident_snapshot.workers` as:
    - `isolation_boundary`
    - `isolation_boundary_active`
    - `isolation_boundary_enforced`
- Tests cover both default inline (`active=false`) and subprocess (`active=true`, `enforced` platform-aware).

---

## Track B — Fan-Out Storm Forensics and Root-Cause Elimination

### B1: Spawn-lineage instrumentation
Status: Done
Evidence:
- Plain-text logs in `hermes_client.py` for spawn/finish/transport transitions:
  - `Miniapp Hermes child spawned`
  - `Miniapp Hermes child finished`
  - `Miniapp Hermes transport transition`

### B2: Per-job/per-chat fan-out telemetry windows
Status: Done
Evidence:
- Child counters/high-water and per-chat/per-job diagnostics surfaced via runtime diagnostics.

### B3: Transport/fallback attribution
Status: Done
Evidence:
- Transition recording implemented and exposed in `recent_transport_transitions`.
- Runtime diagnostics now expose active job snapshots with per-session filtered `recent_transport_transitions` under `incident_snapshot.workers.active_jobs`.
- Tests include persistent→direct→cli and resume relaunch attribution signatures.

### B4: Reproducible forensics scenarios
Status: Done
Evidence:
- `tests/test_fanout_storm_forensics.py`
- `scripts/repro_fanout_storm.py`

### B5: Eliminate confirmed trigger(s) with regression lock
Status: Done
Evidence:
- Confirmed trigger: direct-agent spawn-cap failures (`Hermes child spawn cap reached ...`) previously cascaded to direct -> cli fallback in `stream_events()`, creating an extra launch hop under saturation.
- Minimal fix landed in `hermes_client.py`: block CLI fallback for spawn-cap direct failures, emit bounded attribution reason `direct_failure_no_cli_fallback:*`, and re-raise direct error.
- Regression lock added:
  - `tests/test_fanout_storm_forensics.py::test_forensics_signature_direct_spawn_cap_blocks_cli_fallback`
- Runbook updated with trigger/fix/verification mapping:
  - `docs/maintainers/runbooks/miniapp-worker-isolation-runbook.md`

---

## Current Validation Snapshot

Latest expanded backend-swap sign-off pass:

Python targeted tests:
- `tests/test_job_runtime_chat_job.py`
- `tests/test_routes_chat.py`
- `tests/test_routes_jobs_runtime.py`
- `tests/test_job_runtime_worker_launcher.py`
- `tests/test_hermes_client.py`
- `tests/test_fanout_storm_forensics.py`
- `tests/test_streaming_hardening_guards.py`

Result observed:
- `214 passed in 13.20s`

Frontend/runtime targeted tests:
- `tests/chat_history_helpers.test.mjs`
- `tests/stream_controller.test.mjs`
- `tests/visibility_skin_helpers.test.mjs`
- `tests/bootstrap_auth_helpers.test.mjs`
- `tests/frontend_runtime.test.mjs`

Result observed:
- `75 passed`

Notable regression coverage now explicitly includes:
- first-turn queue/SSE `done` handoff
- second-turn same-worker continuity
- attach-contract refresh before attached terminal `done`
- stale history response suppression during active-chat changes
- reconnect/replay cursor behavior across resumed streams
- active-chat visibility reconciliation
- same-chat conflict rejection without blocking a different chat from starting its own stream

Additional live validation is captured in:
- `docs/maintainers/archive/dated-plans/2026-04-04-miniapp-worker-owned-warm-continuity-qa-checklist.md`

That live validation covered:
- first-turn queue/SSE `done` handoff
- second-turn same-worker continuity
- attach-contract refresh before attached terminal `done`
- browser UI recovery from `Sending…` / running back to normal send-ready state

---

## Next Implementation Slices (Execution Plan)

### Slice 1 (highest priority): Make subprocess launcher a full isolated execution unit for one claimed turn
Goal:
- Complete A1/A2 boundary so subprocess worker owns one claimed attempt outcome contract, not only stream delegation.

Implementation checkpoint (2026-04-03, in progress -> landed for outcome contract + provenance guard):
- Added explicit subprocess worker terminal outcomes:
  - `success`
  - `retryable_failure`
  - `non_retryable_failure`
  - `timeout_killed` (inferred by parent on timeout/kill)
- Child worker now emits `worker_terminal` envelope events.
- Parent launcher captures terminal outcome/error, exposes in launcher diagnostics, and maps deterministically to retryable/non-retryable runtime errors.
- Added stream provenance hardening in `execute_chat_job(...)`:
  - reject stream events when `session_id` mismatches the claimed chat session,
  - reject stream events when `chat_id` is present and mismatches the claimed chat.
- Subprocess child now stamps `session_id` onto emitted stream events, enabling end-to-end provenance checks in parent runtime path.
- Added tests for outcome parsing + mapping + remap behavior when runner raises retryable but terminal outcome is non-retryable.
- Added regression tests ensuring mismatched session/chat stream events are rejected as retryable failures (no cross-chat assistant write).
- Added `tests/test_chat_worker_runner.py` for explicit runner boundary coverage.

Primary files:
- `chat_worker_subprocess.py`
- `job_runtime_worker_launcher.py`
- `chat_worker_runner.py`
- `job_runtime.py`
- `tests/test_job_runtime_worker_launcher.py`
- `tests/test_routes_jobs_runtime.py`
- Add `tests/test_chat_worker_runner.py`

Required outcomes:
- Explicit terminal classes: success, retryable failure, non-retryable failure, timeout/killed.
- Parent runtime deterministic mapping from worker outcome -> retry/dead-letter transitions.
- Backend remains alive when worker exits non-zero or is killed.

### Slice 2: Add OS-enforced per-worker limits
Goal:
- Deliver local failure boundaries with real process limits.

Implementation checkpoint (2026-04-03, landed):
- Added subprocess worker limit config/env knobs:
  - `MINI_APP_JOB_WORKER_SUBPROCESS_MEMORY_LIMIT_MB`
  - `MINI_APP_JOB_WORKER_SUBPROCESS_MAX_TASKS`
  - `MINI_APP_JOB_WORKER_SUBPROCESS_MAX_OPEN_FILES`
  - (existing wall-time controls retained)
- Added POSIX `setrlimit` pre-exec boundary for subprocess workers:
  - RLIMIT_AS (memory)
  - RLIMIT_NPROC (tasks)
  - RLIMIT_NOFILE (open files)
- Exposed configured limits and latest breach attribution in launcher diagnostics:
  - `limits.{memory_mb,max_tasks,max_open_files}`
  - `last_limit_breach`
  - `last_limit_breach_detail`
- Added runtime diagnostics tests that assert launcher limits and limit-breach fields are visible under `incident_snapshot.workers.launcher`.
- Added runbook:
  - `docs/maintainers/runbooks/miniapp-worker-isolation-runbook.md`

Primary files:
- `job_runtime_worker_launcher.py`
- `miniapp_config.py`
- `app_factory.py`
- `server.py`
- `docs/maintainers/runbooks/miniapp-worker-isolation-runbook.md`
- `tests/test_config.py`
- `tests/test_routes_jobs_runtime.py`
- `tests/test_job_runtime_worker_launcher.py`

Required outcomes:
- Configurable limits for memory/tasks/open-files/wall-time.
- Limit-hit classification visible in runtime diagnostics.
- Worker limit breach fails local chat turn, backend remains healthy.

### Slice 3: Close B5 with one confirmed trigger + regression lock
Goal:
- Finish root-cause loop: confirmed trigger -> minimal fix -> regression test.

Implementation checkpoint (2026-04-03, landed):
- Confirmed trigger in `hermes_client.py` transport logic:
  - direct-agent spawn-cap failures (`Hermes child spawn cap reached ...`) still attempted direct -> cli fallback.
  - This created an unnecessary extra launch hop under saturation pressure.
- Minimal fix landed:
  - block CLI fallback for spawn-cap direct failures,
  - emit bounded transition attribution `direct_failure_no_cli_fallback:*`,
  - re-raise direct failure locally.
- Regression lock added in:
  - `tests/test_fanout_storm_forensics.py::test_forensics_signature_direct_spawn_cap_blocks_cli_fallback`
- Runbook updated with trigger/fix/verification mapping:
  - `docs/maintainers/runbooks/miniapp-worker-isolation-runbook.md`

Primary files:
- `hermes_client.py`
- `tests/test_fanout_storm_forensics.py`
- `docs/maintainers/runbooks/miniapp-worker-isolation-runbook.md`

Required outcomes:
- Previously abnormal repro signature is bounded or absent after fix.
- Regression test prevents reintroduction.
- Runbook updated with trigger/fix/verification mapping.

Recommended order:
1. Slice 1
2. Slice 2
3. Slice 3

---

## Practical completion gate for Track A sign-off

Track A is considered complete only when all are true:
1. One chat can fail/timeout/oom at worker level without taking down web/backend service.
2. Worker boundary is active by architecture default for production mode (or explicitly operator-selected with clear status).
3. Per-worker resource limits are OS-enforced and observable.
4. Runtime status clearly indicates isolation mode and worker failure attribution.
5. Streaming/resume contract remains UI-compatible.

---

## Handoff note for next agents

Do not treat current state as finished containment.
- Forensics instrumentation is in strong shape.
- Containment has good scaffolding but still needs true worker isolation and resource-boundary enforcement.
- Avoid capability reductions as a substitute for isolation.
