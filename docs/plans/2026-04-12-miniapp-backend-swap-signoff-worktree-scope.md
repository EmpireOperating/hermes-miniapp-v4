# Miniapp Backend Swap Signoff Worktree Scope

Date: 2026-04-12
Worktree: `/home/hermes-agent/workspace/worktrees/hermes_miniapp_v4-backend-swap-signoff-2026-04-12`
Branch: `miniapp-backend-swap-signoff-2026-04-12`
Base commit: `432cce4` (`main` at worktree creation time)

## Purpose

This worktree is the isolated signoff/hardening lane for miniapp backend-swap completion work.

It exists specifically to avoid destabilizing the currently-good main miniapp checkout while we finish the remaining truth/lifecycle/operator-grade validation work.

Stable control checkout remains:
- `/home/hermes-agent/workspace/active/hermes_miniapp_v4`
- branch: `main`

Experimental/signoff checkout is:
- `/home/hermes-agent/workspace/worktrees/hermes_miniapp_v4-backend-swap-signoff-2026-04-12`
- branch: `miniapp-backend-swap-signoff-2026-04-12`

## What this branch is for

Narrow scope:
1. Backend-swap signoff hardening
2. Runtime truth / operator visibility improvements
3. Reconnect-resume-tab-switch signoff validation
4. Ugly-case regression coverage for timeout/fallback/isolation behavior

Not the purpose of this branch:
- unrelated feature work
- broad UI/product experiments
- mixing in unrelated refactors unless required to land signoff work safely

## First slice landed in this worktree

Completed first implementation slice:
- added an operator-focused runtime summary for `/api/runtime/status`

New summary surfaces:
- active execution path counts for current jobs
- recent transport fallback counts and reasons
- recent CLI fallback count
- child-timeout impact by affected jobs/chats
- suspicious active jobs (for example recent fallback, CLI path, or idle-without-progress)

Primary files touched:
- `job_runtime_diagnostics.py`
- `routes_jobs_runtime.py`
- `tests/test_routes_jobs_runtime.py`

Validation run:
- `python -m pytest tests/test_hermes_client.py tests/test_routes_jobs_runtime.py -q`
- result at landing time: `143 passed`

## Second slice landed in this worktree

Completed second implementation slice:
- added a route-level containment regression proving a failed resume in one chat does not block a new stream in another chat for the same user/session

What it verifies:
- stale/dead-lettered resume failure stays scoped to the failing chat
- the other chat can still enqueue, stream, complete, and become active normally
- no accidental user-wide blockage after a local chat failure path

Primary files touched:
- `tests/test_routes_chat.py`

Validation run:
- `/home/hermes-agent/workspace/active/hermes_miniapp_v4/.venv/bin/python -m pytest tests/test_routes_chat.py -q`
- result: `65 passed`
- broader changed-scope bundle at landing time:
  - `/home/hermes-agent/workspace/active/hermes_miniapp_v4/.venv/bin/python -m pytest tests/test_routes_jobs_runtime.py tests/test_job_runtime_chat_job.py tests/test_routes_chat.py -k 'not test_subprocess_two_chat_session_mismatch_isolation_smoke' -q`
  - result: `116 passed, 1 deselected`

## Third slice landed in this worktree

Completed third implementation slice:
- deflaked the order-sensitive subprocess multi-chat session-mismatch isolation smoke test by making its manual runtime processing deterministic

What it verifies:
- cross-chat contamination in the subprocess stream path still dead-letters the contaminated chat locally
- the unaffected chat still completes normally
- the signoff test no longer races with background worker/watchdog threads when it manually calls `_process_available_jobs_once()`

Primary files touched:
- `tests/test_routes_jobs_runtime.py`
- `docs/plans/2026-04-12-miniapp-backend-swap-signoff-worktree-scope.md`

Validation run:
- `/home/hermes-agent/workspace/active/hermes_miniapp_v4/.venv/bin/python -m pytest tests/test_routes_jobs_runtime.py::test_subprocess_two_chat_session_mismatch_isolation_smoke -q -vv`
- result: `1 passed`
- full file in-order:
  - `/home/hermes-agent/workspace/active/hermes_miniapp_v4/.venv/bin/python -m pytest tests/test_routes_jobs_runtime.py -q`
  - result: `36 passed`
- broader changed-scope bundle:
  - `/home/hermes-agent/workspace/active/hermes_miniapp_v4/.venv/bin/python -m pytest tests/test_routes_chat.py tests/test_routes_jobs_runtime.py tests/test_hermes_client.py -q`
  - result: `208 passed`

Note on the former flake:
- this was a test harness race, not evidence that we need heavier runtime architecture
- root cause: the smoke test manually drove `_process_available_jobs_once()` while background runtime worker/watchdog threads could still be alive
- fix: shut down the runtime first, then clear `_shutdown_event` before deterministic manual processing, matching the manual-run pattern already used elsewhere in this test file

## Fourth slice landed in this worktree

Completed fourth implementation slice:
- extended `operator_summary` so it surfaces active-job latest transition reasons and a compact active warm-resume count

What it verifies:
- operators can now distinguish active fallback work from active warm-resumed work without drilling into raw transport histories
- `agent-persistent` active load is no longer ambiguous when its current state came from `warm_attach_resume`
- suspicious active-job entries now carry the latest transition reason as well as the latest fallback reason

Primary files touched:
- `job_runtime_diagnostics.py`
- `tests/test_routes_jobs_runtime.py`

Validation run:
- `/home/hermes-agent/workspace/active/hermes_miniapp_v4/.venv/bin/python -m pytest tests/test_routes_jobs_runtime.py -q`
- result: `36 passed`
- broader changed-scope bundle:
  - `/home/hermes-agent/workspace/active/hermes_miniapp_v4/.venv/bin/python -m pytest tests/test_routes_chat.py tests/test_routes_jobs_runtime.py tests/test_hermes_client.py -q`
  - result: `208 passed`

Why this remains lightweight:
- this slice only summarizes existing transition signals already recorded by the current architecture
- it does not add new background processes, new ownership layers, or heavier runtime orchestration

## Fifth slice landed in this worktree

Completed fifth implementation slice:
- added a route-level regression proving repeated stale resume attempts on the same chat stay local and clean after the first dead-letter recovery

What it verifies:
- the first stale resume still dead-letters the stale open job and returns the expected `409`
- a second stale resume attempt does not recreate an open job, does not mutate the original dead job back to open/running, and does not disturb the currently active chat selection
- reconnect/resume churn on an already-recovered stale chat remains a clean no-active-job path rather than causing residue

Primary files touched:
- `tests/test_routes_chat.py`

Validation run:
- `/home/hermes-agent/workspace/active/hermes_miniapp_v4/.venv/bin/python -m pytest tests/test_routes_chat.py -q`
- result: `66 passed`
- broader changed-scope bundle:
  - `/home/hermes-agent/workspace/active/hermes_miniapp_v4/.venv/bin/python -m pytest tests/test_routes_chat.py tests/test_routes_jobs_runtime.py tests/test_hermes_client.py -q`
  - result: `209 passed`

Why this remains lightweight:
- this slice adds signoff-grade regression coverage only
- it does not change production runtime ownership, process topology, or fallback behavior

## Sixth slice landed in this worktree

Completed sixth implementation slice:
- added a route-level regression proving that a stale-resume dead-letter on a chat does not poison the next fresh `/api/chat/stream` request on that same chat

What it verifies:
- a stale `/api/chat/stream/resume` still dead-letters the stale open job and returns the expected `409`
- a subsequent fresh `/api/chat/stream` on that same chat succeeds normally, emits a clean `done` terminal event, and creates a new open job rather than resurrecting the dead one
- same-chat recovery after stale resume remains clean without requiring cross-chat escape hatches

Primary files touched:
- `tests/test_routes_chat.py`

Validation run:
- `/home/hermes-agent/workspace/active/hermes_miniapp_v4/.venv/bin/python -m pytest tests/test_routes_chat.py -q`
- result: `67 passed`
- broader changed-scope bundle:
  - `/home/hermes-agent/workspace/active/hermes_miniapp_v4/.venv/bin/python -m pytest tests/test_routes_chat.py tests/test_routes_jobs_runtime.py tests/test_hermes_client.py -q`
  - result: `210 passed`

Why this remains lightweight:
- this slice adds signoff-grade regression coverage only
- it does not change production runtime ownership, process topology, or fallback behavior

## Seventh slice landed in this worktree

Completed seventh implementation slice:
- extended `operator_summary` so it surfaces queue-recovery and preclaim dead-letter counters already present in raw runtime diagnostics

What it verifies:
- operators can now answer whether startup recovery, startup exhaustion clamping, or preclaim dead-letter cleanup has been active recently without drilling into raw `queue_diagnostics`
- the compact operator summary stays aligned with existing lightweight queue/runtime signals instead of requiring heavier runtime machinery

Primary files touched:
- `job_runtime_diagnostics.py`
- `tests/test_routes_jobs_runtime.py`

Validation run:
- `/home/hermes-agent/workspace/active/hermes_miniapp_v4/.venv/bin/python -m pytest tests/test_routes_jobs_runtime.py -q`
- result: `36 passed`
- broader changed-scope bundle:
  - `/home/hermes-agent/workspace/active/hermes_miniapp_v4/.venv/bin/python -m pytest tests/test_routes_chat.py tests/test_routes_jobs_runtime.py tests/test_hermes_client.py -q`
  - result: `210 passed`

Why this remains lightweight:
- this slice only promotes existing queue-diagnostic counters into the compact operator summary
- it does not add new ownership layers, background workers, or heavier recovery behavior

## Eighth slice landed in this worktree

Completed eighth implementation slice:
- added a route-level regression proving a fresh `/api/chat/stream` dead-letters a stale running/open job on the same chat before enqueuing and streaming a replacement job

What it verifies:
- same-chat timeout residue does not permanently block the next send
- the stale running/open job is marked dead with `E_STALE_OPEN_JOB_AFTER_RESTART: stale open job dead-lettered before new stream`
- the replacement send creates a new job, streams cleanly to `done`, and does not replay the dead job

Primary files touched:
- `tests/test_routes_chat.py`

Validation run:
- `/home/hermes-agent/workspace/active/hermes_miniapp_v4/.venv/bin/python -m pytest tests/test_routes_chat.py -q`
- result: `68 passed`
- broader changed-scope bundle:
  - `/home/hermes-agent/workspace/active/hermes_miniapp_v4/.venv/bin/python -m pytest tests/test_routes_chat.py tests/test_routes_jobs_runtime.py tests/test_hermes_client.py -q`
  - result: `211 passed`

## Ninth slice landed in this worktree

Completed ninth implementation slice:
- added a route-level regression proving `interrupt=true` cleanly replaces a stale-looking running/open job on the same chat

What it verifies:
- even if the existing open job has stale timing residue, interrupt replacement still works cleanly
- the old job is finalized as `dead` with `interrupted_by_new_message`
- runtime cleanup hooks still fire for child termination, runner finish, and warm-session eviction
- the replacement stream completes normally and does not replay stale state

Primary files touched:
- `tests/test_routes_chat.py`

Validation run:
- `/home/hermes-agent/workspace/active/hermes_miniapp_v4/.venv/bin/python -m pytest tests/test_routes_chat.py -q`
- result: `69 passed`
- broader changed-scope bundle:
  - `/home/hermes-agent/workspace/active/hermes_miniapp_v4/.venv/bin/python -m pytest tests/test_routes_chat.py tests/test_routes_jobs_runtime.py tests/test_hermes_client.py -q`
  - result: `213 passed`

## Tenth slice landed in this worktree

Completed tenth implementation slice:
- added a route-level regression proving that after `interrupt=true` replaces a running job, a later `/api/chat/stream/resume` replays the replacement job rather than the interrupted dead one

What it verifies:
- the original job stays `dead` with `interrupted_by_new_message`
- the replacement job becomes the sole authoritative open job for resume/replay
- resume replays buffered tool + done events from the replacement job only and does not resurrect the superseded job
- active chat selection stays stable through interrupt → resume churn

Primary files touched:
- `tests/test_routes_chat.py`

Validation run:
- `/home/hermes-agent/workspace/active/hermes_miniapp_v4/.venv/bin/python -m pytest tests/test_routes_chat.py -q`
- result: `70 passed`
- broader changed-scope bundle:
  - `/home/hermes-agent/workspace/active/hermes_miniapp_v4/.venv/bin/python -m pytest tests/test_routes_chat.py tests/test_routes_jobs_runtime.py tests/test_hermes_client.py -q`
  - result: `214 passed`

## Eleventh slice landed in this worktree

Completed eleventh implementation slice:
- added a route-level regression proving that once an interrupt replacement job reaches real terminal `done`, a later `/api/chat/stream/resume` cleanly rejects with `409` and does not resurrect either the interrupted dead job or the completed replacement job

What it verifies:
- after interrupt replacement, terminal cleanup still collapses to the correct no-open-job state once the replacement job is completed
- resume after that terminal point returns `No active Hermes job` rather than replaying stale interrupted state
- the original interrupted job remains `dead` with `interrupted_by_new_message`
- the completed replacement job remains `done`
- active chat selection is preserved through interrupt → done → resume rejection

Primary files touched:
- `tests/test_routes_chat.py`

Validation run:
- `/home/hermes-agent/workspace/active/hermes_miniapp_v4/.venv/bin/python -m pytest tests/test_routes_chat.py -q`
- result: `71 passed`
- broader changed-scope bundle:
  - `/home/hermes-agent/workspace/active/hermes_miniapp_v4/.venv/bin/python -m pytest tests/test_routes_chat.py tests/test_routes_jobs_runtime.py tests/test_hermes_client.py -q`
  - result: `215 passed`

Why this remains lightweight:
- this slice adds signoff-grade route coverage only
- it validates the existing stale-open-job recovery hook already used by fresh stream and resume paths
- it does not add new ownership layers, background workers, or heavier recovery behavior

## Ninth slice landed in this worktree

Completed ninth implementation slice:
- added a route-level regression proving `interrupt=true` cleanly replaces a stale-looking running/open job on the same chat

What it verifies:
- the interrupt replacement path still succeeds even when the prior open job has stale timing residue
- the old job is finalized as `dead` with `interrupted_by_new_message`, rather than blocking the new send or replaying stale state
- child termination, runner finish, and warm-session eviction hooks are still called for the interrupted stale-looking job
- the replacement send creates a fresh open job and streams cleanly to `done`

Primary files touched:
- `tests/test_routes_chat.py`

Validation run:
- `/home/hermes-agent/workspace/active/hermes_miniapp_v4/.venv/bin/python -m pytest tests/test_routes_chat.py -q`
- result: `69 passed`
- broader changed-scope bundle:
  - `/home/hermes-agent/workspace/active/hermes_miniapp_v4/.venv/bin/python -m pytest tests/test_routes_chat.py tests/test_routes_jobs_runtime.py tests/test_hermes_client.py -q`
  - result: `213 passed`

Why this remains lightweight:
- this slice adds signoff-grade route coverage only
- it validates the current interrupt-replacement behavior against stale-timing residue without adding any new recovery machinery or ownership layers

## Tenth slice landed in this worktree

Completed tenth implementation slice:
- added a route-level regression proving that, after `interrupt=true` replaces a running job, a later `/api/chat/stream/resume` attaches to and replays the replacement job rather than resurrecting the interrupted dead job

What it verifies:
- the original interrupted job remains `dead` with `interrupted_by_new_message`
- the replacement job becomes the authoritative open job for later resume calls
- buffered `tool` and `done` events replay from the replacement job only
- resume does not leak `interrupted_by_new_message` or otherwise rehydrate the superseded job
- active-chat selection remains stable through the interrupt-then-resume churn

Primary files touched:
- `tests/test_routes_chat.py`

Validation run:
- `/home/hermes-agent/workspace/active/hermes_miniapp_v4/.venv/bin/python -m pytest tests/test_routes_chat.py -q`
- result: `70 passed`
- broader changed-scope bundle:
  - `/home/hermes-agent/workspace/active/hermes_miniapp_v4/.venv/bin/python -m pytest tests/test_routes_chat.py tests/test_routes_jobs_runtime.py tests/test_hermes_client.py -q`
  - result: `214 passed`

Why this remains lightweight:
- this slice adds signoff-grade route coverage only
- it validates the current interrupt-replacement plus resume-replay behavior without adding any new runtime ownership, background machinery, or heavier recovery logic

## Twelfth slice landed in this worktree

Completed twelfth implementation slice:
- added a route-level regression proving that a `/api/chat/stream/resume` request for the wrong chat returns `409` cleanly without disturbing the real open job in the currently active chat

What it verifies:
- when chat A has a real queued/open job and chat B does not, a resume request for chat B still returns `No active Hermes job for this chat.`
- the active chat selection remains pinned to chat A
- the open job in chat A remains queued/open and does not get dead-lettered, replayed, or otherwise mutated by the wrong-chat resume request
- cross-chat resume mistakes stay local instead of contaminating the chat that actually has pending work

Primary files touched:
- `tests/test_routes_chat.py`

Validation run:
- `/home/hermes-agent/workspace/active/hermes_miniapp_v4/.venv/bin/python -m pytest tests/test_routes_chat.py -q`
- result: `72 passed`
- broader changed-scope bundle:
  - `/home/hermes-agent/workspace/active/hermes_miniapp_v4/.venv/bin/python -m pytest tests/test_routes_chat.py tests/test_routes_jobs_runtime.py tests/test_hermes_client.py -q`
  - result: `216 passed`

Why this remains lightweight:
- this slice adds signoff-grade route coverage only
- it validates existing per-chat resume scoping without adding any new runtime ownership, background machinery, or heavier recovery behavior

## Thirteenth slice landed in this worktree

Completed thirteenth implementation slice:
- added a route-level regression proving that a wrong-chat `/api/chat/stream/resume` request does not disturb an interrupt-created replacement open job in the active chat

What it verifies:
- after chat A goes through interrupt churn and now has both a dead superseded job and a live replacement open job, a resume request for chat B still returns `409` with `No active Hermes job`
- the active chat selection remains pinned to chat A
- the replacement open job in chat A stays queued/open and unchanged
- the superseded interrupted job in chat A stays `dead` with `interrupted_by_new_message`
- cross-chat resume mistakes remain local even in the more complex interrupt/replacement state, rather than contaminating the chat that actually owns the active work

Primary files touched:
- `tests/test_routes_chat.py`

Validation run:
- `/home/hermes-agent/workspace/active/hermes_miniapp_v4/.venv/bin/python -m pytest tests/test_routes_chat.py -q`
- result: `73 passed`
- broader changed-scope bundle:
  - `/home/hermes-agent/workspace/active/hermes_miniapp_v4/.venv/bin/python -m pytest tests/test_routes_chat.py tests/test_routes_jobs_runtime.py tests/test_hermes_client.py -q`
  - result: `217 passed`

Why this remains lightweight:
- this slice adds signoff-grade route coverage only
- it validates existing per-chat resume scoping even after interrupt/replacement churn, without adding any new runtime ownership, background machinery, or heavier recovery behavior

## Fourteenth slice landed in this worktree

Completed fourteenth implementation slice:
- ran a broader Arch-vs-stable signoff QA bundle across chat routes, stream service, runtime, worker launcher, startup, and Hermes client behavior

What it verifies:
- the Arch signoff worktree remains green beyond the narrowly targeted slices and still passes a broader backend-focused signoff bundle
- against the same test bundle, stable `main` remains green as the control baseline
- the current Arch diff against `main` is still confined to the intended signoff files rather than drifting into broader architecture churn

Primary files touched:
- `docs/plans/2026-04-12-miniapp-backend-swap-signoff-worktree-scope.md`

Validation run:
- Arch worktree bundle:
  - `/home/hermes-agent/workspace/active/hermes_miniapp_v4/.venv/bin/python -m pytest tests/test_routes_chat.py tests/test_routes_chat_stream_service.py tests/test_routes_jobs_runtime.py tests/test_job_runtime_chat_job.py tests/test_job_runtime_worker_launcher.py tests/test_server_startup.py tests/test_hermes_client.py tests/test_hermes_client_bootstrap.py -q`
  - result: `275 passed`
- stable control bundle:
  - `/home/hermes-agent/workspace/active/hermes_miniapp_v4/.venv/bin/python -m pytest tests/test_routes_chat.py tests/test_routes_chat_stream_service.py tests/test_routes_jobs_runtime.py tests/test_job_runtime_chat_job.py tests/test_job_runtime_worker_launcher.py tests/test_server_startup.py tests/test_hermes_client.py tests/test_hermes_client_bootstrap.py -q`
  - result: `265 passed`
- current Arch working-tree diff against `main` remains limited to:
  - `job_runtime_diagnostics.py`
  - `routes_jobs_runtime.py`
  - `tests/test_routes_chat.py`
  - `tests/test_routes_jobs_runtime.py`

Why this remains lightweight:
- this slice adds no production behavior and no new runtime machinery
- it establishes an apples-to-apples QA baseline showing the current branch is still a narrow signoff/hardening lane over the lightweight architecture

## Merge-readiness note after broader QA

Important current constraint:
- the worktree currently has additional modified files outside the narrow Arch signoff scope
- that means the Arch signoff work itself looks merge-candidate in isolation, but this worktree is not yet safe to merge wholesale as-is

Arch-scoped tracked diff against `main` remains limited to:
- `job_runtime_diagnostics.py`
- `routes_jobs_runtime.py`
- `tests/test_routes_chat.py`
- `tests/test_routes_jobs_runtime.py`

Before merge/PR, isolate only the Arch-scoped changes from any unrelated working-tree modifications.

## Intended next slices

Recommended next work in this branch:
1. Add or expand ugly-case regression coverage for timeout/failure/reconnect churn
2. Extend operator-grade visibility only where existing raw runtime signals still require too much manual digging
3. Run branch-specific signoff QA against the live/stable baseline before considering merge back
4. Only make production behavior changes if we find a real lightweight-architecture gap, not merely a test determinism issue
