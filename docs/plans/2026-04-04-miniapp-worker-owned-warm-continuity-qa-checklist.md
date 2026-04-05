# Miniapp Worker-Owned Warm Continuity — QA Checklist

Date: 2026-04-04
Project: /home/hermes-agent/workspace/active/hermes_miniapp_v4

## Purpose

Use this checklist whenever changing the bounded worker-owned warm continuity path.

It is meant to be short enough for routine regression passes, while still covering the live behaviors that were easy to break during implementation:
- first-turn queue/SSE terminal handoff
- same-worker second-turn attach
- contract refresh before attached `done`
- explicit clear/remove invalidation
- attach-deadline expiry
- browser UI recovery from running/pending back to normal send state

Linked context:
- `docs/plans/2026-04-03-miniapp-warmer-handoff-status.md`
- `docs/plans/2026-04-03-miniapp-worker-owned-warm-session-contract.md`
- `docs/plans/2026-04-03-miniapp-backend-swap-updated-todo-checklist.md`

## Fast code/test regression gate

Run at minimum:
`python -m pytest tests/test_job_runtime_chat_job.py tests/test_routes_chat.py tests/test_job_runtime_worker_launcher.py tests/test_hermes_client.py -q`

Current known-good reference result:
- `172 passed in 8.90s`

If you changed routing or lifecycle surfaces more broadly, also consider:
- `tests/test_routes_jobs_runtime.py`
- reconnect / frontend stream-controller tests

## API verification checklist

### A. First-turn queue/SSE termination
Goal:
- prove the original queue-backed stream ends with a real terminal `done`, not synthetic DB-state recovery

Checklist:
1. Create a fresh chat.
2. Send a first ordinary `/api/chat/stream` request.
3. Confirm the terminal event is:
   - `event: done`
4. Confirm the terminal payload includes warm handoff metadata when the worker is preserved:
   - `persistent_mode = warm-detached`
   - `warm_handoff = true`
   - `session_id`
5. Confirm you do NOT see synthetic recovery output like:
   - `event: error`
   - `job_status: dead`
   - `detail: stream recovered from terminal db state`

### B. Live owner becomes attachable
Goal:
- prove the first turn leaves behind a reusable isolated worker instead of a dead one-shot child

Checklist:
1. While or immediately after the first stream runs, inspect `/api/runtime/status`.
2. Find the record for the chat session.
3. Confirm it becomes:
   - `state = attachable_running`
4. Confirm live attach metadata is present:
   - `attach_worker_endpoint`
   - `attach_resume_token`
   - `attach_resume_deadline_ms`
5. Confirm aggregate diagnostics reflect only truly attachable sessions:
   - `live_attach_ready_count`
   - `live_attach_ready_session_ids`

### C. Second ordinary turn reuses the same worker
Goal:
- prove warm continuity works through a normal next turn

Checklist:
1. In the same chat, send a second ordinary turn.
2. Confirm the turn succeeds normally.
3. Confirm the stream also ends with:
   - `event: done`
4. Confirm runtime/diagnostics still point at the same isolated owner continuity path rather than a cold fallback.

### D. Direct attach contract refresh
Goal:
- prove attached resume refreshes the contract for the next turn before terminal completion

Checklist:
1. Attach via the live attach transport when available.
2. Submit a `warm_attach_resume` request.
3. Confirm the stream yields a successful terminal `done`.
4. Before that `done`, confirm a refreshed `attach_ready` contract is observed and consumed.
5. Confirm the refreshed contract rotates:
   - `resume_token`
   - `resume_deadline_ms`

## Mutation and expiry checklist

### E. Clear invalidation
1. Trigger `/api/chats/clear` for a chat with a warm owner.
2. Confirm final owner record is:
   - `state = evicted`
   - `reusability_reason = invalidated_by_clear`
3. Confirm a later worker-finished update does not overwrite that final state.

### F. Remove invalidation
1. Trigger `/api/chats/remove` for a chat with a warm owner.
2. Confirm final owner record is:
   - `state = evicted`
   - `reusability_reason = invalidated_by_remove`
3. Confirm a later worker-finished update does not overwrite that final state.

### G. Attach-deadline expiry
1. Create a fresh chat and let the first turn establish an attachable worker.
2. Do not attach.
3. Wait past `attach_resume_deadline_ms`.
4. Confirm final owner record is:
   - `state = expired`
   - `reusability_reason = attach_resume_deadline_expired`
5. Confirm aggregate diagnostics clear live attachability:
   - `live_attach_ready_count = 0`

## Browser walkthrough checklist

Use the real miniapp UI at `https://app.cronpulse.app/app`.

Checklist:
1. Sign in with the current dev-auth flow.
2. Open a fresh chat.
3. Send the first prompt.
4. Confirm the reply renders normally.
5. Confirm the composer/status transitions from running state back to normal idle state:
   - `Sending…` / running
   - then normal send-ready state
6. Send a second prompt in the same chat.
7. Confirm the second reply also renders normally.
8. Confirm the final browser state shows:
   - `source: queue`
   - `stream: complete`
   - textbox enabled
   - send button restored
9. Confirm the UI is not stuck pending after either turn.

Known-good live walkthrough examples that previously passed:
- first visible reply: `FIRST-OK`
- second visible reply in same chat: `THIRD-OK`

## Failure signatures worth treating as regressions

Treat these as real regressions, not cosmetic noise:
- first-turn stream ends with synthetic recovery error instead of `done`
- first turn destroys the warm owner before second-turn reuse
- second ordinary turn cold-starts instead of attaching to same worker when a valid owner exists
- `worker_finished` overwrites `evicted` or `expired` final states
- contract refresh arrives after attached `done` and is therefore missed
- `live_attach_ready_count` remains nonzero for expired/evicted sessions
- browser UI stays in pending/running state after backend completion

## Suggested live QA order

For a compact end-to-end pass, use this order:
1. run targeted pytest gate
2. verify first-turn `done` over API
3. verify attachable runtime status
4. verify second ordinary turn in same chat
5. verify clear/remove invalidation
6. verify expiry behavior in a fresh chat
7. verify browser UI walkthrough

## Handoff note

If any of these checks start failing, update both:
- this checklist
- `docs/plans/2026-04-03-miniapp-warmer-handoff-status.md`

Do not leave the docs describing a state that live QA no longer supports.