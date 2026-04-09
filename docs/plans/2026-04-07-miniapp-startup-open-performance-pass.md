# Miniapp Startup / Open Performance Pass

> For Hermes: start from current main only. Do not revive the old startup experiment patch. Measure first, then optimize one narrow slice at a time.

Goal: Make the Mini App open feel faster and cleaner without reintroducing risky startup regressions.

Architecture: Keep the current startup flow and script loading model intact at first. Add lightweight timing instrumentation around the real boot path, identify the slowest stage in live use, and only then optimize the single worst stage. Avoid broad template or script-order rewrites until data proves they are necessary.

Tech Stack: Telegram Mini App frontend, vanilla JS modules loaded from templates/app.html, existing boot metrics hooks in static/app.js, existing render trace / runtime helpers.

---

## Current boot-path understanding

Observed startup flow on current main:
1. templates/app.html paints the shell immediately and sets boot skin from localStorage/server boot skin.
2. static/app.js bootstrap starts and records boot stages.
3. bootstrap performs small local setup work:
   - syncRenderTraceBadge
   - loadDraftsFromStorage
   - syncClosingConfirmation
   - syncFullscreenControlState
   - syncDevAuthUi
4. bootstrap checks binding health and possible version mismatch reload.
5. bootstrap waits for /api/auth via fetchAuthBootstrapWithRetry().
6. applyAuthBootstrap() performs the first real app hydration:
   - set auth-facing UI
   - set skin
   - syncChats
   - syncPinnedChats
   - set active chat meta
   - renderPinnedChats
   - renderMessages(activeId)
   - warmChatHistoryCache()
   - maybe resumePendingChatStream(activeId)
7. bootstrap finally reveals any final UI state and records the finished stage.

Likely first-render/open bottlenecks:
- network wait for /api/auth
- initial active-chat renderMessages(activeId)
- warmChatHistoryCache() happening in the bootstrap path
- immediate pending-stream resume when the active chat is pending
- chat/tab hydration work done synchronously before the app feels interactive

Non-goals for the first pass:
- changing all scripts from defer to non-defer
- hiding the whole app shell before bootstrap
- removing boot metrics/logging
- broad template/startup rewrites without measurement

---

## Success criteria

We should be able to answer these with data, not guesses:
- How long from app script start to auth request start?
- How long does /api/auth take?
- How long does applyAuthBootstrap take?
- How long does first renderMessages(activeId) take?
- How long after bootstrap starts does the app become visually useful?
- Which single stage is the main contributor on real opens?

We should also preserve these behavioral constraints:
- no blank-screen regressions
- no startup-order/bootstrap mismatch regressions
- no worse auth/bootstrap recovery behavior
- no new pending/resume bugs

---

## Phase 1: Add measurement only

### Task 1: Extend boot timing capture around the real startup stages

Objective: Record the exact boundaries that matter for perceived open time.

Files:
- Modify: static/app.js
- Test: optional targeted JS assertions only if helper extraction is added

Add / keep explicit boot stage markers for:
- app-script-start
- bootstrap-start
- telegram-webapp-ready
- auth-request-start
- auth-response-ok / auth-response-failed
- auth-bootstrap-applied-start
- auth-bootstrap-applied-finished
- initial-render-finished
- pending-stream-resume-triggered (when applicable)
- bootstrap-finished

Important rule:
- add measurement only
- do not change startup behavior in this task

Suggested implementation shape:
- continue using the existing bootMetrics / logBootStage mechanism
- add missing stage markers immediately before and after:
  - fetchAuthBootstrapWithRetry()
  - applyAuthBootstrap()
  - first renderMessages() path
  - warmChatHistoryCache() trigger
  - resumePendingChatStream() trigger
- keep console.info payloads compact and machine-readable

Verification:
- open the app in browser devtools
- confirm ordered boot logs appear once per open
- confirm logs still appear on auth failure and success paths

### Task 2: Make applyAuthBootstrap stage boundaries explicit

Objective: Separate network time from hydration/render time.

Files:
- Modify: static/bootstrap_auth_helpers.js and/or static/app.js depending on where the lightest instrumentation seam fits

Record timestamps/stages around:
- syncChats
- syncPinnedChats
- renderPinnedChats
- renderMessages(activeId)
- warmChatHistoryCache()
- resumePendingChatStream(activeId)

Important rule:
- if adding direct stage logging inside applyAuthBootstrap feels too invasive, start with just a single surrounding timer around the whole function and one around renderMessages(activeId)
- prefer the smallest useful seam

Verification:
- confirm logs distinguish:
  - auth network time
  - bootstrap hydration time
  - first active transcript render time

### Task 3: Decide on a compact operator-visible startup report

Objective: Make timing review easy after a live open.

Files:
- Modify: static/app.js only if needed

Add a compact summary log at bootstrap end, for example:
- total open ms
- auth wait ms
- auth apply ms
- first render ms
- resumed pending boolean
- chat count
- active chat id

Important rule:
- console output only for now
- do not add new visible UI affordances yet

Verification:
- after app open, a single summary line should make the slowest stage obvious

---

## Phase 2: Optimize exactly one worst stage

Only start this after live measurement identifies the dominant cost.

### Candidate A: /api/auth dominates

Possible fixes:
- trim auth payload work
- reduce server-side bootstrap work
- avoid sending unnecessary history/data in the initial bootstrap if not needed
- lazy-load non-critical data after first interactive paint

### Candidate B: applyAuthBootstrap hydration dominates

Possible fixes:
- defer warmChatHistoryCache() until after first render
- render tabs/chat shell first, then warm cache in idle time or next tick
- avoid redundant render passes when there is no visible change

### Candidate C: first renderMessages(activeId) dominates

Possible fixes:
- skip expensive active transcript work when history is small/simple
- avoid synchronous work not required for first visible paint
- defer non-critical metadata decoration until after visible content lands

### Candidate D: pending-stream resume dominates perceived open

Possible fixes:
- separate “usable UI ready” from “resume pending stream now”
- let the app become visibly ready first, then attach/resume the stream on the next turn of the event loop
- preserve correctness while moving resume out of the critical first-paint path

Important rule for Phase 2:
- optimize only one candidate at a time
- rerun measurement after each change
- stop if the gain is not real

---

## First implementation slice I recommend

Implement only this first:
1. add explicit stage markers around:
   - auth request start/end
   - applyAuthBootstrap start/end
   - first renderMessages(activeId) start/end
   - warmChatHistoryCache trigger
   - pending-stream resume trigger
2. add one compact bootstrap-end summary log
3. do a live open and inspect the timings before touching behavior

Why this is the right first slice:
- zero-risk compared with startup rewrites
- gives us a real bottleneck map
- keeps current stable startup behavior intact
- prevents another “felt promising but caused problems” iteration

---

## Verification commands

Targeted test bundle to keep running while instrumenting:
- node --test tests/bootstrap_auth_helpers.test.mjs tests/visibility_skin_helpers.test.mjs tests/frontend_runtime.test.mjs
- python -m pytest -q tests/test_frontend_runtime.py tests/test_routes_chat.py tests/test_hermes_client.py

Live verification checklist:
1. Open the Mini App fresh.
2. Capture console boot logs.
3. Note:
   - time to visible shell
   - time to Signed in status
   - time to first active transcript visible
   - whether pending-stream resume happened
4. Repeat on:
   - empty/no-active-chat open
   - active chat with ordinary history
   - active pending chat that resumes

---

## Recommendation

Do not change startup behavior yet.
The best immediate next move is a measurement-only pass on current main.
Once timing data exists, choose one narrow bottleneck and optimize just that slice.