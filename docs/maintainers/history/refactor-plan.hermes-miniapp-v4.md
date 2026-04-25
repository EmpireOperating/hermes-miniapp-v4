# Refactor Plan — hermes-miniapp-v4

> Canonical active plan file (live source of truth).
> Detailed execution history and refresh evidence live in `docs/maintainers/history/refactor-log.hermes-miniapp-v4.md`.
> Historical refresh snapshot archived at `docs/maintainers/archive/refactor-plans/refactor-plan.hermes-miniapp-v4.refresh-2026-03-27.md`.

## Project snapshot
- Project: hermes-miniapp-v4
- Project slug: hermes-miniapp-v4
- Generated: 2026-04-12T02:37:44Z
- Plan maintenance note: Compacted on 2026-04-11 so this file stays focused on active work; older completed-item detail and refresh evidence live in `docs/maintainers/history/refactor-log.hermes-miniapp-v4.md`.
- Branch: feat/visual-dev-mode-phase2
- Git status summary: dirty (`git status --short --branch` currently shows `## feat/visual-dev-mode-phase2...origin/feat/visual-dev-mode-phase2` plus the in-flight visual-dev/workspace/auth/runtime refactor set, including `static/app.js`, `static/visual_dev_*`, `routes_chat_*`, `server.py`, and related tests/untracked visual-dev artifacts).
- Analysis mode: refreshed monolith-focused refactor pass against current repo reality, then executed the next behavior-preserving `static/app.js` composition split for the regrown visual-dev app-shell seam.
- Validation snapshot:
  - `git status --short --branch && git rev-parse --show-toplevel` → dirty `feat/visual-dev-mode-phase2` worktree at `/home/hermes-agent/workspace/active/hermes_miniapp_v4` with broad in-flight visual-dev/workspace/auth/runtime edits already present.
  - Python/JS line-count scan across repo hotspots → current frontend hotspots led by `static/app.js` (3859), `static/stream_controller.js` (2598), `static/chat_tabs_helpers.js` (1140), `static/chat_admin_helpers.js` (985), `static/bootstrap_auth_helpers.js` (966), and `static/visual_dev_shell_helpers.js` (855); backend/runtime/test hotspots remain led by `tests/test_hermes_client.py` (3622), `tests/test_routes_chat.py` (2368), `tests/test_routes_meta.py` (1470), and `tests/test_job_runtime_worker_launcher.py` (1368).
  - Function/name scan across `static/app.js` shows the regrown app-shell ownership concentrated in visual-dev composition/dependency bands, especially `createVisualDevControllerDeps(...)`, `createVisualDevAttachControllerDeps(...)`, and `createVisualDevPromptContextControllerDeps(...)`.
  - `node --check static/app.js && node --check tests/visual_dev_app_delegation.test.mjs && node --check tests/visual_dev_mode_helpers.test.mjs` → success.
  - `node --test tests/visual_dev_app_delegation.test.mjs tests/visual_dev_mode_helpers.test.mjs tests/visual_dev_attach_helpers.test.mjs tests/visual_dev_prompt_context_helpers.test.mjs tests/visual_dev_shell_helpers.test.mjs` → `36 passed`.

## Progress metrics
- Total items: 73
- Done: 73
- In progress: 0
- Blocked: 0
- Todo: 0
- % complete: 100%
- Last completed item: R73 (Continue shrinking `static/app.js` by splitting regrown visual-dev composition/dependency bands)
- Last updated: 2026-04-23T21:20:09Z

## Next up
- None currently. Backlog closed.

Note: “Next up” is only a prioritized subset, not the full backlog.

## Recently completed
- R73 (2026-04-23): Reopened the frontend monolith backlog after `static/app.js` regrew around visual-dev wiring, then split the regrown visual-dev dependency builders into narrower composition helpers inside `app.js`: `createVisualDevFeatureConfig(...)`, `createVisualDevControllerUiDeps(...)`, `createVisualDevControllerRuntimeDeps(...)`, `createVisualDevAttachControllerPolicyDeps(...)`, `createVisualDevAttachControllerUiDeps(...)`, `createVisualDevAttachControllerRuntimeDeps(...)`, `createVisualDevPromptContextControllerUiDeps(...)`, and `createVisualDevPromptContextControllerRuntimeDeps(...)`. Kept `createVisualDevControllerDeps(...)`, `createVisualDevAttachControllerDeps(...)`, and `createVisualDevPromptContextControllerDeps(...)` as thin composition wrappers and tightened `tests/visual_dev_app_delegation.test.mjs` so the ownership boundary stays explicit. Validated with `node --check static/app.js tests/visual_dev_app_delegation.test.mjs tests/visual_dev_mode_helpers.test.mjs` and `node --test tests/visual_dev_app_delegation.test.mjs tests/visual_dev_mode_helpers.test.mjs tests/visual_dev_attach_helpers.test.mjs tests/visual_dev_prompt_context_helpers.test.mjs tests/visual_dev_shell_helpers.test.mjs` (`36 passed`).
- R72 (2026-04-12): Continued decomposing `static/chat_history_helpers.js` by extracting unread-preservation shaping (`createUnreadPreservationController(...)`), shared hydrate/apply/retry orchestration (`createHydrationApplyController(...)`), and visibility-resume policy (`createVisibilityResumeController(...)`). Rewired `createReadSyncController(...)` and `createHistoryHydrationController(...)` so read-threshold preservation, unread-retry application, and visibility-driven resume decisions no longer live inline in the larger hydration/open wrappers. Kept the exported facade stable and validated with `node --check static/chat_history_helpers.js tests/chat_history_test_harness.mjs tests/chat_history_open_hydrate.test.mjs tests/chat_history_read_mutation.test.mjs tests/chat_history_visibility_sync.test.mjs tests/chat_history_app_delegation.test.mjs` and `node --test tests/chat_history_open_hydrate.test.mjs tests/chat_history_read_mutation.test.mjs tests/chat_history_visibility_sync.test.mjs tests/chat_history_app_delegation.test.mjs` (`73 passed`).
- R71 (2026-04-12): Continued decomposing `static/stream_controller.js` by extracting event-specific helper bands (`createStreamMetaEventController(...)`, `createToolTraceEventController(...)`, `createAssistantChunkEventController(...)`, `createStreamErrorEventController(...)`) plus direct consume/read-loop helpers (`createTranscriptBufferController(...)`, `createTranscriptReadLoopController(...)`). This leaves `createStreamNonTerminalEventController(...)` and `createTranscriptConsumeController(...)` as orchestration glue over smaller session/consume ownership seams. Validated with `node --check static/stream_controller.js tests/stream_controller_policy_session.test.mjs tests/stream_controller_response.test.mjs tests/stream_controller_resume_finalize.test.mjs tests/frontend_runtime_stream_activity.test.mjs tests/stream_controller_app_delegation.test.mjs` and `node --test tests/stream_controller_policy_session.test.mjs tests/stream_controller_response.test.mjs tests/stream_controller_resume_finalize.test.mjs tests/frontend_runtime_stream_activity.test.mjs tests/stream_controller_app_delegation.test.mjs` (`54 passed` for the stream-focused subset, green in the combined app-shell validation batch).
- R70 (2026-04-12): Continued shrinking `static/app.js` by splitting large dependency-builders into narrower composition helpers: `createChatTabsControllerStateDeps(...)`, `createChatTabsControllerUiDeps(...)`, `createChatTabsControllerPolicyDeps(...)`, `createBootstrapAuthControllerSessionDeps(...)`, `createBootstrapAuthControllerAppDeps(...)`, `createBootstrapAuthControllerBootstrapDeps(...)`, `createStartupBindingsControllerElementDeps(...)`, `createStartupBindingsControllerInteractionDeps(...)`, and `createStartupBindingsControllerBootstrapDeps(...)`. Kept the existing app-shell wrappers stable and validated with `node --check static/app.js tests/bootstrap_auth_app_delegation.test.mjs tests/chat_tabs_app_delegation.test.mjs tests/interaction_app_delegation.test.mjs tests/render_trace_history_app_delegation.test.mjs tests/template_startup_script_order.test.mjs tests/startup_bindings_app_delegation.test.mjs` and `node --test tests/bootstrap_auth_app_delegation.test.mjs tests/chat_tabs_app_delegation.test.mjs tests/interaction_app_delegation.test.mjs tests/render_trace_history_app_delegation.test.mjs tests/template_startup_script_order.test.mjs tests/startup_bindings_app_delegation.test.mjs` (`17 passed` for the app-shell subset, green in the combined batch).
- R69 (2026-04-12): Continued decomposing `job_runtime_worker_launcher.py` by routing subprocess stream lifecycle ownership through new helper module `job_runtime_worker_launcher_subprocess.py`, moving event iteration, timeout/kill handling, attach-ready/descendant telemetry, nonzero-exit mapping, and finalize/limit-breach reporting behind `SubprocessStreamLifecycle` while leaving `SubprocessJobWorkerLauncher` as orchestration glue. Added direct helper-level coverage in `tests/test_job_runtime_worker_launcher.py` for finalize/limit-breach reporting. Validated with `source .venv/bin/activate && python -m py_compile job_runtime_worker_launcher.py job_runtime_worker_launcher_subprocess.py job_runtime_chat_job.py tests/test_job_runtime_worker_launcher.py tests/test_job_runtime_chat_job.py` and `source .venv/bin/activate && python -m pytest -q tests/test_job_runtime_worker_launcher.py -k "subprocess_worker_stream_parses_events_tracks_spawn_and_stderr or subprocess_worker_stream_synthesizes_done_for_detached_warm_handoff or subprocess_worker_stream_detaches_immediately_after_done_when_attach_ready_seen or subprocess_worker_stream_yields_error_when_input_pipe_breaks or subprocess_worker_timeout_forces_termination or subprocess_worker_times_out_distinctly_before_first_event or subprocess_worker_timeout_tracks_inactivity_not_total_elapsed_time or subprocess_worker_classifies_limit_breach_from_stderr or subprocess_worker_stream_reads_worker_terminal_outcome or subprocess_worker_stream_suppresses_late_nonzero_exit_after_done or subprocess_worker_stream_surfaces_stderr_on_nonzero_exit or subprocess_worker_stream_records_descendant_telemetry or stream_lifecycle_finalize_reports_limit_breach_and_terminal_error"` (`13 passed, 13 deselected`).
- R68 (2026-04-12): Continued decomposing `hermes_client_types.py` by extracting warm-session reuse/report shaping into new helper module `hermes_client_warm_session_helpers.py`, delegating owner-state summary/payload construction, reusable-candidate payload shaping, worker-event detail formatting, and reusable-candidate expiration classification out of `IsolatedWorkerWarmSessionRegistryScaffold` while preserving diagnostics payload shapes and warm-reuse selection semantics. Validated with `source .venv/bin/activate && python -m py_compile hermes_client_types.py hermes_client_warm_session_helpers.py tests/test_hermes_client.py` and `source .venv/bin/activate && python -m pytest -q tests/test_hermes_client.py -k "warm_reuse or attach or recall_health or child_spawn"` (`37 passed, 70 deselected`).

## Backlog summary
- High: 0
- Medium: 0
- Low: 0

## Active backlog

- None. Current pass closed.

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

- [x] R73: Continue shrinking `static/app.js` by splitting regrown visual-dev composition/dependency bands
  - Status: done
  - Severity: High
  - Scope/files: `static/app.js`, `tests/visual_dev_app_delegation.test.mjs`, and the existing visual-dev helper/test surface (`static/visual_dev_*`, `tests/visual_dev_*`) used for scoped validation.
  - Why it matters: `static/app.js` has regrown to 3859 LOC on the active feature branch, and the biggest newly concentrated app-shell seams are no longer product behavior internals; they are visual-dev composition/dependency builders like `createVisualDevControllerDeps(...)`, `createVisualDevAttachControllerDeps(...)`, and `createVisualDevPromptContextControllerDeps(...)`. Leaving those as large inline object builders turns `app.js` back into a monolithic dependency registry instead of a thin composition root.
  - Proposed change: Split the regrown visual-dev dependency builders into narrower composition helpers inside `app.js` first (feature config, UI deps, runtime/policy deps) so the top-level controller factories stay behavior-preserving wrappers while ownership boundaries remain explicit in delegation tests.
  - Validation steps:
    - `node --check static/app.js tests/visual_dev_app_delegation.test.mjs tests/visual_dev_mode_helpers.test.mjs`
    - `node --test tests/visual_dev_app_delegation.test.mjs tests/visual_dev_mode_helpers.test.mjs tests/visual_dev_attach_helpers.test.mjs tests/visual_dev_prompt_context_helpers.test.mjs tests/visual_dev_shell_helpers.test.mjs`
  - Notes/dependencies: Closed 2026-04-23 by extracting `createVisualDevFeatureConfig(...)`, `createVisualDevControllerUiDeps(...)`, `createVisualDevControllerRuntimeDeps(...)`, `createVisualDevAttachControllerPolicyDeps(...)`, `createVisualDevAttachControllerUiDeps(...)`, `createVisualDevAttachControllerRuntimeDeps(...)`, `createVisualDevPromptContextControllerUiDeps(...)`, and `createVisualDevPromptContextControllerRuntimeDeps(...)`, leaving the prior deps builders as thin composition wrappers. Tightened `tests/visual_dev_app_delegation.test.mjs` to assert the new helper boundaries and kept the runtime/helper contract green (`36 passed`).

## Log pointers
- Completed-item archive: `docs/maintainers/history/refactor-log.hermes-miniapp-v4.md`
- Legacy refresh snapshot archive: `docs/maintainers/archive/refactor-plans/refactor-plan.hermes-miniapp-v4.refresh-2026-03-27.md`
- Compaction rule for this project: keep the active plan focused on open items plus the latest few completions; move older completed-item detail and refresh evidence into the refactor log.
