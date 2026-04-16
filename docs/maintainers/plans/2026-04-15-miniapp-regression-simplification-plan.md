# Mini App Regression Simplification Plan

> For Hermes: use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Reduce the duplicate-message, late-arrival, and unread-dot regression surface by collapsing transcript reconciliation and read-state authority into fewer explicit seams.

**Architecture:** Keep the existing Mini App behavior and route contracts, but stop letting hydrate/resume/reopen/read logic derive truth in multiple places. Introduce one canonical transcript reconcile decision path, one pending/snapshot merge path, and one read/unread authority path. Preserve the current UI and endpoint behavior unless a step explicitly calls out a contract fix.

**Tech Stack:** Browser JS runtime helpers loaded through `templates/app.html`, Node `--test` `.mjs` suites via `scripts/test.sh node`, Flask/Python route tests via `scripts/test.sh py`, and existing Mini App route/service modules.

---

## Why this plan exists

The previous split improved the situation, but the regressions are creeping back because authority is still split across:
- `static/runtime_transcript_authority.js`
- `static/runtime_history_helpers.js`
- `static/runtime_hydration_state.js`
- `static/runtime_hydration_apply.js`
- `static/runtime_visible_history_sync.js`
- `static/runtime_read_state.js`
- `static/stream_state_helpers.js`
- `static/stream_controller.js`
- `routes_chat_management_service.py`
- `routes_auth_service.py`

The sharpest currently-live risk points are:
1. `preserveLatestCompletedAssistantMessage(...)` can still append or revive the wrong final assistant when same-turn/body heuristics drift.
2. `mergeHydratedHistory(...)` plus `restorePendingStreamSnapshot(...)` can preserve or replay stale pending rows after the server already has a completed transcript.
3. `applyHydratedServerState(...)` mutates chat/history state before the outer caller finishes staleness validation.
4. visible hydration currently evaluates read-clearing before resume reattachment.
5. unread preservation policy is duplicated inside `runtime_read_state.js`.
6. `reopen_chat_response(...)` returns a `chat` payload fetched before `mark_chat_read(...)`, so the returned `chat` can disagree with returned `chats`.

---

## Non-negotiable invariants

1. Exactly one completed assistant output per user turn unless the server truly persisted multiple separate assistant turns.
2. A completed server transcript must beat stale local pending/snapshot state.
3. Hidden/open/reopen hydration must not mutate the wrong active chat after a stale request.
4. Read/unread state must be derived from one authoritative policy, not several helpers that happen to agree.
5. Reopen/open/history payloads must not disagree about the same chat’s unread metadata.
6. File-ref-only serialization differences must never create duplicate assistant rows.

---

## Current code reality to preserve

Primary frontend files in scope:
- `static/runtime_transcript_authority.js`
- `static/runtime_history_helpers.js`
- `static/runtime_hydration_state.js`
- `static/runtime_hydration_apply.js`
- `static/runtime_hydration_flow.js`
- `static/runtime_visible_history_sync.js`
- `static/runtime_read_state.js`
- `static/stream_state_helpers.js`
- `static/stream_controller.js`

Primary backend files in scope:
- `routes_chat_management_service.py`
- `routes_chat_sync.py`
- `routes_auth_service.py`
- `store_chats.py`
- `server.py`

Existing tests already covering parts of this family:
- `tests/runtime_transcript_authority.test.mjs`
- `tests/runtime_hydration_apply.test.mjs`
- `tests/runtime_hydration_state.test.mjs`
- `tests/runtime_visible_history_sync.test.mjs`
- `tests/stream_state_helpers.test.mjs`
- `tests/chat_history_open_hydrate.test.mjs`
- `tests/test_routes_chat_management_service.py`
- `tests/test_routes_chat.py`
- `tests/test_routes_auth_service.py`

---

## Task 1: Freeze the current regression surface with adversarial tests

**Objective:** Add tests for the exact blind spots that are currently letting the bug family sneak back in.

**Files:**
- Modify: `tests/runtime_transcript_authority.test.mjs`
- Modify: `tests/runtime_hydration_apply.test.mjs`
- Modify: `tests/runtime_hydration_state.test.mjs`
- Modify: `tests/runtime_visible_history_sync.test.mjs`
- Modify: `tests/stream_state_helpers.test.mjs`
- Modify: `tests/chat_history_open_hydrate.test.mjs`
- Modify: `tests/test_routes_chat_management_service.py`
- Modify: `tests/test_routes_auth_service.py`

**Step 1: Add failing transcript-authority edge tests**

Add direct cases for:
- `hydratedCompletionMatchesVisibleLocalPending(...)` returning false when local and server replies only share a long prefix but are semantically different.
- `hydratedCompletionMatchesVisibleLocalPending(...)` returning false when local state only has pending tool rows and no assistant identity.
- `preserveLatestCompletedAssistantMessage(...)` refusing to append the previous local final when the incoming final differs only by file-ref serialization or trailing formatting.
- `historiesDiffer(...)` and/or its replacement comparator detecting meaningful non-tail changes.

**Step 2: Add failing pending/snapshot interaction tests**

Add cases for:
- `mergeHydratedHistory(...)` refusing the relaxed singleton pending match when only role/pending state aligns.
- `restorePendingStreamSnapshot(...)` not appending stale pending rows after an equivalent completed assistant already exists.
- restore ordering when history already contains completed assistant/tool rows.

**Step 3: Add failing hydration stale-request tests**

Add cases for:
- `applyHydratedServerState(...)` not committing stale second-pass retry results after active chat/request generation changes.
- visible hydration not clearing unread before pending resume has had a chance to reattach.

**Step 4: Add failing backend payload-consistency tests**

Add a route/service test asserting that `reopen_chat_response(...)` returns `chat.unread_count` and `chat.newest_unread_message_id` that match the corresponding row inside `chats`.

Add an auth/bootstrap test asserting pending recovery refreshes payload state after `ensure_pending_jobs(...)` if pending chats existed.

**Step 5: Run the focused suites**

Run:
`./scripts/test.sh node tests/runtime_transcript_authority.test.mjs tests/runtime_hydration_apply.test.mjs tests/runtime_hydration_state.test.mjs tests/runtime_visible_history_sync.test.mjs tests/stream_state_helpers.test.mjs tests/chat_history_open_hydrate.test.mjs`

Run:
`./scripts/test.sh py tests/test_routes_chat_management_service.py tests/test_routes_auth_service.py -q`

Expected before implementation:
- New tests fail on the currently identified blind spots.
- Existing passing tests remain valid and act as behavior guardrails.

---

## Task 2: Introduce one canonical transcript comparator and one canonical assistant reconciliation path

**Objective:** Stop using different definitions of “same transcript” and “same assistant reply” in different flows.

**Files:**
- Modify: `static/runtime_transcript_authority.js`
- Modify: `static/runtime_history_helpers.js`
- Modify: `static/runtime_hydration_state.js`
- Modify: `static/runtime_hydration_flow.js`
- Modify: `static/runtime_visible_history_sync.js`
- Modify: `static/stream_controller.js`
- Test: `tests/runtime_transcript_authority.test.mjs`
- Test: `tests/chat_history_open_hydrate.test.mjs`

**Step 1: Add an explicit canonical comparator in `runtime_transcript_authority.js`**

Implement one helper, for example:
- `canonicalTranscriptSignature(history, { includeUiState = false } = {})`
- `transcriptChangedMeaningfully(previousHistory, nextHistory)`

This should replace or sharply narrow `historiesDiffer(...)`.

Rules:
- compare assistant/tool/user rows, pending/final state, and file refs
- do not rely on tail-only checks
- keep UI-only differences like `collapsed` optional so callers choose whether they matter

**Step 2: Replace same-turn/body heuristics with one assistant-instance reconciliation path**

Refactor `preserveLatestCompletedAssistantMessage(...)` and `hydratedCompletionMatchesVisibleLocalPending(...)` so they share one explicit assistant matching primitive, for example:
- exact persisted message id when available
- otherwise stable assistant-instance signature based on role/body/created_at/file_refs
- otherwise explicit “no match” rather than prefix heuristics that silently force a match

**Step 3: Update all callers to use the canonical comparator**

Touch these callers:
- hydration render decisions in `runtime_hydration_state.js`
- open/hydrate flow in `runtime_hydration_flow.js`
- visible sync in `runtime_visible_history_sync.js`
- graceful resume completion in `stream_controller.js`

**Step 4: Re-run focused JS tests**

Run:
`./scripts/test.sh node tests/runtime_transcript_authority.test.mjs tests/chat_history_open_hydrate.test.mjs`

Expected:
- new adversarial tests pass
- existing same-turn/noop/finalization tests still pass

---

## Task 3: Separate “server says pending” from “preserve local pending while reconciling”

**Objective:** Remove the semantic overload where `preservePendingState` gets passed as if it were `chatPending`.

**Files:**
- Modify: `static/runtime_hydration_state.js`
- Modify: `static/runtime_history_helpers.js`
- Modify: `static/stream_state_helpers.js`
- Modify: `static/runtime_hydration_apply.js`
- Test: `tests/runtime_hydration_state.test.mjs`
- Test: `tests/stream_state_helpers.test.mjs`
- Test: `tests/runtime_hydration_apply.test.mjs`

**Step 1: Split hydration merge inputs**

Change the `mergeHydratedHistory(...)` contract from:
- `chatPending`

to something like:
- `serverPending`
- `preserveLocalPending`
- `allowSnapshotRestore`

This is the key simplification seam.

**Step 2: Make merge logic refuse weak singleton matches**

In `runtime_history_helpers.js`, remove or sharply narrow the branch that matches a pending row just because it is the only same-role pending candidate.

Prefer:
- persisted `id`
- exact `created_at`
- exact normalized body for assistant pending reconciliation
- monotonic tool-journal extension only for tool rows

**Step 3: Make snapshot restore completion-aware**

In `stream_state_helpers.js`, add a pure helper that merges snapshot state into hydrated history without blindly appending pending rows.

Rules:
- never restore a pending assistant if an equivalent completed assistant already exists
- never restore a pending tool if a completed tool trace already semantically supersedes it
- preserve ordering relative to existing tool/assistant boundaries

**Step 4: Keep `applyHydratedServerState(...)` pure until commit time**

Refactor `runtime_hydration_apply.js` so it computes the final hydrated result first, then returns a pure result object. Avoid mutating `histories`/`chats` from inside the retry loop.

**Step 5: Re-run focused JS tests**

Run:
`./scripts/test.sh node tests/runtime_hydration_state.test.mjs tests/stream_state_helpers.test.mjs tests/runtime_hydration_apply.test.mjs`

Expected:
- pending preservation still works when truly needed
- completed hydrates stop reviving stale pending rows

---

## Task 4: Unify active hydration and visible hydration commit ordering

**Objective:** Make open-hydrate and visibility-hydrate follow the same commit sequence so regressions stop coming from two “almost-the-same” orchestration paths.

**Files:**
- Modify: `static/runtime_hydration_flow.js`
- Modify: `static/runtime_visible_history_sync.js`
- Modify: `static/runtime_visible_hydration.js`
- Modify: `static/runtime_read_state.js`
- Test: `tests/runtime_visible_history_sync.test.mjs`
- Test: `tests/chat_history_open_hydrate.test.mjs`

**Step 1: Define one commit order**

Make both paths follow this order:
1. fetch
2. optional retry
3. stale-request validation
4. transcript reconciliation
5. single commit to history/chat state
6. render decision
7. render if needed
8. pending resume decision
9. read-threshold/read-clear decision
10. haptic/unread side effects

**Step 2: Reorder visible sync so resume happens before mark-read evaluation**

In `runtime_visible_history_sync.js`, move `visibilityResumeController.maybeResumeVisibilitySync(...)` ahead of `maybeMarkRead(...)`, or explicitly gate `maybeMarkRead(...)` on the post-resume transcript state.

**Step 3: Ensure stale-request checks happen after any retry fetch and before any commit**

The caller should validate request freshness using the final fetched result, not just the first pass.

**Step 4: Re-run focused JS tests**

Run:
`./scripts/test.sh node tests/runtime_visible_history_sync.test.mjs tests/chat_history_open_hydrate.test.mjs tests/runtime_hydration_apply.test.mjs`

Expected:
- stale second-pass hydration cannot mutate the active chat
- visible reopen/resume cannot clear unread too early

---

## Task 5: Collapse unread preservation and read-clearing policy into one authority in `runtime_read_state.js`

**Objective:** Remove duplicate unread-preservation rules and make all read-clearing decisions flow through one policy surface.

**Files:**
- Modify: `static/runtime_read_state.js`
- Modify: `static/runtime_visible_history_sync.js`
- Modify: `static/runtime_hydration_apply.js`
- Test: `tests/runtime_visible_history_sync.test.mjs`
- Test: `tests/frontend_runtime_unread_latency.test.mjs`
- Test: `tests/chat_history_read_mutation.test.mjs`

**Step 1: Consolidate duplicated preservation logic**

Today `runtime_read_state.js` effectively has multiple unread-preservation paths. Collapse them into one exported policy surface, e.g.:
- `buildChatPreservingUnread(...)`
- `shouldMarkReadNow(...)`
- `finalizeHydratedPendingState(...)`

All call sites should go through those helpers instead of embedding small local variants.

**Step 2: Make activation-threshold semantics explicit**

Document and encode the distinct states:
- server unread metadata
- local activation-threshold block
- unseen live stream activity
- optimistic mark-read in flight

The UI unread dot should derive from those states, not from scattered local exceptions.

**Step 3: Add a combined regression test**

Cover:
- active visible chat
- hydrated final reply arrives
- activation threshold is armed
- pending resume occurs
- unread is preserved until the user actually reaches the threshold

**Step 4: Re-run focused JS tests**

Run:
`./scripts/test.sh node tests/frontend_runtime_unread_latency.test.mjs tests/chat_history_read_mutation.test.mjs tests/runtime_visible_history_sync.test.mjs`

Expected:
- unread dot behavior becomes more predictable without changing the intended UX

---

## Task 6: Fix backend payload inconsistencies that are feeding frontend reconciliation churn

**Objective:** Remove server-side contradictions so the frontend no longer has to reconcile disagreeing truths.

**Files:**
- Modify: `routes_chat_management_service.py`
- Modify: `routes_auth_service.py`
- Modify: `routes_chat_sync.py` if normalization is shared
- Modify: `server.py` only if serialization wiring changes
- Test: `tests/test_routes_chat_management_service.py`
- Test: `tests/test_routes_auth_service.py`
- Test: `tests/test_routes_chat.py`

**Step 1: Re-fetch chat after reopen mark-read**

In `reopen_chat_response(...)`:
- reopen chat
- mark chat read
- set active chat
- re-fetch the chat row
- serialize that fresh row in `payload["chat"]`

This should eliminate one active unread-dot mismatch immediately.

**Step 2: Make bootstrap pending recovery return refreshed data**

In `routes_auth_service.py`, run `ensure_pending_jobs(...)` before serializing chats/history, or refresh the payload after recovery if pending chats were present.

**Step 3: Normalize assistant-role serialization for synthetic pending rows**

Choose one API-facing assistant role, ideally `hermes`, across:
- persisted history serialization
- synthetic checkpoint-derived pending history
- bootstrap payloads

If that is too risky for one pass, add a small shared normalizer and update the frontend tests first.

**Step 4: Re-run backend tests**

Run:
`./scripts/test.sh py tests/test_routes_chat_management_service.py tests/test_routes_auth_service.py tests/test_routes_chat.py -q`

Expected:
- reopen payload consistency tests pass
- bootstrap/auth tests reflect the refreshed pending state

---

## Task 7: Final integration sweep

**Objective:** Confirm the simplified flow behaves correctly across the exact bug family that motivated this work.

**Files:**
- No new production files required unless a shared helper emerges during implementation.
- Tests touched across the files above.

**Step 1: Run the focused regression battery**

Run:
`./scripts/test.sh node tests/runtime_transcript_authority.test.mjs tests/runtime_hydration_apply.test.mjs tests/runtime_hydration_state.test.mjs tests/runtime_visible_history_sync.test.mjs tests/stream_state_helpers.test.mjs tests/chat_history_open_hydrate.test.mjs tests/frontend_runtime_unread_latency.test.mjs tests/chat_history_read_mutation.test.mjs`

Run:
`./scripts/test.sh py tests/test_routes_chat_management_service.py tests/test_routes_auth_service.py tests/test_routes_chat.py -q`

**Step 2: Optional broader sweep**

Run:
`./scripts/test.sh node`

If Python env/time allows:
`./scripts/test.sh py -q`

**Step 3: Manual QA checklist**

Verify in the Mini App:
- reopen a pending chat while a reply is finishing
- reopen a completed chat with unread history
- hide/show the app during a pending stream
- let a reply finish while hidden, then reopen
- confirm one assistant final only, one unread-dot decision only, and no restored stale pending rows

---

## Commit strategy

Use review-friendly commits in this order:
1. `test: add regression guards for transcript and unread edge cases`
2. `refactor: unify transcript reconciliation authority`
3. `refactor: split server pending from local pending preservation`
4. `refactor: unify visible hydration and read ordering`
5. `fix: return refreshed unread state on reopen and bootstrap`

---

## Success criteria

This plan is complete when:
- transcript comparison no longer relies on tail-only heuristics
- forced completion hydration cannot duplicate or revive the wrong assistant final
- snapshot restore cannot re-add stale pending rows after a completed hydrate
- visible hydration does not clear unread before transcript catch-up/resume
- reopen payload `chat` metadata matches `chats`
- bootstrap returns state after pending-job recovery, not before it

---

## Notes from this review

I re-ran the current focused JS suites before writing this plan:
`node --test tests/runtime_transcript_authority.test.mjs tests/runtime_hydration_apply.test.mjs tests/runtime_hydration_state.test.mjs tests/runtime_visible_history_sync.test.mjs tests/stream_state_helpers.test.mjs`

Current result before new guard tests:
- 33 tests passed
- 0 failed

That confirms the problem is not “the tests are already red.” The problem is that the most dangerous edge combinations are still under-specified, so the system can regress while the current suites stay green.
