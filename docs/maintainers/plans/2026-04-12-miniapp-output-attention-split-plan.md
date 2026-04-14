# Mini App Output / Unread / Haptics Split Implementation Plan

> For Hermes: use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Split transcript authority, unread/notification/haptic effects, and resume/fetch orchestration into smaller, behavior-preserving modules so output bugs become easier to reason about and stop recurring.

**Architecture:** Keep `static/app.js` as composition only. Move “what is the canonical transcript?” decisions into one runtime authority helper, move “should we vibrate / increment unread / dedupe sensory effects?” into one attention-effects helper, and make `chat_history_helpers.js` / `stream_controller.js` consume those helpers instead of mutating overlapping truth directly.

**Tech Stack:** Browser JS modules via existing `window.HermesMiniapp*` pattern, Node `--test` `.mjs` runtime suites, existing Mini App static script wiring via `templates/app.html` and `server.py` no-store handling.

---

## Why this plan exists

We have now fixed multiple real races in the output bug family:
- cached-open hydration delay
- visible resume activation ordering
- stale prefetch cache poisoning
- duplicate finalize append
- inactive terminal reconciliation clobbering newer truth
- hydration-time haptic lag
- same-turn duplicate preserve conflicts

The repeated pattern is architectural:
- too many paths can write transcript/cache/meta truth
- sensory effects are spread across stream, hydrate, and visibility flows
- unread dots can update before active transcript hydration
- speculative/non-visible fetches can still influence visible behavior

This plan is intentionally behavior-preserving. It is not a redesign. It is a separation of responsibilities so future fixes happen in one obvious place.

---

## Current code reality to preserve

Primary files currently owning the bug family:
- `static/chat_history_helpers.js`
- `static/stream_controller.js`
- `static/runtime_unread_helpers.js`
- `static/visibility_skin_helpers.js`
- `static/app.js`

Existing test anchors already covering the bug family:
- `tests/chat_history_open_hydrate.test.mjs`
- `tests/chat_history_read_mutation.test.mjs`
- `tests/chat_history_visibility_sync.test.mjs`
- `tests/stream_controller_resume_finalize.test.mjs`
- `tests/stream_controller_policy_session.test.mjs`
- `tests/frontend_runtime_unread_latency.test.mjs`
- `tests/runtime_app_delegation.test.mjs`
- `tests/template_startup_script_order.test.mjs`

Non-negotiable invariants:
1. Exactly-once final assistant output per turn.
2. Speculative/non-activating history fetches must never overwrite stronger visible truth.
3. Visible active-chat resume must prioritize transcript catch-up over tab metadata refresh.
4. Unread dots, haptics, and first-assistant notifications must be deduped by stable keys.
5. Pending/final transitions must remain idempotent across stream, hydrate, and reconnect paths.

---

## Target module boundaries

### 1. Transcript authority layer
New file:
- `static/runtime_transcript_authority.js`

This module becomes the only place that decides:
- append vs replace vs ignore vs preserve
- stale vs same-turn vs newer-turn assistant conflict resolution
- whether speculative hydrate/prefetch/reconcile results are allowed to commit
- stable transcript signatures / advancement checks

Ownership to move here from existing files:
- assistant/body/signature helpers from `static/chat_history_helpers.js`
- `preserveLatestCompletedAssistantMessage(...)` and related transcript-signature helpers from `static/stream_controller.js`
- stale/lagging history commit checks currently embedded in cached-open/prefetch/reconcile logic

### 2. Attention effects layer
New file:
- `static/runtime_attention_effects.js`

This module becomes the only place that decides:
- when to increment unread
- when to fire a haptic
- when a notification/haptic is already consumed
- how first-assistant chunk vs final reply vs visible hydration are deduped

Ownership to move here from existing files:
- `latestCompletedAssistantHapticKey(...)`
- `triggerIncomingMessageHaptic(...)`
- `incrementUnread(...)`
- first-assistant notification state from `static/stream_controller.js`
- hydration-time haptic gating currently in `static/chat_history_helpers.js`

### 3. Orchestration layer remains where it is
Files staying as orchestrators, not truth-owners:
- `static/chat_history_helpers.js`
- `static/stream_controller.js`
- `static/visibility_skin_helpers.js`
- `static/app.js`

Their job after this refactor:
- fetch
- choose `activate:true/false`
- call authority helper to decide commit behavior
- call attention helper to decide unread/haptic effects
- render results

They should stop owning transcript merge rules or sensory dedupe logic inline.

---

## Task 1: Baseline the current behavior contract before moving code

**Objective:** Freeze the existing output/unread/haptic behavior with focused contract tests so extraction cannot silently regress the known bug fixes.

**Files:**
- Modify: `tests/chat_history_open_hydrate.test.mjs`
- Modify: `tests/chat_history_visibility_sync.test.mjs`
- Modify: `tests/stream_controller_resume_finalize.test.mjs`
- Modify: `tests/frontend_runtime_unread_latency.test.mjs`
- Optional helper updates: `tests/chat_history_test_harness.mjs`, `tests/stream_controller_test_harness.mjs`

**Step 1: Add failing contract tests for the exact bug-family invariants**

Add or tighten focused assertions for:
- unread cached open hydrates immediately and does not defer to idle
- visible resume hydrates active chat before `refreshChats`
- stale prefetch cannot downgrade unread/pending metadata
- inactive terminal reconcile cannot clear pending if transcript did not advance
- same-turn finalized assistant conflict resolves to one output only
- hydration-visible unread reply can trigger one haptic only
- first assistant chunk + final hydrate cannot cause two haptics for the same completed reply

**Step 2: Run the focused suite before refactor**

Run:
`node --test tests/chat_history_open_hydrate.test.mjs tests/chat_history_visibility_sync.test.mjs tests/stream_controller_resume_finalize.test.mjs tests/frontend_runtime_unread_latency.test.mjs`

Expected:
PASS with the current implementation before extraction starts.

**Step 3: Commit the contract-test baseline**

Run:
`git add tests/chat_history_open_hydrate.test.mjs tests/chat_history_visibility_sync.test.mjs tests/stream_controller_resume_finalize.test.mjs tests/frontend_runtime_unread_latency.test.mjs tests/chat_history_test_harness.mjs tests/stream_controller_test_harness.mjs && git commit -m "test: freeze output and attention race contracts"`

---

## Task 2: Extract the transcript authority helper

**Objective:** Create one pure helper module that owns transcript conflict resolution and stale-commit decisions.

**Files:**
- Create: `static/runtime_transcript_authority.js`
- Modify: `static/chat_history_helpers.js`
- Modify: `static/stream_controller.js`
- Test: `tests/runtime_transcript_authority.test.mjs`
- Modify: `tests/template_startup_script_order.test.mjs`
- Modify: `templates/app.html`
- Modify: `server.py`

**Step 1: Write failing direct helper tests**

Create `tests/runtime_transcript_authority.test.mjs` with cases for:
- `latestCompletedAssistantRecord(...)`
- same-turn local-final vs hydrated-final conflict chooses one output
- newer-turn hydrated output beats older local output
- inactive terminal reconcile with unchanged transcript is rejected
- lagging prefetch/unread downgrade is rejected
- transcript advancement signature ignores irrelevant reorder-free noise and detects real assistant-output change

**Step 2: Run the new test to verify failure**

Run:
`node --test tests/runtime_transcript_authority.test.mjs`

Expected:
FAIL because `static/runtime_transcript_authority.js` does not exist yet.

**Step 3: Implement the helper module**

Create `static/runtime_transcript_authority.js` exporting a global like:
- `window.HermesMiniappRuntimeTranscriptAuthority`

Include pure helpers such as:
- `latestCompletedAssistantRecord(history)`
- `countUserMessagesThroughIndex(history, endIndex)`
- `transcriptRenderSignature(history)`
- `resolveCompletedAssistantConflict(previousHistory, incomingHistory)`
- `shouldCommitSpeculativeHistory({ currentChat, incomingChat, currentHistory, incomingHistory, source, isActiveChat })`
- `didTranscriptMateriallyAdvance(previousHistory, incomingHistory)`

`source` must support at least:
- `activate-open`
- `visible-resume`
- `prefetch`
- `inactive-terminal-reconcile`

**Step 4: Wire `stream_controller.js` to consume the helper**

Replace inline ownership of:
- `latestCompletedAssistantRecord(...)`
- `countUserMessagesThroughIndex(...)`
- `preserveLatestCompletedAssistantMessage(...)`
- transcript advancement helpers used in force-complete reconcile

with delegation to `HermesMiniappRuntimeTranscriptAuthority`.

**Step 5: Wire `chat_history_helpers.js` to consume the helper**

Replace inline ownership of transcript/staleness helpers used by:
- cached-open hydrate application
- prefetch commit guards
- visible-resume reconciliation
- duplicate-finalization prevention

with helper calls.

**Step 6: Wire the script into the app shell**

Update:
- `templates/app.html` to load `static/runtime_transcript_authority.js` before `chat_history_helpers.js` and `stream_controller.js`
- `server.py` static no-store handling if needed for the new asset
- `tests/template_startup_script_order.test.mjs` to assert the new script order

**Step 7: Run syntax and targeted tests**

Run:
`node --check static/runtime_transcript_authority.js static/chat_history_helpers.js static/stream_controller.js`

Then run:
`node --test tests/runtime_transcript_authority.test.mjs tests/chat_history_open_hydrate.test.mjs tests/chat_history_visibility_sync.test.mjs tests/stream_controller_resume_finalize.test.mjs tests/template_startup_script_order.test.mjs`

Expected:
PASS

**Step 8: Commit**

Run:
`git add static/runtime_transcript_authority.js static/chat_history_helpers.js static/stream_controller.js templates/app.html server.py tests/runtime_transcript_authority.test.mjs tests/chat_history_open_hydrate.test.mjs tests/chat_history_visibility_sync.test.mjs tests/stream_controller_resume_finalize.test.mjs tests/template_startup_script_order.test.mjs && git commit -m "refactor: extract miniapp transcript authority runtime"`

---

## Task 3: Extract the attention-effects helper

**Objective:** Centralize unread, first-assistant notification, and haptic dedupe/state transitions into one runtime-owned controller.

**Files:**
- Create: `static/runtime_attention_effects.js`
- Modify: `static/runtime_unread_helpers.js`
- Modify: `static/stream_controller.js`
- Modify: `static/chat_history_helpers.js`
- Modify: `static/app.js`
- Test: `tests/runtime_attention_effects.test.mjs`
- Modify: `tests/frontend_runtime_unread_latency.test.mjs`
- Modify: `tests/runtime_app_delegation.test.mjs`
- Modify: `tests/template_startup_script_order.test.mjs`
- Modify: `templates/app.html`
- Modify: `server.py`

**Step 1: Write failing direct helper tests**

Create `tests/runtime_attention_effects.test.mjs` for:
- stable completed-reply dedupe key generation
- no duplicate haptic on repeated hydrate/render of same final reply
- first assistant chunk increments unread once for non-active/hidden chat
- visible hydration of a newer completed unread reply triggers exactly one haptic
- active visible chat does not increment unread on early assistant chunk
- hidden active chat does increment unread

**Step 2: Run the test to verify failure**

Run:
`node --test tests/runtime_attention_effects.test.mjs`

Expected:
FAIL because the new module does not exist yet.

**Step 3: Implement `static/runtime_attention_effects.js`**

Export a global like:
- `window.HermesMiniappRuntimeAttentionEffects`

Create controllers/functions such as:
- `latestCompletedAssistantEffectKey(...)`
- `shouldIncrementUnread(...)`
- `nextUnreadCount(...)`
- `createAttentionEffectsController(...)`
- `createFirstAssistantNotificationController(...)`
- `shouldTriggerHydrationAttentionEffect(...)`

The controller should own mutable stores for:
- incoming haptic keys
- first-assistant notification state by chat
- “already consumed” completed reply keys

**Step 4: Collapse `runtime_unread_helpers.js` into a compatibility shim or retire it**

Preferred behavior-preserving approach:
- keep `static/runtime_unread_helpers.js` as a thin shim delegating to `runtime_attention_effects.js`
- do not break current `app.js` global lookup patterns in one pass

**Step 5: Rewire `stream_controller.js`**

Move first-assistant notification ownership out of `stream_controller.js`.
The stream controller should call a runtime attention controller instead of storing its own per-chat notification map.

**Step 6: Rewire `chat_history_helpers.js` hydration haptic logic**

Hydration-time haptic decisions should call the shared attention helper, not locally compare/dedupe keys inline.

**Step 7: Rewire `app.js` wrappers**

`app.js` should instantiate one attention controller and keep wrappers only for:
- `latestCompletedAssistantHapticKey(...)`
- `triggerIncomingMessageHaptic(...)`
- `incrementUnread(...)`

If compatibility wrappers remain, the delegation tests must be updated to assert the new runtime-owned controller.

**Step 8: Wire the new script into the page**

Update:
- `templates/app.html`
- `server.py`
- `tests/template_startup_script_order.test.mjs`

**Step 9: Run syntax and targeted tests**

Run:
`node --check static/runtime_attention_effects.js static/runtime_unread_helpers.js static/app.js static/chat_history_helpers.js static/stream_controller.js`

Then run:
`node --test tests/runtime_attention_effects.test.mjs tests/frontend_runtime_unread_latency.test.mjs tests/runtime_app_delegation.test.mjs tests/chat_history_visibility_sync.test.mjs tests/stream_controller_policy_session.test.mjs tests/stream_controller_resume_finalize.test.mjs tests/template_startup_script_order.test.mjs`

Expected:
PASS

**Step 10: Commit**

Run:
`git add static/runtime_attention_effects.js static/runtime_unread_helpers.js static/stream_controller.js static/chat_history_helpers.js static/app.js templates/app.html server.py tests/runtime_attention_effects.test.mjs tests/frontend_runtime_unread_latency.test.mjs tests/runtime_app_delegation.test.mjs tests/chat_history_visibility_sync.test.mjs tests/stream_controller_policy_session.test.mjs tests/stream_controller_resume_finalize.test.mjs tests/template_startup_script_order.test.mjs && git commit -m "refactor: extract miniapp attention effects runtime"`

---

## Task 4: Make speculative history writers consume the authority helper uniformly

**Objective:** Remove remaining ad hoc “is this stale?” logic so all non-visible writers go through the same commit policy.

**Files:**
- Modify: `static/chat_history_helpers.js`
- Modify: `static/stream_controller.js`
- Test: `tests/chat_history_open_hydrate.test.mjs`
- Test: `tests/chat_history_visibility_sync.test.mjs`
- Test: `tests/stream_controller_resume_finalize.test.mjs`

**Step 1: Identify every non-authoritative history writer**

Audit and annotate call sites for:
- cached-open hydration
- prefetch/warm cache hydration
- visible active-chat resume hydration
- inactive terminal reconciliation hydrate
- any remaining `loadChatHistory(..., { activate: false })` commit path

**Step 2: Replace inline checks with one authority decision call**

Each non-authoritative writer must call something like:
`shouldCommitSpeculativeHistory({ source, currentChat, incomingChat, currentHistory, incomingHistory, isActiveChat })`

No remaining path should open-code unread/pending downgrade checks or transcript-advance checks differently.

**Step 3: Add/extend tests proving source-specific policy**

Add or tighten cases for:
- `prefetch` cannot clobber a chat that became active mid-flight
- `inactive-terminal-reconcile` cannot clear pending without transcript advancement
- `visible-resume` can commit even when unread markers are weak, because it is authoritative for the active visible chat
- `activate-open` remains the strongest source and should win over stale speculative state

**Step 4: Run the focused suite**

Run:
`node --test tests/chat_history_open_hydrate.test.mjs tests/chat_history_visibility_sync.test.mjs tests/stream_controller_resume_finalize.test.mjs`

Expected:
PASS

**Step 5: Commit**

Run:
`git add static/chat_history_helpers.js static/stream_controller.js tests/chat_history_open_hydrate.test.mjs tests/chat_history_visibility_sync.test.mjs tests/stream_controller_resume_finalize.test.mjs && git commit -m "refactor: unify speculative history commit policy"`

---

## Task 5: Make output rendering consume transcript authority instead of scattered heuristics

**Objective:** Ensure output display decisions use one canonical transcript decision path before render/update.

**Files:**
- Modify: `static/chat_history_helpers.js`
- Modify: `static/render_trace_helpers.js` or current visible-message patch helper module(s) if touched
- Modify: `static/stream_controller.js`
- Tests: update any affected stream/chat-history suites

**Step 1: Route pending-to-final transitions through authority helpers**

Before any append/replace visible update, resolve the transcript mutation through the authority helper so exactly-once output remains guaranteed.

**Step 2: Verify same-turn conflict handling in both hydrate and stream completion flows**

The following paths must share the same conflict policy:
- hydrate replacing stale finalized output
- stream done replacing pending output
- reconnect completion replacing local stale output

**Step 3: Run targeted duplicate/missing-output suites**

Run:
`node --test tests/stream_controller_resume_finalize.test.mjs tests/chat_history_read_mutation.test.mjs tests/chat_history_open_hydrate.test.mjs`

Expected:
PASS

**Step 4: Commit**

Run:
`git add static/chat_history_helpers.js static/stream_controller.js static/render_trace_helpers.js tests/stream_controller_resume_finalize.test.mjs tests/chat_history_read_mutation.test.mjs tests/chat_history_open_hydrate.test.mjs && git commit -m "refactor: centralize output conflict handling before render"`

---

## Task 6: Full app-shell wiring verification for new runtime modules

**Objective:** Make sure the new split actually ships correctly in production-like conditions.

**Files:**
- Modify: `templates/app.html`
- Modify: `server.py`
- Modify: `tests/template_startup_script_order.test.mjs`
- Optional: `tests/test_routes_meta.py` or any existing static-header/test coverage if present

**Step 1: Verify script order contracts**

The new runtime scripts must load before modules that consume them:
1. `runtime_transcript_authority.js`
2. `runtime_attention_effects.js`
3. `runtime_unread_helpers.js` shim if retained
4. `chat_history_helpers.js`
5. `stream_controller.js`
6. `app.js`

**Step 2: Verify no-store headers**

The new static files must be included in whatever logic currently forces `Cache-Control: no-store` for app JS.

**Step 3: Run wiring tests**

Run:
`node --test tests/template_startup_script_order.test.mjs tests/runtime_app_delegation.test.mjs`

If Python-side static/header tests exist, also run the relevant targeted suite.

**Step 4: Commit**

Run:
`git add templates/app.html server.py tests/template_startup_script_order.test.mjs tests/runtime_app_delegation.test.mjs && git commit -m "test: lock runtime split script wiring"`

---

## Task 7: End-to-end validation pass and manual QA

**Objective:** Prove the split preserved behavior and improved maintainability without reopening the output bug family.

**Files:**
- No new files required unless follow-up notes are needed

**Step 1: Run the scoped JS suite**

Run:
`node --test tests/runtime_transcript_authority.test.mjs tests/runtime_attention_effects.test.mjs tests/chat_history_open_hydrate.test.mjs tests/chat_history_read_mutation.test.mjs tests/chat_history_visibility_sync.test.mjs tests/stream_controller_policy_session.test.mjs tests/stream_controller_resume_finalize.test.mjs tests/frontend_runtime_unread_latency.test.mjs tests/runtime_app_delegation.test.mjs tests/template_startup_script_order.test.mjs`

Expected:
PASS

**Step 2: Syntax-check all touched JS files**

Run:
`node --check static/runtime_transcript_authority.js static/runtime_attention_effects.js static/runtime_unread_helpers.js static/chat_history_helpers.js static/stream_controller.js static/visibility_skin_helpers.js static/app.js`

Expected:
PASS

**Step 3: Reload the Mini App and execute QA scenarios**

Manual scenarios to run:
1. Leave app while active chat is pending; reply finishes while away; return to same chat.
2. Leave app while a different chat is pending; return and open that chat from unread dot.
3. Repeat both scenarios on desktop.
4. Confirm no duplicate final output in release/artifact chats.
5. Confirm unread dot and visible output/haptic land together or near-together with no stale lag.

**Step 4: Record any remaining issue by source class**

If a bug remains, classify it before coding:
- transcript authority bug
- speculative commit policy bug
- attention dedupe bug
- server freshness bug

This classification is the main payoff of the split.

**Step 5: Final commit if any QA-only note changes were needed**

Use a message like:
`git commit -m "test: document miniapp output split validation"`

---

## Implementation notes and guardrails

1. Do not redesign payload shapes or response contracts in this pass.
2. Do not move rendering DOM code into the new runtime helpers.
3. Keep new helpers pure where possible; mutable stores belong in explicit controllers only.
4. Prefer compatibility shims over big-bang renames.
5. Any helper that decides “stronger vs weaker truth” must be directly unit-tested.
6. Preserve existing Telegram/mobile behavior; no haptic style changes in this pass.
7. If a test currently asserts brittle app.js strings, move ownership assertions to the new helper file and keep app.js checks delegation-only.

---

## Suggested execution order

1. Task 1 — freeze contracts
2. Task 2 — transcript authority extraction
3. Task 3 — attention effects extraction
4. Task 4 — unify speculative writer policy
5. Task 5 — centralize output conflict handling before render
6. Task 6 — lock app-shell wiring
7. Task 7 — QA + sign-off

---

## Expected outcome

After this refactor:
- transcript truth has one authority module
- unread/notification/haptic decisions have one authority module
- stream/history/visibility files orchestrate instead of deciding truth inline
- duplicate and missing-output bugs become classifiable instead of spooky
- future fixes should require touching one narrow module instead of three large ones
