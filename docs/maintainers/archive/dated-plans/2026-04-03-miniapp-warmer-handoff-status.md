# Miniapp Warmer Handoff Status

Date: 2026-04-04
Project: /home/hermes-agent/workspace/active/hermes_miniapp_v4

## Purpose

This handoff is for the next agent continuing the Hermes Miniapp worker-owned warm-session path.

The major architectural change is no longer hypothetical:
- bounded isolated-worker-owned warm continuity is now implemented end-to-end
- first-turn queue/SSE termination now closes with a normal `done` payload instead of synthetic terminal DB recovery
- later turns can attach back into the same isolated worker
- browser and API QA have both been run against the live service

This document should be read together with:
- `docs/maintainers/archive/dated-plans/2026-04-03-miniapp-worker-owned-warm-session-contract.md`
- `docs/maintainers/archive/dated-plans/2026-04-03-miniapp-backend-swap-updated-todo-checklist.md`
- `docs/maintainers/archive/dated-plans/2026-04-03-miniapp-two-track-implementation-status.md`
- `docs/maintainers/archive/dated-plans/2026-04-04-miniapp-worker-owned-warm-continuity-qa-checklist.md`

## High-level architecture direction

We are moving from checkpoint-only continuity toward bounded isolated-worker-owned warm continuity.

The current implemented shape is:
- one chat can acquire one isolated warm owner
- that owner lives outside the shared backend process
- the parent launcher can detach instead of reaping the child after the first successful turn
- later ordinary turns can attach back into that same worker via the live attach contract
- the backend remains the scheduler / relay / state authority

The system is no longer in preflight-only mode for this slice.
The warm continuity path is real, but broader backend-swap sign-off is still not complete.

## What is now implemented and verified

### 1. Detached warm owner survives the first turn
The first successful turn can now leave behind a detached warm worker instead of a one-shot child.

Important runtime properties now working together:
- child runs in isolated-owner settings inside its own process boundary
- parent launcher classifies the child as a detached warm owner
- cleanup no longer kills that worker immediately after the first successful request

### 2. Running owner becomes attachable
A live worker with attach metadata is now tracked as an attachable owner.

Important state/contract properties:
- owner record can enter `state = attachable_running`
- reuse contract upgrades to worker-attach semantics when live attach metadata is present
- later turns can reuse that owner through the attach path instead of cold-starting a new worker

### 3. Contract refresh rotates before attached terminal `done`
After an attached resume turn:
- `resume_token` rotates
- `resume_deadline_ms` extends
- refreshed `attach_ready` is emitted before the resumed terminal `done`

This keeps the next-turn attach contract observable in the same successful attached stream.

### 4. Explicit invalidation and expiry semantics hold
The live owner state now preserves the correct final attribution for:
- clear chat -> `state = evicted`, `reusability_reason = invalidated_by_clear`
- remove chat -> `state = evicted`, `reusability_reason = invalidated_by_remove`
- missed attach deadline -> `state = expired`, `reusability_reason = attach_resume_deadline_expired`

The later worker-finished update no longer overwrites those final states with a generic finished record.

### 5. First-turn queue/SSE handoff now closes cleanly
A subtle live bug in the original queue-backed stream is fixed.

Root cause that mattered:
- `job_runtime_chat_job.execute_chat_job(...)` was completing the job before publishing the terminal `done` event
- that let the SSE route fall back to synthetic terminal DB recovery, producing an error-like terminal event even when warm handoff had succeeded

Pattern now implemented:
- publish the terminal `done` payload before `store.complete_job(job_id)`
- when preserving the warm owner, include:
  - `persistent_mode = warm-detached`
  - `warm_handoff = true`
  - `session_id = <chat session>`

Net result:
- first turn now ends with `event: done`
- browser UI returns from pending/running to complete/send-enabled state
- later turns still attach into the same worker

### 6. Browser and API live QA both passed
Verified live behaviors:
- first API turn ends with normal `done`
- second ordinary API turn also ends with normal `done`
- second turn still uses warm continuity behind the scenes
- browser miniapp chat rendered expected replies (`FIRST-OK`, `THIRD-OK` during QA)
- composer returned from `Sending…` / running state back to normal send-enabled state
- final browser state showed:
  - `source: queue`
  - `stream: complete`
  - textbox enabled
  - send button restored

## Current status summary

The bounded worker-owned warm continuity path should now be treated as implemented, not just scaffolded.

That means the system can now do all of the following in live use:
- create a detached warm owner on first turn
- surface that owner as attachable while still running
- attach a later turn into the same worker
- rotate the attach contract for the next turn
- preserve explicit final invalidation and expiry states
- close both the original queue-backed stream and the attached stream with clean terminal `done` behavior

## What is still not “backend swap done”

This slice is real and verified, but broader sign-off is still pending.

Remaining meaningful work still includes:
- stronger OS-level worker isolation beyond current subprocess + rlimit boundaries
- operator-grade transport/fallback visibility across more failure classes
- reconnect / resume / tab-switch sign-off under more multi-chat stress
- an intentionally ugly bad-day regression / stress suite
- idle reap / lifecycle hardening beyond the currently verified bounded continuity path

## Most important files to inspect next

Primary implementation:
- `/home/hermes-agent/workspace/active/hermes_miniapp_v4/hermes_client.py`
- `/home/hermes-agent/workspace/active/hermes_miniapp_v4/chat_worker_subprocess.py`
- `/home/hermes-agent/workspace/active/hermes_miniapp_v4/job_runtime_worker_launcher.py`
- `/home/hermes-agent/workspace/active/hermes_miniapp_v4/job_runtime_chat_job.py`
- `/home/hermes-agent/workspace/active/hermes_miniapp_v4/routes_chat_stream.py`

Primary tests:
- `/home/hermes-agent/workspace/active/hermes_miniapp_v4/tests/test_hermes_client.py`
- `/home/hermes-agent/workspace/active/hermes_miniapp_v4/tests/test_job_runtime_chat_job.py`
- `/home/hermes-agent/workspace/active/hermes_miniapp_v4/tests/test_job_runtime_worker_launcher.py`
- `/home/hermes-agent/workspace/active/hermes_miniapp_v4/tests/test_routes_chat.py`

Verification doc:
- `/home/hermes-agent/workspace/active/hermes_miniapp_v4/docs/maintainers/archive/dated-plans/2026-04-04-miniapp-worker-owned-warm-continuity-qa-checklist.md`

## Current verified test state

Last verified command:
`python -m pytest tests/test_job_runtime_chat_job.py tests/test_routes_chat.py tests/test_job_runtime_worker_launcher.py tests/test_hermes_client.py -q`

Result at handoff:
- `172 passed in 8.90s`

## Recommended next step for the next agent

Do not spend the next slice re-deriving whether attach works. That part is now live and verified.

Best next chunk:
1. preserve this behavior with a compact regression checklist during future changes
2. improve operator/debug visibility for the remaining edge cases
3. run broader reconnect/tab-switch/multi-chat stress validation against the live service
4. continue backend-swap sign-off work without regressing worker-owned warm continuity

## Behavioral guardrails

Do NOT regress these properties:
- do not move warm ownership back into the shared backend process for subprocess production mode
- do not let `worker_finished` overwrite explicit `evicted` or `expired` final states
- do not emit contract refresh after attached terminal `done`
- do not complete the queue-backed job before publishing the terminal `done` payload
- do not treat a live warm handoff as a synthetic error-like terminal event

## Quick prompt for the next agent

Suggested continuation prompt:

"Continue the Hermes Miniapp backend-swap work from docs/maintainers/archive/dated-plans/2026-04-03-miniapp-warmer-handoff-status.md and docs/maintainers/archive/dated-plans/2026-04-04-miniapp-worker-owned-warm-continuity-qa-checklist.md. Preserve the now-working bounded worker-owned warm continuity path, then focus on remaining sign-off work: operator diagnostics, reconnect/tab-switch hardening, and broader bad-day regression coverage without regressing live attach behavior."