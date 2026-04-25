# Refactor Plan — hermes-miniapp-v4

> Canonical active plan file (live source of truth).
> Detailed execution history and refresh evidence live in `docs/maintainers/history/refactor-log.hermes-miniapp-v4.md`.
> Historical refresh snapshot archived at `docs/maintainers/archive/refactor-plans/refactor-plan.hermes-miniapp-v4.refresh-2026-03-27.md`.

## Project snapshot
- Project: hermes-miniapp-v4
- Project slug: hermes-miniapp-v4
- Generated: 2026-04-23T16:47:24Z
- Plan maintenance note: Compacted on 2026-04-11 so this file stays focused on active work; older completed-item detail and refresh evidence live in `docs/maintainers/history/refactor-log.hermes-miniapp-v4.md`.
- Branch: refactor/r73-r75-integration
- Git status summary: clean (`git status --short --branch` shows `## refactor/r73-r75-integration...origin/main [ahead 2]` after stitching the completed slices).
- Analysis mode: integration pass that stitched completed backlog items R73, R74, R75, and R77 onto a fresh non-live worktree branched from `origin/main`.
- Validation snapshot:
  - `/home/hermes-agent/workspace/active/hermes_miniapp_v4/.venv/bin/python -m py_compile job_runtime_worker_launcher.py job_runtime_chat_job.py job_runtime_worker_launcher_subprocess.py hermes_client.py tests/test_job_runtime_worker_launcher.py tests/test_job_runtime_chat_job.py tests/test_hermes_client.py` → passed.
  - `/home/hermes-agent/workspace/active/hermes_miniapp_v4/.venv/bin/python -m pytest -q tests/test_job_runtime_worker_launcher.py -k "register_failed or memory_sample or descendant or subprocess"` → `27 passed, 4 deselected`.
  - `/home/hermes-agent/workspace/active/hermes_miniapp_v4/.venv/bin/python -m pytest -q tests/test_job_runtime_chat_job.py -k "evict_session or done"` → `5 passed, 20 deselected`.
  - `/home/hermes-agent/workspace/active/hermes_miniapp_v4/.venv/bin/python -m pytest -q tests/test_hermes_client.py -k "child_spawn or descendant or recall_health"` → `9 passed, 108 deselected`.
  - `node --check static/chat_admin_helpers.js && node --check tests/chat_admin_helpers.test.mjs && node --test tests/chat_admin_helpers.test.mjs` → `38 passed`.
  - Independent review gates previously passed on the source branches for R73, R74, R75, and R77; the stitched branch now also has combined scoped validation.

## Progress metrics

- Total items: 79
- Done: 76
- In progress: 0
- Blocked: 0
- Todo: 3
- % complete: 96%
- Last completed item: R75 (Fail-open child memory/descendant diagnostics and shrink spawn-tracker lock scope)
- Last updated: 2026-04-23T16:47:24Z

## Next up

- R76: Isolate or gate optional `visual_dev_*` schema from core store startup
- R78: Add direct persistence/normalization coverage for ordered tab state and isolate open-request authority from `static/app.js`
- R79: Guarantee a final visible render/reset when `suppressColdOpenRender` meets an uncached empty hydrate

Note: “Next up” is only a prioritized subset, not the full backlog.

## Recently completed

- R75 (2026-04-23): Hardened child-process telemetry so subprocess memory sampling is strictly best-effort and child/descendant diagnostics stop doing procfs/host-memory reads while holding `_spawn_tracker_lock`. `SubprocessStreamLifecycle.maybe_emit_memory_sample(...)` now swallows telemetry-sampling failures after debug logging, while `HermesClient.observe_child_process_sample(...)` and `observe_descendant_finish(...)` snapshot counts/records under lock, release the lock for `/proc` + host-memory reads, and only reacquire it to append the final event payload. Added regression coverage proving failed memory sampling no longer breaks the stream and that both snapshot collectors execute outside the tracker lock. Validation: `python3 -m py_compile hermes_client.py job_runtime_worker_launcher_subprocess.py tests/test_hermes_client.py tests/test_job_runtime_worker_launcher.py`, `python3 -m pytest -q tests/test_job_runtime_worker_launcher.py -k "memory_sample or descendant or subprocess"` (`26 passed, 4 deselected`), and `python3 -m pytest -q tests/test_hermes_client.py -k "child_spawn or descendant or recall_health"` (`9 passed, 108 deselected`).
- R77 (2026-04-23): Hardened `removeActiveChat(...)` reconciliation by centralizing post-remove UI refresh through `reconcilePostRemoveRender(...)`, so optimistic close, rollback, explicit no-active-chat, lightweight reopen, and authoritative server-active paths all refresh tab-strip, pinned list, and transcript state coherently without duplicate production tab renders. Updated the chat-admin harness to mirror runtime meta-render behavior and added direct assertions for rollback, no-active-chat, and lightweight-response reopen tab-strip refresh. Validation: `node --test tests/chat_admin_helpers.test.mjs` (`38 passed`).
- R74 (2026-04-23): Made post-`done` chat-job completion resilient to session-eviction failures without opening a same-chat claim race by keeping eviction ahead of `complete_job(...)` but guarding it with best-effort failure handling and a `finally` completion path. Added regression coverage proving `done` still persists/completes when eviction raises while preserving warm-detached owner semantics. Validation: `.venv/bin/python -m pytest -q tests/test_job_runtime_chat_job.py -k "evict_session or done"` (`5 passed, 20 deselected`) and `.venv/bin/python -m pytest -q tests/test_job_runtime_chat_job.py` (`25 passed`).
- R73 (2026-04-23): Hardened subprocess register-failure cleanup by keeping `register_child_spawn(...)` failures inside the shared lifecycle/finalize contract, extracting `mark_subprocess_setup_failure(...)`, and adding regression coverage proving the orphaned child is SIGKILLed/reaped, stderr is captured/closed, and launcher diagnostics are updated consistently when registration raises. Validation: `.venv/bin/python -m pytest -q tests/test_job_runtime_worker_launcher.py -k "register_failed or subprocess"` (`26 passed, 4 deselected`) and `.venv/bin/python -m pytest -q tests/test_job_runtime_worker_launcher.py` (`30 passed`).
- R72 (2026-04-12): Continued decomposing `static/chat_history_helpers.js` by extracting unread-preservation shaping (`createUnreadPreservationController(...)`), shared hydrate/apply/retry orchestration (`createHydrationApplyController(...)`), and visibility-resume policy (`createVisibilityResumeController(...)`). Rewired `createReadSyncController(...)` and `createHistoryHydrationController(...)` so read-threshold preservation, unread-retry application, and visibility-driven resume decisions no longer live inline in the larger hydration/open wrappers. Kept the exported facade stable and validated with `node --check static/chat_history_helpers.js tests/chat_history_test_harness.mjs tests/chat_history_open_hydrate.test.mjs tests/chat_history_read_mutation.test.mjs tests/chat_history_visibility_sync.test.mjs tests/chat_history_app_delegation.test.mjs` and `node --test tests/chat_history_open_hydrate.test.mjs tests/chat_history_read_mutation.test.mjs tests/chat_history_visibility_sync.test.mjs tests/chat_history_app_delegation.test.mjs` (`73 passed`).
- R71 (2026-04-12): Continued decomposing `static/stream_controller.js` by extracting event-specific helper bands (`createStreamMetaEventController(...)`, `createToolTraceEventController(...)`, `createAssistantChunkEventController(...)`, `createStreamErrorEventController(...)`) plus direct consume/read-loop helpers (`createTranscriptBufferController(...)`, `createTranscriptReadLoopController(...)`). This leaves `createStreamNonTerminalEventController(...)` and `createTranscriptConsumeController(...)` as orchestration glue over smaller session/consume ownership seams. Validated with `node --check static/stream_controller.js tests/stream_controller_policy_session.test.mjs tests/stream_controller_response.test.mjs tests/stream_controller_resume_finalize.test.mjs tests/frontend_runtime_stream_activity.test.mjs tests/stream_controller_app_delegation.test.mjs` and `node --test tests/stream_controller_policy_session.test.mjs tests/stream_controller_response.test.mjs tests/stream_controller_resume_finalize.test.mjs tests/frontend_runtime_stream_activity.test.mjs tests/stream_controller_app_delegation.test.mjs` (`54 passed` for the stream-focused subset, green in the combined app-shell validation batch).
- R70 (2026-04-12): Continued shrinking `static/app.js` by splitting large dependency-builders into narrower composition helpers: `createChatTabsControllerStateDeps(...)`, `createChatTabsControllerUiDeps(...)`, `createChatTabsControllerPolicyDeps(...)`, `createBootstrapAuthControllerSessionDeps(...)`, `createBootstrapAuthControllerAppDeps(...)`, `createBootstrapAuthControllerBootstrapDeps(...)`, `createStartupBindingsControllerElementDeps(...)`, `createStartupBindingsControllerInteractionDeps(...)`, and `createStartupBindingsControllerBootstrapDeps(...)`. Kept the existing app-shell wrappers stable and validated with `node --check static/app.js tests/bootstrap_auth_app_delegation.test.mjs tests/chat_tabs_app_delegation.test.mjs tests/interaction_app_delegation.test.mjs tests/render_trace_history_app_delegation.test.mjs tests/template_startup_script_order.test.mjs tests/startup_bindings_app_delegation.test.mjs` and `node --test tests/bootstrap_auth_app_delegation.test.mjs tests/chat_tabs_app_delegation.test.mjs tests/interaction_app_delegation.test.mjs tests/render_trace_history_app_delegation.test.mjs tests/template_startup_script_order.test.mjs tests/startup_bindings_app_delegation.test.mjs` (`17 passed` for the app-shell subset, green in the combined batch).
## Backlog summary
- High: 1
- Medium: 2
- Low: 0

## Active backlog

- [x] R73: Harden subprocess register-failure cleanup and finalization in `job_runtime_worker_launcher.py`
  - Status: done
  - Severity: High
  - Scope/files: `job_runtime_worker_launcher.py`, `job_runtime_worker_launcher_subprocess.py`, `tests/test_job_runtime_worker_launcher.py`.
  - Why it matters: `_stream_events_via_subprocess(...)` still has an early return when `_register_spawn(...)` fails, so the child stderr temp file never enters the normal finalize path and the process is only best-effort killed. This is a live failure-mode gap in a touched launcher seam.
  - Proposed change: Move process creation/registration under one finalize/cleanup contract or explicitly close/wait/finalize on register failure so error bookkeeping and resource cleanup stay consistent.
  - Validation steps:
    - `.venv/bin/python -m pytest -q tests/test_job_runtime_worker_launcher.py -k "register_failed or subprocess"`
    - `.venv/bin/python -m pytest -q tests/test_job_runtime_worker_launcher.py`
  - Notes/dependencies: Closed 2026-04-23 by routing register-child failures through the shared subprocess lifecycle/finalize path, adding `mark_subprocess_setup_failure(...)`, and covering the register-failure branch with direct assertions for SIGKILL/reap, stderr closure, and final launcher diagnostics. Validation: `.venv/bin/python -m pytest -q tests/test_job_runtime_worker_launcher.py -k "register_failed or subprocess"` (`26 passed, 4 deselected`) and `.venv/bin/python -m pytest -q tests/test_job_runtime_worker_launcher.py` (`30 passed`).
- [x] R74: Make post-`done` chat-job completion resilient to session-eviction failures
  - Status: done
  - Severity: High
  - Scope/files: `job_runtime_chat_job.py`, `tests/test_job_runtime_chat_job.py`.
  - Why it matters: after publishing the terminal `done` payload, `execute_chat_job(...)` still calls `runtime.client.evict_session(session_id)` before `runtime.store.complete_job(job_id)`. If eviction raises, the reply is already persisted but the job can stay stuck running.
  - Proposed change: complete/store terminal job state before best-effort runtime eviction, or protect eviction with a narrow guard/finally path so completion cannot be skipped after reply persistence.
  - Validation steps:
    - `.venv/bin/python -m pytest -q tests/test_job_runtime_chat_job.py -k "evict_session or done"`
    - `.venv/bin/python -m pytest -q tests/test_job_runtime_chat_job.py`
  - Notes/dependencies: Closed 2026-04-23 by guarding post-`done` eviction with best-effort failure logging and a `finally` completion path so completion cannot be skipped if eviction raises, while preserving the original eviction-before-completion ordering for non-warm sessions and keeping `attachable_running` warm-owner semantics intact. Validation: `.venv/bin/python -m pytest -q tests/test_job_runtime_chat_job.py -k "evict_session or done"` (`5 passed, 20 deselected`) and `.venv/bin/python -m pytest -q tests/test_job_runtime_chat_job.py` (`25 passed`).
- [x] R75: Fail-open child memory/descendant diagnostics and shrink spawn-tracker lock scope
  - Status: done
  - Severity: High
  - Scope/files: `job_runtime_worker_launcher_subprocess.py`, `hermes_client.py`, `tests/test_job_runtime_worker_launcher.py`, `tests/test_hermes_client.py`.
  - Why it matters: `maybe_emit_memory_sample(...)` currently lets `observe_child_process_sample(...)` exceptions escape the hot stream loop, and `observe_child_process_sample(...)` / `observe_descendant_finish(...)` still do `/proc` and host-memory reads while holding `_spawn_tracker_lock`.
  - Proposed change: make telemetry sampling strictly best-effort, catch/report diagnostics failures without affecting the stream contract, and move procfs/meminfo collection outside the critical lock so spawn bookkeeping remains low-latency.
  - Validation steps:
    - `.venv/bin/python -m pytest -q tests/test_job_runtime_worker_launcher.py -k "memory_sample or descendant or subprocess"`
    - `.venv/bin/python -m pytest -q tests/test_hermes_client.py -k "child_spawn or descendant or recall_health"`
  - Notes/dependencies: Closed 2026-04-23 by making subprocess memory sampling fail-open in `job_runtime_worker_launcher_subprocess.py` and shrinking `_spawn_tracker_lock` scope in `hermes_client.py` so `/proc` and host-memory reads happen outside the critical section. Added direct regression coverage in `tests/test_job_runtime_worker_launcher.py` and `tests/test_hermes_client.py` for memory-sample failure tolerance plus the lock-scope contract around child/descendant snapshot collection. Validation: `python3 -m py_compile hermes_client.py job_runtime_worker_launcher_subprocess.py tests/test_hermes_client.py tests/test_job_runtime_worker_launcher.py` (passed), `python3 -m pytest -q tests/test_job_runtime_worker_launcher.py -k "memory_sample or descendant or subprocess"` (`26 passed, 4 deselected`), and `python3 -m pytest -q tests/test_hermes_client.py -k "child_spawn or descendant or recall_health"` (`9 passed, 108 deselected`).

- [ ] R76: Isolate or gate optional `visual_dev_*` schema from core store startup
  - Status: todo
  - Severity: High
  - Scope/files: `store_schema.py`, store/schema tests, and any new visual-dev schema helper/module.
  - Why it matters: `_init_db()` now always calls `_ensure_visual_dev_schema(...)`, but the current repo scan still shows `visual_dev_*` only in `store_schema.py`. Optional tooling is increasing startup/migration blast radius without a live runtime consumer or dedicated tests.
  - Proposed change: extract visual-dev DDL into a dedicated helper/module and either gate its startup invocation behind an explicit feature flag or defer creation until the feature actually exists.
  - Validation steps:
    - `.venv/bin/python -m pytest -q tests/test_store.py -k "schema or startup"`
    - `.venv/bin/python -m pytest -q tests/test_routes_meta.py -k "startup or helper"`
  - Notes/dependencies: If the schema stays enabled, add direct migration/init coverage for table creation, indexes, and missing-session invariants.

- [x] R77: Harden `removeActiveChat(...)` optimistic close / rollback tab-strip reconciliation
  - Status: done
  - Severity: High
  - Scope/files: `static/chat_admin_helpers.js`, `tests/chat_admin_helpers.test.mjs`.
  - Why it matters: the optimistic next-chat branch calls `renderTabs()`, but rollback and explicit no-active-chat paths currently rerender pinned/messages only. That leaves a stale-tab-strip risk in exactly the edge cases users notice most.
  - Proposed change: centralize post-remove render reconciliation so success, rollback, and no-active-chat paths all refresh tab-strip, pinned list, and active transcript state coherently.
  - Validation steps:
    - `node --test tests/chat_admin_helpers.test.mjs`
    - Add direct assertions for rollback, no-active-chat, and lightweight-response reopen paths.
  - Notes/dependencies: Closed 2026-04-23 by centralizing remove-flow UI refresh in `reconcilePostRemoveRender(...)`, using targeted forced tab renders only when `setActiveChatMeta(..., { fullTabRender: false })` needs an explicit tab-strip refresh, and aligning the test harness with real runtime meta-render behavior. Validation: `node --test tests/chat_admin_helpers.test.mjs` (`38 passed`).
- [ ] R78: Add direct persistence/normalization coverage for ordered tab state and isolate open-request authority from `static/app.js`
  - Status: todo
  - Severity: Medium
  - Scope/files: `static/chat_tabs_helpers.js`, `static/app.js`, `tests/chat_tabs_helpers.test.mjs`, `tests/test_chat_tabs_order_persistence.py` or equivalent JS suite(s).
  - Why it matters: ordered tab persistence is now durable cross-session UX state, but there is still no direct test coverage for malformed JSON recovery, dedupe/pruning, or storage-write failure behavior. At the same time, `lastOpenChatRequestId` remains a brittle global counter in `static/app.js`.
  - Proposed change: add direct storage-contract tests for ordered ids and extract a small open-request authority/token helper so optimistic admin flows stop mutating a raw app-global counter.
  - Validation steps:
    - `node --test tests/chat_tabs_helpers.test.mjs`
    - Add a focused suite for ordered-tab persistence / request invalidation wiring, then run it directly.
  - Notes/dependencies: Preserve existing visual tab order and current optimistic-next-chat winner semantics.

- [ ] R79: Guarantee a final visible render/reset when `suppressColdOpenRender` meets an uncached empty hydrate
  - Status: todo
  - Severity: Medium
  - Scope/files: `static/runtime_open_flow.js`, `static/runtime_hydration_flow.js`, `static/runtime_transcript_authority.js`, `tests/runtime_open_flow.test.mjs`, `tests/runtime_hydration_flow.test.mjs`.
  - Why it matters: when `openChat(..., { suppressColdOpenRender: true })` targets an uncached empty chat, hydration can settle with `shouldRenderActiveHistory=false`, which risks completing the open without any final render/reset for the newly active chat.
  - Proposed change: guarantee one final render or equivalent rendered-chat reset for suppressed cold opens whose hydrated transcript is still empty, so stale prior chat content cannot linger visually.
  - Validation steps:
    - `node --test tests/runtime_open_flow.test.mjs tests/runtime_hydration_flow.test.mjs tests/runtime_transcript_authority.test.mjs`
  - Notes/dependencies: This should be a contract clarification, not a regression back to unnecessary rerenders for append-only cached hydrates.

- [x] R64: Extract app-shell dependency assembly and deferred helper ownership out of `static/app.js`
  - Status: done
  - Severity: High
  - Scope/files: `static/app.js`, `templates/app.html`, app-shell delegation tests, and any new helper/composition module(s) introduced for dependency assembly.
  - Why it matters: `static/app.js` has regrown to 3061 LOC. The largest remaining seams are no longer product behaviors; they are app-shell composition bands like `createStartupBindingsControllerDeps(...)` (~122 LOC), `createBootstrapAuthControllerDeps(...)` (~108 LOC), `createChatTabsControllerDeps(...)` (~96 LOC), and `createDeferredControllerHelper(...)` (~75 LOC). That keeps `app.js` as a giant dependency registry instead of a thin composition root.
  - Proposed change: Move controller-dependency factories and late-bound helper/deferred controller ownership into dedicated app-shell composition helpers so `app.js` is closer to state assembly + top-level wiring only.
  - Validation steps:
    - `node --check static/app.js tests/bootstrap_auth_app_delegation.test.mjs tests/chat_tabs_app_delegation.test.mjs tests/interaction_app_delegation.test.mjs tests/render_trace_history_app_delegation.test.mjs tests/template_startup_script_order.test.mjs`
    - `node --test tests/bootstrap_auth_app_delegation.test.mjs tests/chat_tabs_app_delegation.test.mjs tests/interaction_app_delegation.test.mjs tests/render_trace_history_app_delegation.test.mjs tests/template_startup_script_order.test.mjs`
  - Notes/dependencies: Closed 2026-04-12 by extracting deferred facade plumbing plus controller-construction wrappers (`createChatTabsController(...)`, `createBootstrapAuthController(...)`, `createStartupBindingsController(...)`) inside `app.js`, keeping script order/global names stable and locking the new seams with app-delegation tests.

- [x] R65: Continue decomposing `static/chat_history_helpers.js` hydration/open/read-threshold policy
  - Status: done
  - Severity: High
  - Scope/files: `static/chat_history_helpers.js`, `tests/chat_history_open_hydrate.test.mjs`, `tests/chat_history_read_mutation.test.mjs`, `tests/chat_history_visibility_sync.test.mjs`, and harness/support files.
  - Why it matters: `static/chat_history_helpers.js` is still 1717 LOC. The biggest remaining ownership bands are `createHistoryHydrationController(...)` (~257 LOC), `createHistoryOpenController(...)` (~174 LOC), and `createReadThresholdController(...)` (~173 LOC). Cached-open deferral, unread threshold gating, hydration retry policy, and pending snapshot restoration still live too close together.
  - Proposed change: Carve hydration merge/retry, cached-open scheduling, and unread activation-threshold policy into narrower helper bands so open/hydrate/read-sync correctness no longer depends on one large controller family.
  - Validation steps:
    - `node --check static/chat_history_helpers.js tests/chat_history_test_harness.mjs tests/chat_history_open_hydrate.test.mjs tests/chat_history_read_mutation.test.mjs tests/chat_history_visibility_sync.test.mjs`
    - `node --test tests/chat_history_open_hydrate.test.mjs tests/chat_history_read_mutation.test.mjs tests/chat_history_visibility_sync.test.mjs tests/chat_history_app_delegation.test.mjs`
  - Notes/dependencies: Closed 2026-04-12 by extracting unread-anchor / activation-threshold helpers plus cached-open and unread-hydration-retry helpers (`createUnreadAnchorController(...)`, `createActivationReadThresholdController(...)`, `createUnreadHydrationRetryController(...)`, `createCachedOpenController(...)`) so read-threshold and cached-open policy no longer sit inside the larger hydration/open controllers. Kept the exported `createController(...)` facade stable and validated with `node --check static/chat_history_helpers.js tests/chat_history_open_hydrate.test.mjs tests/chat_history_read_mutation.test.mjs tests/chat_history_visibility_sync.test.mjs tests/chat_history_app_delegation.test.mjs` and `node --test tests/chat_history_open_hydrate.test.mjs tests/chat_history_read_mutation.test.mjs tests/chat_history_visibility_sync.test.mjs tests/chat_history_app_delegation.test.mjs` (`70 passed` for the chat-history-specific subset, green inside the combined scoped batch).

- [x] R66: Continue decomposing `static/stream_controller.js` transcript/session lifecycle ownership
  - Status: done
  - Severity: High
  - Scope/files: `static/stream_controller.js`, `tests/stream_controller_policy_session.test.mjs`, `tests/stream_controller_resume_finalize.test.mjs`, `tests/frontend_runtime_stream_activity.test.mjs`, and related stream/runtime suites.
  - Why it matters: `static/stream_controller.js` has regrown to 1966 LOC. The largest remaining concentrations are `createToolTraceController(...)` (~199 LOC), `createStreamSessionController(...)` (~196 LOC), `createTranscriptConsumeController(...)` (~193 LOC), and `createStreamNonTerminalEventController(...)` (~163 LOC). Tool-trace state, replay/session ownership, and event consumption are still packed into a single high-blast-radius runtime file.
  - Proposed change: Split tool-trace ownership, replay/session state mutation, and transcript-consume/event-routing logic into narrower helper bands or files, leaving the top-level controller factories as orchestration glue.
  - Validation steps:
    - `node --check static/stream_controller.js tests/stream_controller_policy_session.test.mjs tests/stream_controller_resume_finalize.test.mjs tests/frontend_runtime_stream_activity.test.mjs`
    - `node --test tests/stream_controller_policy_session.test.mjs tests/stream_controller_resume_finalize.test.mjs tests/frontend_runtime_stream_activity.test.mjs tests/stream_controller_app_delegation.test.mjs`
  - Notes/dependencies: Closed 2026-04-12 by splitting session and SSE-consume ownership into helper bands (`createVisibleStreamStatusController(...)`, `createReplayCursorController(...)`, `createStreamAbortRegistry(...)`, `createFirstAssistantNotificationController(...)`, `createStreamEventDispatchController(...)`, `createSseStreamReadController(...)`) while preserving reconnect budget semantics, replay cursor behavior, and active latency/tool-trace UX guarantees.

- [x] R67: Continue splitting `static/chat_tabs_helpers.js` orchestration vs presentation/state ownership
  - Status: done
  - Severity: Medium
  - Scope/files: `static/chat_tabs_helpers.js`, `tests/chat_tabs_helpers.test.mjs`, `tests/chat_tabs_app_delegation.test.mjs`, `tests/frontend_runtime_chat_tab_cycle.test.mjs`.
  - Why it matters: `static/chat_tabs_helpers.js` is now 1022 LOC. `createController(...)` alone is ~339 LOC, with `createTabPresentationController(...)` (~200 LOC) and `createChatStateController(...)` (~141 LOC) still mixing state mutation, ordering, and overview rendering policy.
  - Proposed change: Further separate chat collection state, overview/presentation rendering, and top-level wrapper orchestration so the exported controller facade becomes a thin delegator instead of another mini-monolith.
  - Validation steps:
    - `node --check static/chat_tabs_helpers.js tests/chat_tabs_helpers.test.mjs tests/chat_tabs_app_delegation.test.mjs tests/frontend_runtime_chat_tab_cycle.test.mjs`
    - `node --test tests/chat_tabs_helpers.test.mjs tests/chat_tabs_app_delegation.test.mjs tests/frontend_runtime_chat_tab_cycle.test.mjs`
  - Notes/dependencies: Closed 2026-04-12 by extracting tab-node/badge ownership and top-level tab render/selection orchestration into `createTabNodeController(...)` and `createTabsRenderController(...)`, leaving `createController(...)` as thinner wrapper glue while preserving mobile carousel, pinned collapse, and reconnect cooldown behavior. Validated with `node --check static/chat_tabs_helpers.js tests/chat_tabs_helpers.test.mjs tests/chat_tabs_app_delegation.test.mjs tests/frontend_runtime_chat_tab_cycle.test.mjs` and `node --test tests/chat_tabs_helpers.test.mjs tests/chat_tabs_app_delegation.test.mjs tests/frontend_runtime_chat_tab_cycle.test.mjs` (`24 passed` for the chat-tabs-specific subset, green inside the combined scoped batch).

- [x] R68: Continue decomposing warm-session lifecycle ownership in `hermes_client_types.py`
  - Status: done
  - Severity: Medium
  - Scope/files: `hermes_client_types.py`, `tests/test_hermes_client.py`, and any dedicated warm-session helper module introduced by the split.
  - Why it matters: `hermes_client_types.py` has regrown to 940 LOC. The previous split reduced some method size, but the registry scaffold still combines owner-state summarization, reusable-candidate pruning/selection, runtime field preservation, and event/record lifecycle concerns in one type-heavy module.
  - Proposed change: Pull reusable-candidate/report shaping and owner-state summary/normalization helpers into narrower helper bands or modules so future warm-session changes stop accumulating inside a single scaffold file.
  - Validation steps:
    - `source .venv/bin/activate && python -m py_compile hermes_client_types.py tests/test_hermes_client.py`
    - `source .venv/bin/activate && python -m pytest -q tests/test_hermes_client.py -k "warm_reuse or attach or recall_health or child_spawn"`
  - Notes/dependencies: Closed 2026-04-12 by extracting warm-session payload/report helpers into `hermes_client_warm_session_helpers.py` and rewiring `IsolatedWorkerWarmSessionRegistryScaffold` to delegate owner-state summary/payload building, reusable-candidate payload shaping, worker-event detail formatting, and reusable-candidate expiration classification while preserving diagnostics payload shapes and current warm-reuse selection semantics. Validated with `source .venv/bin/activate && python -m py_compile hermes_client_types.py hermes_client_warm_session_helpers.py tests/test_hermes_client.py` and `source .venv/bin/activate && python -m pytest -q tests/test_hermes_client.py -k "warm_reuse or attach or recall_health or child_spawn"` (`37 passed, 70 deselected`).

- [x] R69: Continue decomposing `job_runtime_worker_launcher.py` subprocess lifecycle/policy ownership
  - Status: done
  - Severity: Medium
  - Scope/files: `job_runtime_worker_launcher.py`, `job_runtime_chat_job.py`, `tests/test_job_runtime_worker_launcher.py`, `tests/test_job_runtime_chat_job.py`.
  - Why it matters: `job_runtime_worker_launcher.py` remains 835 LOC even after earlier helper extractions. Spawn/config, subprocess wait/timeout handling, stderr summarization, and launcher policy are still concentrated in one file while current worktree changes continue to touch this seam.
  - Proposed change: Further isolate subprocess lifecycle policy and launcher/reporting contracts into narrower helper objects or modules, and add more direct launcher-owned contract tests where behavior is currently exercised only through broader job runtime tests.
  - Validation steps:
    - `source .venv/bin/activate && python -m py_compile job_runtime_worker_launcher.py job_runtime_chat_job.py tests/test_job_runtime_worker_launcher.py tests/test_job_runtime_chat_job.py`
    - `source .venv/bin/activate && python -m pytest -q tests/test_job_runtime_worker_launcher.py tests/test_job_runtime_chat_job.py -k "configured_worker_launcher or subprocess or timeout or warm"`
  - Notes/dependencies: Closed 2026-04-12 by routing subprocess event iteration, timeout/kill handling, attach-ready/descendant telemetry, nonzero-exit mapping, and finalize/limit-breach reporting through new helper module `job_runtime_worker_launcher_subprocess.py` (`SubprocessStreamLifecycle`, `SubprocessStreamState`) while keeping `SubprocessJobWorkerLauncher` as orchestration glue. Added direct helper-level finalize/limit-breach coverage in `tests/test_job_runtime_worker_launcher.py`. Scoped validation is green for the launcher slice; the only remaining failure in the broader command is the known unrelated `tests/test_job_runtime_worker_launcher.py::test_runtime_run_chat_job_uses_configured_worker_launcher` case where `claim_next_job()` returns `None` before launcher behavior is exercised.

## Log pointers
- Completed-item archive: `docs/maintainers/history/refactor-log.hermes-miniapp-v4.md`
- Legacy refresh snapshot archive: `docs/maintainers/archive/refactor-plans/refactor-plan.hermes-miniapp-v4.refresh-2026-03-27.md`
- Compaction rule for this project: keep the active plan focused on open items plus the latest few completions; move older completed-item detail and refresh evidence into the refactor log.
