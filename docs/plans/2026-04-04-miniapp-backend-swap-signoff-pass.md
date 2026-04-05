# Miniapp Backend Swap — Sign-off Pass Snapshot

Date: 2026-04-04
Project: /home/hermes-agent/workspace/active/hermes_miniapp_v4

## Purpose

This doc records the first broader sign-off-oriented pass after the bounded worker-owned warm continuity path became real.

The point of this pass was not to invent more architecture.
It was to answer a narrower question:
- do reconnect/resume/tab-switch and cross-chat lifecycle paths now look stable enough that the remaining work is mostly sign-off hardening rather than foundational redesign?

## What this pass covered

### Backend/runtime validation
Ran:
- `python -m pytest tests/test_job_runtime_chat_job.py tests/test_routes_chat.py tests/test_routes_jobs_runtime.py tests/test_job_runtime_worker_launcher.py tests/test_hermes_client.py tests/test_fanout_storm_forensics.py tests/test_streaming_hardening_guards.py -q`

Result:
- `214 passed in 13.20s`

Areas covered by that run:
- first-turn queue/SSE terminal handoff
- warm-owner preservation and attachability
- same-worker continuity on later turns
- resume route behavior and replay cursor handling
- synthetic terminal recovery paths
- worker launcher/runtime isolation behavior
- fan-out storm forensics and fallback attribution
- stream hardening guards in frontend/backend contracts

### Frontend/runtime validation
Ran:
- `node --test tests/chat_history_helpers.test.mjs tests/stream_controller.test.mjs tests/visibility_skin_helpers.test.mjs tests/bootstrap_auth_helpers.test.mjs tests/frontend_runtime.test.mjs`

Result:
- `75 passed`

Areas covered by that run:
- active-chat visibility reconciliation
- stale history response suppression during tab/chat switches
- local-pending/server-pending resume logic
- reconnect and replay cursor handling
- early-close reconnect behavior
- active/inactive chat status-chip gating
- auth bootstrap + pending stream resume startup behavior

## New regression lock added in this pass

Added route coverage proving same-chat conflict handling does not incorrectly block a different chat:
- `tests/test_routes_chat.py::test_stream_chat_allows_other_chat_while_first_chat_has_open_job`

Why this matters:
- one chat already having an open job should not prevent another chat from starting its own stream
- this is a direct backend-swap sign-off requirement because it proves the user-facing chat boundary is not silently flattened into a single-chat bottleneck

## What now looks strong

After this pass, the following look materially stronger than before:
- same-chat open-job rejection is scoped correctly
- different-chat stream start is still allowed for the same user
- stale active-chat history responses are ignored instead of repainting the wrong chat
- reconnect/resume paths have explicit cursor/replay coverage
- frontend visibility reconciliation is tested, not just assumed
- bounded worker-owned warm continuity remains covered by both code tests and live QA docs

## Live sign-off pass results

### API pass: strong
A live API pass against `https://app.cronpulse.app` using dev-auth cookie mode succeeded for:
- overlapping two-chat streaming
- same-user cross-chat concurrency
- reconnect/resume after intentional early stream disconnect

Observed live results:
- chat A could be pending while chat B started successfully
- both streams terminated with `done`
- reconnect/resume returned a clean terminal `done` after partial early disconnect

### Browser pass: blocker reproduced, then closed
The first live browser pass found a real reload/resume blocker:
- final assistant reply could become visible
- but UI stayed stuck in reconnecting/running state
- send remained disabled too long

Follow-up investigation found the deeper issue:
- this was not just a frontend stale-state race
- the original job could remain open too long because the subprocess launcher was not detaching promptly once it had already seen:
  - `attach_ready`
  - normal terminal `done`

Fixes that landed:
1. frontend hydration hardening so terminal reconciliation can force local completed state during post-done hydration
2. backend/runtime launcher hardening so detached warm-worker classification can happen immediately after `done` once `attach_ready` has already been seen

Latest live browser re-check after restart/deploy:
- reload mid-stream
- reopen active chat
- final reply becomes visible
- send re-enables
- stream chip returns to complete
- server-side `pending` is false

Observed successful end state:
- `STREAM: COMPLETE · <chat>`
- `SOURCE: QUEUE`
- send enabled
- server pending false

Practical meaning:
- overlapping multi-chat browser behavior looks healthy
- reload/resume completion-state reconciliation now looks healthy in live verification too

## What is still not fully signed off

This pass improves confidence, but it still does not make backend-swap completion unconditional.

Remaining meaningful sign-off work still includes:
1. stronger OS-level containment beyond subprocess + rlimit where feasible
2. broader live multi-chat/browser QA for:
   - switching chats during active stream
   - repeated resume/reconnect while streaming
   - one chat failing while another visibly keeps working
3. a more explicitly ugly bad-day stress pass exercising:
   - timeout
   - nonzero worker exit
   - reconnect churn
   - multi-chat overlap
   - no runtime/thread/process leakage after repeated cycles
4. operator-grade visibility so incidents are easy to classify from runtime/status output alone

## Practical interpretation

This pass did not reveal a new architectural blocker.

That is important.

The remaining work now looks like:
- sign-off hardening
- broader live validation
- stronger containment/diagnostics polish

rather than:
- another foundational redesign of warm/session ownership or stream architecture

## Related docs

- `docs/plans/2026-04-03-miniapp-two-track-implementation-status.md`
- `docs/plans/2026-04-03-miniapp-backend-swap-updated-todo-checklist.md`
- `docs/plans/2026-04-03-miniapp-warmer-handoff-status.md`
- `docs/plans/2026-04-04-miniapp-worker-owned-warm-continuity-qa-checklist.md`

## Recommended next move

If continuing immediately, the next best pass is:
- live multi-chat/browser sign-off QA focused on tab-switch + reconnect + one-chat-fails/other-chat-lives behavior

That would be the most direct remaining evidence for calling backend swap effectively done by the stricter product definition.