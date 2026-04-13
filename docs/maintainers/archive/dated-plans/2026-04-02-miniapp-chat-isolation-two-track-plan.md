# Miniapp Chat Isolation + Fan-Out Forensics Two-Track Plan

> For Hermes: use subagent-driven-development or equivalent task-by-task execution. Do not treat this as an abstract design note; use it as the implementation and debugging handoff document.

Goal: preserve full Hermes CLI capability parity per miniapp chat, including delegation, while preventing any single chat or delegated subtree from crashing the shared miniapp backend.

Architecture summary:
- Track A adds containment boundaries so one chat/job cannot OOM-kill the whole web/backend service.
- Track B instruments and reproduces the existing fan-out storm so we can identify the precise spawning path and eliminate abnormal process amplification rather than merely surviving it.
- The intended destination is: each chat behaves like its own CLI session logically and operationally enough that a failure in one chat remains local to that chat.

Tech stack / components in scope:
- Flask miniapp backend (`server.py`, route modules)
- Job runtime / queue (`job_runtime.py`, `job_runtime_chat_job.py`, `store*.py`)
- Hermes execution adapters (`hermes_client.py`, `hermes_client_agent_persistent.py`, `hermes_client_agent_direct.py`, `hermes_client_cli.py`)
- Runtime/config diagnostics (`miniapp_config.py`, `routes_jobs_runtime.py`, `server_startup.py`)
- systemd service model for backend worker separation
- pytest + targeted runtime validation

Why we are doing this:
- The current miniapp backend keeps per-chat logical state, but active execution still shares one backend service cgroup.
- Evidence from the April 2 OOM incident showed low active chat/job concurrency but high child-process concurrency and unit-wide OOM.
- The current architecture is therefore “many desks in one apartment,” not “one apartment per chat.”
- We want full capability parity with CLI, so the fix must be isolation and attribution, not capability restriction.

Non-goals:
- Do not remove delegation from miniapp.
- Do not reduce agent capability below CLI parity unless the user explicitly asks.
- Do not do a speculative rewrite of the entire miniapp in one pass.
- Do not ship hidden policy changes without corresponding diagnostics proving why they exist.

---

## Problem statement in apartment terms

Current system:
- Web server, job runtime, persistent runtimes, direct-agent subprocesses, and delegated subprocess trees all live inside one apartment.
- Each chat has its own notebook and desk (`session_id`, history, checkpoint), but they still share one breaker box (same backend service memory/task/fd budget).
- One chat can trigger a power surge (fan-out storm) that flips the breaker for everyone (OOM-kill of `hermes-miniapp-v4.service`).

Track A target:
- Put each active chat turn into its own apartment or at least its own isolated work unit with its own breaker limits.
- A local surge should trip only that unit, not the whole building.

Track B target:
- Figure out which appliance is actually causing the surge:
  - duplicate runners?
  - fallback loops?
  - delegated subagents?
  - subprocess cleanup leaks?
  - chat resume/retry interaction?

---

## Ground truth from current code

Relevant current behavior:
- `server.py` creates one `HermesClient()` and one `JobRuntime(...)` for the entire service.
- `server.py:_session_id_for(user_id, chat_id)` maps each chat to `miniapp-{user_id}-{chat_id}`.
- `job_runtime_chat_job.py` uses `runtime.session_id_builder(user_id, chat_id)` and `runtime.client.stream_events(...)` to execute a chat turn.
- `HermesClient` maintains a process-local `PersistentSessionManager`, so persistent chat state is in-memory within the shared backend process.
- `job_worker_concurrency` controls shared thread concurrency, not per-chat process isolation.
- `hermes_client_agent_direct.py` and `hermes_client_cli.py` can spawn subprocesses; delegated subagents can create additional subprocess trees underneath those runners.
- Current child-spawn caps are a guardrail, not a real chat-isolation boundary.

Operational implications:
- Chats are logically separated, but execution resources are not.
- One chat’s delegated subtree can consume shared cgroup memory/tasks/fds.
- OOM attribution to the service main PID does not mean the main PID itself is the leak; child aggregate usage can dominate.

---

## Two-track execution strategy

Run these tracks in parallel where possible, but do not merge Track A’s high-risk execution changes without Track B instrumentation support.

- Track A = containment architecture
- Track B = root-cause forensics

Minimum rule:
- Track A may ship in phases.
- Track B must start immediately so every recurrence after Track A produces attributable evidence instead of another opaque OOM snapshot.

---

# Track A — Containment Architecture Refactor

Objective: make it impossible for one chat’s heavy execution or delegated subtree to take down the shared miniapp web/backend process.

Design principle:
- Preserve current chat/session semantics and UI behavior.
- Move heavy agent execution out of the shared Flask service fault domain.
- Treat the web app as an orchestrator and stream relay, not the same process that performs all heavy agent work.

Desired end-state:
1. Thin web/orchestrator backend remains responsive even if a chat worker dies.
2. Active chat turns run in isolated worker envelopes.
3. Per-worker limits enforce local failure instead of app-wide failure.
4. Streaming/tool updates still arrive in the same frontend contract.
5. Chat history/checkpoint semantics stay compatible with existing UI and DB.

## Track A Phase map

### Phase A1: Separate orchestration from execution without changing user-visible behavior

Objective: stop running heavy agent execution directly inside the Flask/backend service process.

Files to inspect first:
- `server.py`
- `app_factory.py`
- `job_runtime.py`
- `job_runtime_chat_job.py`
- `hermes_client.py`
- `hermes_client_agent_persistent.py`
- `hermes_client_agent_direct.py`
- `hermes_client_cli.py`
- `routes_chat_stream.py`
- `routes_jobs_runtime.py`

Proposed change:
- Introduce an execution-worker boundary so `JobRuntime` submits chat-turn execution to a separate worker process boundary instead of executing the full agent stack inside the shared backend process.
- Keep the current `chat_jobs` DB model and SSE event model intact initially.
- The web/backend service should own:
  - auth
  - HTTP/SSE endpoints
  - chat/job DB state
  - event relay / status
  - worker scheduling
- The worker side should own:
  - `HermesClient.stream_events(...)`
  - direct/persistent/CLI execution path
  - delegated subprocess trees

Implementation options allowed in this phase:
- Local worker subprocess model launched per claimed job.
- Separate Python entrypoint (recommended) for isolated chat-runner worker.
- systemd transient units or subprocess + cgroup wrapper if practical.

Do not do in A1:
- Do not redesign the frontend protocol.
- Do not rewrite chat history/checkpoint semantics.
- Do not optimize for multi-turn warm persistence yet beyond preserving current behavior where feasible.

Acceptance criteria:
- Flask backend can stay alive if a chat runner worker exits nonzero or OOMs.
- A chat failure becomes a local dead-letter/system message, not service outage.
- Existing `/api/chat/stream` and `/api/chat/stream/resume` behavior remains compatible.

Suggested implementation tasks:

#### Task A1.1: Create isolated chat-runner entrypoint

Objective: provide a dedicated executable/entrypoint for one claimed chat job.

Files:
- Create: `chat_worker_runner.py`
- Test: `tests/test_chat_worker_runner.py`

Requirements:
- Accept job identity + DB path + config/env context.
- Load/store via existing `SessionStore` against `sessions.db`.
- Reconstruct execution context needed to run one chat turn.
- Publish events back through the existing DB/event mechanisms or a worker->parent relay channel.
- Exit cleanly with explicit status codes for:
  - success
  - retryable failure
  - non-retryable failure
  - timeout / killed

Verification:
- isolated unit test that one worker run can process a synthetic job and exit 0.
- isolated unit test that an injected failure exits nonzero and leaves the parent/backend process unaffected.

#### Task A1.2: Add worker launcher abstraction to runtime

Objective: replace in-process heavy execution with launch/monitor logic.

Files:
- Modify: `job_runtime.py`
- Possibly create: `job_runtime_worker_launcher.py`
- Test: `tests/test_job_runtime_worker_launcher.py`

Requirements:
- Runtime should claim jobs as before.
- Instead of fully executing the chat turn in the backend thread, runtime should launch isolated runner process for the claimed job.
- Runtime should track worker PID / launch metadata / start time.
- Runtime should map worker exit outcomes to job transitions.
- Duplicate-runner protection must still apply.

Verification:
- runtime test for one claimed job -> one worker launch.
- runtime test for duplicate launch suppression.
- runtime test for worker failure -> dead-letter/retry path without crashing runtime thread.

#### Task A1.3: Keep SSE stream contract stable

Objective: preserve frontend behavior while execution moves out of process.

Files:
- Modify: `routes_chat_stream.py`
- Modify: `job_runtime.py`
- Possibly create: `job_runtime_event_relay.py`
- Test: `tests/test_routes_chat_stream.py`, `tests/test_routes_jobs_runtime.py`

Requirements:
- `meta`, `tool`, `chunk`, `done`, `error` event semantics stay compatible.
- Resume logic still works when the actual worker is external to the backend thread.
- Event buffering/history still serves reconnect/resume clients.

Verification:
- existing stream tests still pass or are updated with equivalent behavior guarantees.
- manual smoke: one turn streams tools/chunks/done normally after architecture split.

### Phase A2: Add per-worker resource boundaries

Objective: make isolated workers enforce local limits.

Files:
- Modify: worker launcher / worker entrypoint / systemd or subprocess wrapper implementation
- Create/modify docs: `docs/maintainers/runbooks/miniapp-worker-isolation-runbook.md`
- Test: targeted runtime tests, plus ops verification steps

Requirements:
- Enforce per-worker limits for at least:
  - memory
  - tasks/process count
  - open files
  - optional wall clock timeout
- Parent backend must capture and classify worker limit failures.
- Limit failures must surface as local chat failures with operator-readable diagnostics.

Preferred implementation if feasible:
- per-worker cgroup / transient systemd scope / equivalent OS-level boundary
- do not rely on Python-only accounting for memory isolation

Acceptance criteria:
- One worker can OOM or hit task cap without killing the web/backend service.
- The parent can report that as a local worker failure.

### Phase A3: Restore or redesign warm-per-chat persistence safely

Objective: decide whether “persistent runtime per chat” remains in-process, moves to isolated workers, or is replaced with checkpoint-only continuity.

Files:
- `hermes_client.py`
- `hermes_client_agent_persistent.py`
- `hermes_client_types.py`
- `job_runtime_chat_job.py`
- tests in `tests/test_hermes_client.py`, `tests/test_job_runtime_chat_job.py`

Decision to make explicitly:
- Option A: keep warm persistence only inside isolated worker ownership.
- Option B: drop in-memory warm agent reuse and rely on checkpoints/history replay until safe isolation is complete.
- Option C: hybrid, where a per-chat worker can survive across turns but is still outside the shared web service.

Rule:
- Do not keep shared-backend-process persistent runtimes if the goal is true per-chat isolation.

Acceptance criteria:
- chat continuity remains coherent across turns.
- warm reuse, if retained, cannot reintroduce shared-failure coupling.

### Phase A4: Make runtime status reflect isolation model

Objective: operator diagnostics must show whether isolation is actually active.

Files:
- `routes_jobs_runtime.py`
- `job_runtime.py`
- `server_startup.py`
- `tests/test_routes_jobs_runtime.py`

Add diagnostics for:
- execution mode: in-process vs isolated-worker
- active workers by chat/job
- worker PID/scope metadata
- worker limit config
- worker exit classification counters
- per-chat active execution count

Acceptance criteria:
- `/api/runtime/status` clearly shows whether isolation is live.
- operator can tell whether a failure happened in backend orchestration or chat worker.

---

# Track B — Fan-Out Storm Forensics and Root-Cause Elimination

Objective: identify the exact path causing abnormal child-process fan-out so we can fix the storm itself, not only contain it.

Design principle:
- After containment, every recurrence should be attributable to one job, one chat, one transport path, and one child lineage tree.
- We are not done when the app survives; we are done when we know why storms happen.

Primary hypotheses to test:
1. Delegation/subagent fan-out inside one chat turn.
2. Duplicate runners for the same job/session causing overlapping execution trees.
3. Persistent->direct->CLI fallback cascades causing redundant concurrent runners.
4. Resume/reopen logic causing repeated launches for the same still-open turn.
5. Child cleanup failure leaving subprocesses alive after parent paths exit.
6. Tool/terminal usage inside a single agent turn creating unexpectedly large subprocess forests.
7. Retry/dead-letter/claim lifecycle bugs creating overlapping execution attempts.

## Track B Phase map

### Phase B1: Add spawn-lineage instrumentation that is impossible to miss

Objective: every child spawn must be attributable in logs and runtime status.

Files:
- `hermes_client.py`
- `hermes_client_agent_direct.py`
- `hermes_client_cli.py`
- `job_runtime_chat_job.py`
- `job_runtime.py`
- `routes_jobs_runtime.py`
- tests: `tests/test_hermes_client.py`, `tests/test_routes_jobs_runtime.py`

Current starting point:
- some child spawn tracking already exists
- but logs during the incident did not provide enough operational attribution

Required additions:
- Plain-text log lines for every spawn and finish containing at minimum:
  - job_id
  - chat_id
  - session_id
  - transport path (`agent-persistent`, `agent-direct`, `cli-stream`, `cli-quiet`, delegated path if discoverable)
  - pid / ppid if available
  - launch timestamp
  - completion outcome
  - active counts after spawn/deregister
- Snapshot of lineage ancestry if a child itself spawns more children.
- Distinguish direct child of backend-runner vs grandchild/subagent tree.

Acceptance criteria:
- A future OOM incident can be reconstructed from logs without guessing.

### Phase B2: Add per-job and per-chat fan-out telemetry windows

Objective: runtime status should answer “which chat is exploding?” immediately.

Files:
- `job_runtime.py`
- `routes_jobs_runtime.py`
- tests: `tests/test_routes_jobs_runtime.py`

Add diagnostics for:
- current active child count per job
- current active child count per chat
- high-water marks per job/chat in rolling windows
- recent top N jobs/chats by child fan-out
- recent top N jobs/chats by terminal subprocess count
- recent limit hits / duplicate-runner rejects / cleanup-kill counts by chat

Acceptance criteria:
- `/api/runtime/status` can identify the hottest chat/job without reading raw journals.

### Phase B3: Add transport/fallback attribution

Objective: prove whether storms come from one execution path or fallback cascades.

Files:
- `hermes_client.py`
- `hermes_client_agent_persistent.py`
- `hermes_client_agent_direct.py`
- `hermes_client_cli.py`
- tests: `tests/test_hermes_client.py`

Requirements:
- Log one structured+plain text line whenever execution path changes:
  - persistent start
  - persistent failure -> direct fallback
  - direct failure -> cli fallback
  - retry / resume relaunch
- Include prior path, next path, session_id, chat_id, job_id, reason.
- Ensure these events are visible in default journald output, not just structured extras.

Acceptance criteria:
- We can tell whether one user prompt created one worker tree or a cascade of fallback trees.

### Phase B4: Build reproducible load/chaos scenarios

Objective: create deterministic tests and scripts that can trigger the suspected storm classes safely.

Files:
- Create: `tests/test_fanout_storm_forensics.py`
- Create: `scripts/repro_fanout_storm.py`
- Possibly create fixtures under `tests/fixtures/`

Scenarios to cover:
1. one chat asks for broad repo sweep likely to use delegation
2. two chats resume simultaneously
3. persistent runtime fails mid-turn and falls back
4. duplicate resume/claim races on one open turn
5. child cleanup path leaves descendants alive

Rule:
- These can start as synthetic/unit tests with monkeypatched `AIAgent` / subprocess trees.
- Add one operator runbook command sequence for safe live reproduction on local sandbox only.

Acceptance criteria:
- We can reproduce at least one abnormal fan-out signature in test or scripted form.

### Phase B5: Eliminate the confirmed storm trigger(s)

Objective: after instrumentation and reproduction, patch the actual spawning bug(s).

Do not implement until B1-B4 give evidence.

Possible outcomes:
- If storms are from duplicate job execution -> tighten job ownership / claim fencing.
- If storms are from persistent fallback overlap -> ensure old path is cancelled before next path launches.
- If storms are from delegated subagents surviving parent completion -> fix cleanup / process group kill behavior.
- If storms are from terminal tool subprocess trees -> add descendant cleanup or job-scoped process groups.
- If storms are from resume loops -> harden resume/auto-recovery dedupe.

Acceptance criteria:
- Targeted reproduction no longer produces abnormal fan-out.
- Runtime status high-water marks remain bounded under the repro.

---

# Dependency relationship between tracks

Track A can begin immediately.
Track B must begin immediately.

Recommended order:
1. B1 + B2 first (fast observability uplift)
2. A1 next (separate orchestration from execution)
3. A2 next (enforce per-worker limits)
4. B3 + B4 next (high-quality root-cause reproduction)
5. B5 once evidence is strong
6. A3 only after we understand whether warm persistence should live inside isolated worker ownership
7. A4 to finalize operator visibility

Why this order:
- B1/B2 make the architecture migration observable.
- A1/A2 reduce risk while B3-B5 proceed.
- A3 is the place where we should be careful not to rebuild the same coupling in a new shape.

---

# Detailed task checklist

## Track A checklist

### Task A0: Capture current baseline before changes

Objective: preserve pre-refactor facts for comparison.

Files:
- Create/update: `docs/maintainers/runbooks/miniapp-child-spawn-hardening-runbook.md`
- Create: `docs/maintainers/archive/dated-plans/2026-04-02-miniapp-chat-isolation-two-track-plan.md` (this file)

Record:
- current service topology
- current env settings
- current runtime counters available
- known incident facts from April 2 OOM

Verification:
- baseline facts exist in docs before code changes progress.

### Task A1: Introduce isolated chat-runner entrypoint
- Write failing tests for launching one chat-runner process and recording outcome.
- Create `chat_worker_runner.py`.
- Run targeted tests.
- Commit.

### Task A2: Add worker launcher abstraction to runtime
- Write failing tests for runtime -> worker launch path.
- Extract launch logic from in-process execution path.
- Make runtime supervise worker lifecycle.
- Run tests.
- Commit.

### Task A3: Preserve event stream contract
- Write/update tests for `meta/tool/chunk/done` continuity during isolated execution.
- Keep resume/history semantics stable.
- Run route/runtime tests.
- Commit.

### Task A4: Apply per-worker limits
- Decide implementation: systemd scope / cgroup wrapper / equivalent.
- Add explicit limit config.
- Add failure classification tests if practical.
- Add runbook verification steps.
- Commit.

### Task A5: Decide persistent-runtime ownership model
- Design note + tests first.
- Either remove shared-process persistence or move it into isolated worker ownership.
- Run continuity tests.
- Commit.

### Task A6: Add runtime status visibility for isolation
- Extend `/api/runtime/status`.
- Add tests.
