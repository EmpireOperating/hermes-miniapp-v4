# Miniapp Isolated Warm Worker Reuse Plan

> For Hermes: implement this from the current miniapp codebase, preserving behavior by default and hiding real reuse behind an explicit feature flag until validation is complete.

Goal: Keep the backend isolation win while reducing the cost of repeated cold worker boots so the miniapp can support more simultaneous chats with less queue pressure.

Architecture: Add same-chat isolated warm-worker reuse first, not cross-chat pooling. Keep subprocess isolation, but let one chat reattach to its own warm worker across turns when the worker is idle, healthy, and within TTL. Preserve the current cold-spawn path as the default-safe fallback and as the runtime fallback whenever attach/reuse checks fail.

Tech Stack: Flask miniapp backend, subprocess worker launcher, HermesClient / warm-session scaffolding, SSE stream/resume routes, SQLite-backed store, pytest + node tests.

---

## Product decision this plan implements

Current state:
- backend swap improved isolation and failure boundaries
- each active run still cold-boots a full Hermes subprocess + AIAgent
- concurrency therefore hits queue pressure earlier than desired

Target state for this plan:
- preserve one-chat/one-isolated-worker semantics
- reduce repeated bootstrap cost for the same chat
- do not reintroduce shared mutable runtime state across chats

This plan deliberately chooses:
- same-chat warm reuse first
- no cross-chat worker sharing yet
- no pool scheduler yet
- no rollback to shared backend warm ownership

---

## Success criteria

We are done with this slice only when all of the following are true:
- a repeated prompt in the same chat can reuse a warm isolated worker when the feature flag is on
- a different chat does not attach to that worker
- if reuse cannot be proven safe, the system falls back to current cold spawn automatically
- stream behavior remains correct for tool events, assistant output, done/error, and reconnect/resume
- worker lifecycle, attach attempts, and fallback reasons are visible in diagnostics
- idle workers are reaped automatically
- current default behavior remains unchanged when the feature flag is off

Non-goals for this slice:
- cross-chat worker reuse
- generic worker pools
- reducing miniapp capability/tool access to save memory
- removing subprocess isolation
- long-lived “forever” workers without reap/TTL policy

---

## Current-code landmarks

Primary files to inspect/modify:
- `server.py`
- `config.py`
- `hermes_client.py`
- `hermes_client_types.py`
- `hermes_client_agent.py`
- `hermes_client_agent_direct.py`
- `job_runtime.py`
- `job_runtime_chat_job.py`
- `job_runtime_events.py`
- `job_runtime_worker_launcher.py`
- `routes_chat_stream.py`
- `tests/test_hermes_client.py`
- `tests/test_routes_jobs_runtime.py`
- `tests/test_routes_chat.py`
- `docs/plans/2026-04-03-miniapp-worker-owned-warm-session-contract.md`

Current architecture constraints already visible in code/docs:
- warm-session scaffolding exists
- reuse-contract scaffolding exists
- subprocess launcher is current safe mode
- stream/resume logic already expects a clean job/state authority in the backend

---

## Phase 1: Feature flag and config seam only

### Task 1: Add explicit warm-worker reuse feature flags

Objective: Create the config seam for same-chat isolated warm reuse without changing behavior yet.

Files:
- Modify: `config.py`
- Modify: `server.py`
- Test: `tests/test_config.py`

Add config fields:
- `MINI_APP_WARM_WORKER_REUSE`
- `MINI_APP_WARM_WORKER_SAME_CHAT_ONLY`
- `MINI_APP_WARM_WORKER_IDLE_TTL_SECONDS`
- `MINI_APP_WARM_WORKER_MAX_IDLE`
- `MINI_APP_WARM_WORKER_MAX_TOTAL`

Expected default values for the first slice:
- reuse disabled by default
- same-chat-only enabled by default
- idle TTL conservative (for example 180 seconds)
- max idle small (for example 2)
- max total bounded (for example equal to or slightly above worker concurrency)

Implementation notes:
- validate types/ranges in config
- keep defaults behavior-preserving when the flag is off
- surface config values through `server.py` into runtime/client construction

Verification:
- `python -m pytest tests/test_config.py -q`
- confirm invalid values fail fast
- confirm defaults keep current launcher/runtime behavior unchanged

### Task 2: Document the new flag surface in the warm-session contract doc

Objective: Keep the architecture contract current before behavior lands.

Files:
- Modify: `docs/plans/2026-04-03-miniapp-worker-owned-warm-session-contract.md`

Add a short section describing:
- same-chat isolated warm reuse as the first real behavior slice
- feature-flag gating
- conservative fallback to cold spawn
- idle TTL and bounded worker counts

Verification:
- read doc top-to-bottom and confirm it matches the actual implementation target in this plan

---

## Phase 2: Worker registry and lifecycle model

### Task 3: Introduce a concrete warm-worker registry record model

Objective: Track warm worker ownership/state explicitly rather than inferring it ad hoc.

Files:
- Modify: `hermes_client_types.py`
- Modify: `hermes_client.py`
- Test: `tests/test_hermes_client.py`

Add/extend a worker-owner record with fields like:
- `chat_id`
- `session_id`
- `owner_pid`
- `state` (`starting`, `idle`, `busy`, `expired`, `dead`, `evicted`)
- `lifecycle_phase`
- `last_started_monotonic_ms`
- `last_finished_monotonic_ms`
- `reusable_until_monotonic_ms`
- `attach_transport_kind`
- `attach_worker_endpoint`
- `attach_resume_token`
- `attach_resume_deadline_ms`
- `last_outcome`

Important rule:
- this phase creates durable registry state and diagnostics first
- do not perform real attach/reuse yet

Verification:
- add focused tests for record creation, state updates, and expiration metadata

### Task 4: Add worker lifecycle state transitions and cleanup helpers

Objective: Make worker transitions explicit and testable.

Files:
- Modify: `hermes_client_types.py`
- Modify: `job_runtime.py`
- Test: `tests/test_hermes_client.py`
- Test: `tests/test_routes_jobs_runtime.py`

Add helpers to move a record through:
- worker created
- worker running/busy
- worker idle and reusable
- worker expired by TTL
- worker evicted by explicit cleanup
- worker marked dead on failed liveness/identity check

Important rule:
- keep transitions idempotent
- keep state-authority in one helper layer, not scattered inline across job code

Verification:
- add tests that repeated transition calls are safe
- add tests that expiry and explicit invalidation produce the right state + diagnostics

---

## Phase 3: Persistent worker protocol seam

### Task 5: Split one-shot direct agent runner from persistent worker runner

Objective: Create a real long-lived worker protocol without disturbing the current one-shot path.

Files:
- Modify: `hermes_client_agent_direct.py`
- Possibly create: `chat_worker_persistent.py` or similar helper module under the miniapp repo
- Test: `tests/test_hermes_client.py`

Current situation:
- the direct child process reads one payload, runs one conversation, exits

New seam needed:
- one runner mode remains one-shot (current behavior)
- one runner mode stays alive and handles repeated commands:
  - `init`
  - `run_prompt`
  - `heartbeat`
  - `shutdown`

Important rule:
- do not convert the current child runner in-place without a mode gate
- keep one-shot mode available for fallback and for tests

Verification:
- unit test the persistent protocol parser/dispatcher separately from the full runtime path
- test clean shutdown and malformed-command handling

### Task 6: Add attach transport metadata to persistent workers

Objective: Make a warm worker attachable through explicit descriptors, not by implicit assumptions.

Files:
- Modify: `hermes_client_types.py`
- Modify: `hermes_client_agent_direct.py`
- Test: `tests/test_hermes_client.py`

Expose real values for the existing reserved fields when persistent mode is active:
- `transport_kind`
- `worker_endpoint`
- `resume_token`
- `resume_deadline_ms`

Important rule:
- keep these fields absent/placeholder in one-shot mode
- validate them before any attach attempt

Verification:
- tests for descriptor population in persistent mode
- tests that invalid/missing fields cause fallback instead of unsafe attach

---

## Phase 4: Safe same-chat attach/reuse decisioning

### Task 7: Add same-chat attach eligibility helper

Objective: Decide reuse eligibility in one place with explicit reasons.

Files:
- Modify: `hermes_client.py`
- Modify: `hermes_client_types.py`
- Test: `tests/test_hermes_client.py`

Implement a decision helper that returns structured status such as:
- `attach_eligible`
- `attach_disabled_by_flag`
- `attach_wrong_chat`
- `attach_worker_busy`
- `attach_candidate_expired`
- `attach_owner_dead`
- `attach_owner_identity_unverified`
- `attach_contract_invalid`
- `attach_fallback_to_cold_spawn`

Eligibility rules for this slice:
- same chat only
- worker not busy
- worker alive by PID probe
- identity verified
- attach metadata valid
- within TTL

Verification:
- unit tests for each decision branch
- especially ensure different-chat attach is impossible in this slice

### Task 8: Add process liveness and identity verification before attach

Objective: Prevent attaching to the wrong or stale process.

Files:
- Modify: `hermes_client.py`
- Modify: `hermes_client_types.py`
- Test: `tests/test_hermes_client.py`

Use separate helpers for:
- PID liveness probe (`os.kill(pid, 0)`)
- process identity verification (`/proc/<pid>/cmdline` on Linux)
- session/chat binding verification where available

Important rule:
- PID existence alone is not enough
- identity verification alone is not enough if session binding can also be checked

Verification:
- tests for dead PID, wrong-process cmdline, missing `/proc` data, and verified happy path

---

## Phase 5: Real same-chat warm reuse behavior

### Task 9: Teach HermesClient/job runtime to prefer attach over cold spawn when eligible

Objective: Use the warm worker for the same chat when all checks pass.

Files:
- Modify: `hermes_client.py`
- Modify: `job_runtime.py`
- Modify: `job_runtime_chat_job.py`
- Test: `tests/test_hermes_client.py`
- Test: `tests/test_routes_jobs_runtime.py`

Desired behavior:
- if same-chat warm worker is eligible, route the run through attach/reuse
- otherwise cold spawn exactly as today
- on attach failure, fall back to cold spawn and record the reason

Important rule:
- do not partially attach and then leave runtime state ambiguous
- attach failure must be recoverable and attributable

Verification:
- tests proving:
  - eligible same-chat run reuses worker
  - ineligible run cold-spawns
  - attach failure cold-spawns and records fallback reason

### Task 10: Mark workers busy/idle correctly around each run

Objective: Prevent concurrent double-use of the same warm worker.

Files:
- Modify: `job_runtime.py`
- Modify: `job_runtime_chat_job.py`
- Test: `tests/test_routes_jobs_runtime.py`

Rules:
- before dispatch to a warm worker: mark `busy`
- after terminal completion/error: mark `idle` if still reusable
- on fatal attach/process error: mark `dead` or `evicted`

Important rule:
- no worker may be both eligible and busy
- busy workers must not be attach candidates

Verification:
- add tests for repeated same-chat turns and overlapping attempts

---

## Phase 6: Reaping and bounded resource control

### Task 11: Add idle worker reaper

Objective: Stop warm workers from accumulating forever.

Files:
- Modify: `job_runtime.py`
- Modify: `hermes_client.py`
- Test: `tests/test_routes_jobs_runtime.py`

Implement:
- TTL-based expiration for idle workers
- best-effort shutdown path for expired workers
- registry state update to `expired` or `evicted`

Verification:
- tests for TTL expiry
- tests for failure-to-shutdown still marking worker unusable

### Task 12: Enforce max idle and max total warm-worker caps

Objective: Keep memory bounded even after reuse is enabled.

Files:
- Modify: `job_runtime.py`
- Modify: `hermes_client.py`
- Test: `tests/test_routes_jobs_runtime.py`

Policy for first slice:
- if idle workers exceed cap, evict oldest idle first
- if total warm workers exceed cap, evict oldest idle first
- never evict a busy worker just to satisfy the cap in this first slice

Verification:
- tests for cap enforcement order and non-eviction of busy workers

---

## Phase 7: Streaming/resume correctness under warm reuse

### Task 13: Verify stream contract still works with attached warm workers

Objective: Ensure frontend-visible streaming semantics do not regress when backend execution is attached rather than cold-spawned.

Files:
- Modify: `routes_chat_stream.py` only if needed
- Modify: backend runtime glue only if needed
- Test: `tests/test_routes_chat.py`

Must still work correctly for:
- tool events
- assistant chunks / done events
- SSE heartbeat/comments
- resume/replay semantics
- terminal reconciliation

Important rule:
- backend remains the scheduling/state authority
- client stream contract must not depend on whether the run was cold-spawned or attached

Verification:
- rerun targeted route-stream tests
- add warm-reuse-specific route tests if current coverage is insufficient

---

## Phase 8: Diagnostics and QA

### Task 14: Add operator-visible diagnostics for reuse hit rate and fallbacks

Objective: Make it obvious whether warm reuse is helping or silently failing.

Files:
- Modify: `job_runtime.py`
- Modify: any diagnostics surface already used by runtime incident snapshots
- Test: `tests/test_routes_jobs_runtime.py`

Add counters/fields like:
- `warm_reuse_attempts`
- `warm_reuse_hits`
- `warm_reuse_fallbacks`
- `fallback_reason_counts`
- `warm_workers_idle`
- `warm_workers_busy`
- `warm_workers_total`

Verification:
- diagnostics snapshot includes these fields
- counts change in the expected direction in tests

### Task 15: Add a focused QA checklist doc for same-chat warm reuse

Objective: Make manual signoff straightforward before wider rollout.

Files:
- Create: `docs/plans/2026-04-08-miniapp-same-chat-warm-reuse-qa-checklist.md`

Checklist should cover:
- same chat repeated prompt uses warm reuse
- different chat does not attach to that worker
- dead worker falls back to cold spawn
- queue behavior under concurrency still sane
- reconnect/resume still works
- no cross-chat transcript/tool leakage

---

## First implementation slice I recommend

Implement only this first:
1. feature flags + config validation
2. concrete warm-worker registry record/state transitions
3. persistent worker protocol seam behind a mode gate
4. same-chat attach eligibility helper
5. attach fallback to cold spawn when anything is suspicious

Stop there and validate before adding broader cap/reaper sophistication.

Why this is the right first slice:
- it delivers the architecture seam that matters
- it keeps default behavior safe
- it avoids jumping into pool complexity too early
- it directly targets the current pain: repeated cold boots making concurrency feel expensive

---

## Recommended test sequence after each meaningful slice

Run in this order:
1. `python -m pytest tests/test_config.py tests/test_hermes_client.py -q`
2. `python -m pytest tests/test_routes_jobs_runtime.py -q`
3. `python -m pytest tests/test_routes_chat.py -q`
4. any focused frontend streaming regression suites if route behavior changes affect stream semantics

Before rollout with the flag enabled, also run a manual miniapp QA pass covering:
- 3 simultaneous chats
- repeated prompts in the same chat
- reconnect after visibility/backgrounding
- tool-heavy run + follow-up run in same chat
- stale-worker fallback path

---

## Final implementation note

Do not try to make this “perfectly general” in one pass.

The safest path is:
- same-chat only
- isolated only
- bounded only
- fallback-first
- instrument everything

If this slice works, then we can decide whether Phase 2 should be:
- one warm worker per active chat as the standard model
or
- a bounded attachable worker pool

For the miniapp product goals, one warm isolated worker per active chat is likely the better next step after this plan succeeds.
