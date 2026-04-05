# Miniapp Reload/Resume Blocker Notes

Date: 2026-04-04
Project: /home/hermes-agent/workspace/active/hermes_miniapp_v4

## Purpose

This note captures the follow-up investigation after the live sign-off pass found that browser reload/resume could leave the UI looking stuck.

## Initial hypothesis

The first hypothesis was frontend stale-state reconciliation:
- reply becomes visible
- but local pending state is not cleared
- send stays disabled because hydrated history re-marked the chat as pending after terminal completion

A small hardening fix was added for that case:
- `stream_controller.js` now lets `hydrateChatAfterGracefulResumeCompletion(..., { forceCompleted: true })`
- done-path hydration forces local `chat.pending = false` so a stale history response cannot re-mark a completed chat pending

This fix is still worth keeping because it hardens terminal reconciliation against stale hydration races.

## What live repro showed next

A fresh live repro against `https://app.cronpulse.app` showed the deeper issue was not just frontend stale state.

Observed sequence before the deeper fix:
1. Start a tool-heavy prompt.
2. Reload mid-stream.
3. Re-open the active chat.
4. Final reply text becomes visible.
5. UI still shows:
   - send disabled
   - `STREAM: RECONNECTING ...` or `STREAM: RUNNING ...`
6. Server `/api/chats/status` still reports:
   - `pending = true`
7. After a much longer delay (roughly tens of seconds), server pending finally flips false and UI recovers.

## Important conclusion

This meant the blocker was not purely a browser-side stale-state bug.

The browser was reflecting a real server-side pending/open-job condition.

## Root cause found

The deeper root cause turned out to be subprocess detached-worker completion timing.

What actually happened:
- the subprocess launcher could already have seen:
  - `attach_ready`
  - normal terminal `done`
- but it kept the original job path open waiting for later terminal/control-plane completion instead of detaching immediately
- that delayed `execute_chat_job(...)` finishing, which delayed:
  - assistant message persistence
  - `store.complete_job(job_id)`
  - clearing server-side `pending`

That is why live repros could show:
- final reply visible
- yet `pending = true` on `/api/chats/status`
- and disabled send / reconnecting-running UI until much later

## Fix that landed

Backend/runtime fix:
- `job_runtime_worker_launcher.py` now detaches immediately after a normal `done` once `attach_ready` has already been seen
- the original request/job is treated as complete at that point
- later worker lifetime is warm-owner lifecycle, not part of the original job completion contract

Frontend hardening kept:
- `hydrateChatAfterGracefulResumeCompletion(..., { forceCompleted: true })`

## Validation already completed

Still green after the follow-up changes:
- `node --test tests/stream_controller.test.mjs tests/chat_history_helpers.test.mjs tests/frontend_runtime.test.mjs`
- `python -m pytest tests/test_job_runtime_worker_launcher.py tests/test_job_runtime_chat_job.py tests/test_routes_chat.py tests/test_hermes_client.py tests/test_streaming_hardening_guards.py -q`

Additional regression lock added:
- detached warm-worker subprocess path now has a test ensuring launcher returns promptly after `done` once `attach_ready` is known, without waiting on later process teardown

## Final live re-check

After restarting the live miniapp backend service and re-running the browser reload/resume scenario:
- final reply became visible
- send re-enabled
- stream chip returned to complete
- source settled to queue
- server-side `pending` was false

Observed successful end state:
- `STREAM: COMPLETE · <chat>`
- `SOURCE: QUEUE`
- send enabled
- server pending false

## Status

Current status:
- frontend stale-hydration race: hardened
- backend/runtime delayed detached-worker completion path: fixed
- live reload/resume blocker: closed in follow-up live verification after service restart
