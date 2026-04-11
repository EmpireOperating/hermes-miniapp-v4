# Refactor Plan — hermes-miniapp-v4

> Canonical active plan file (live source of truth).
> Detailed execution history now lives in `docs/refactor-log.hermes-miniapp-v4.md`.
> Historical refresh snapshot archived at `docs/archive/refactor-plans/refactor-plan.hermes-miniapp-v4.refresh-2026-03-27.md`.

## Project snapshot
- Project: hermes-miniapp-v4
- Project slug: hermes-miniapp-v4
- Generated: 2026-04-11T03:35:31Z
- Plan maintenance note: Compacted on 2026-04-11 so this file stays focused on active work; older completed-item detail and refresh evidence moved to `docs/refactor-log.hermes-miniapp-v4.md`.
- Branch: main
- Git status summary: dirty (`git status --short --branch` currently shows `## main...origin/main` plus modified `docs/plans/2026-04-10-miniapp-telegram-unread-notifications-spec.md`, `docs/refactor-plan.hermes-miniapp-v4.md`, `job_runtime_chat_job.py`, `miniapp_config.py`, `routes_auth.py`, `routes_auth_service.py`, `server.py`, `static/app.css`, `static/app.js`, `static/chat_history_helpers.js`, `static/interaction_helpers.js`, `static/startup_bindings_helpers.js`, `static/visibility_skin_helpers.js`, `store_chats.py`, `store_schema.py`, `tests/interaction_helpers.test.mjs`, `tests/startup_bindings_helpers.test.mjs`, `tests/test_routes_auth.py`, `tests/test_routes_jobs_runtime.py`, and untracked `miniapp_presence.py`, `miniapp_telegram_notifications.py`, `tests/test_config_telegram_notifications.py`, `tests/test_miniapp_telegram_notifications.py`, `tests/test_store_telegram_notifications.py`; R47 and R48 are now complete in the worktree, and the remaining backlog is concentrated in store/schema/config plus the app.js quote/viewport seam.)
- Analysis mode: executed the first reopened batch directly instead of refreshing only. Validation on the startup split and unread-notification seam now passes: `node --check static/startup_bindings_helpers.js tests/startup_bindings_helpers.test.mjs tests/startup_bindings_app_delegation.test.mjs static/app.js` → passed; `node --test tests/startup_bindings_helpers.test.mjs tests/startup_bindings_app_delegation.test.mjs` → 24 passed; `source .venv/bin/activate && python -m pytest -q tests/test_routes_meta.py -k "startup_bindings or bootstrap"` → 5 passed, 63 deselected; `source .venv/bin/activate && python -m py_compile miniapp_telegram_notifications.py miniapp_config.py store_chats.py store_schema.py tests/test_miniapp_telegram_notifications.py tests/test_config_telegram_notifications.py tests/test_store_telegram_notifications.py` → passed; `source .venv/bin/activate && python -m pytest -q tests/test_miniapp_telegram_notifications.py tests/test_config_telegram_notifications.py tests/test_store_telegram_notifications.py` → 10 passed; `source .venv/bin/activate && python -m pytest -q tests/test_routes_auth.py -k "telegram_unread"` → 3 passed, 19 deselected.

## Progress metrics
- Total items: 51
- Done: 48
- In progress: 0
- Blocked: 0
- Todo: 3
- % complete: 94%
- Last completed item: R48 (Finish direct coverage for the Telegram unread-notification config/store/schema seam)
- Last updated: 2026-04-11T03:35:31Z

## Next up
- R49: Decompose `store_schema.py` startup schema/migration bootstrap into focused helpers
- R51: Split `MiniAppConfig.from_env(...)` into focused config parsing helpers
- R50: Continue `static/app.js` decomposition around selection-quote and virtualized-history viewport rendering

Note: “Next up” is only a prioritized subset, not the full backlog.

## Recently completed
- R48 (2026-04-11): Closed the remaining unread-notification cross-layer coverage gap without changing product behavior. Added focused tests in `tests/test_config_telegram_notifications.py` for `MINI_APP_TELEGRAM_NOTIFICATION_TIMEOUT_SECONDS`, added focused store/schema regressions in `tests/test_store_telegram_notifications.py` for `get/set_telegram_unread_notifications_enabled(...)` persistence plus legacy `user_preferences` migration coverage, and refreshed the direct notifier tests in `tests/test_miniapp_telegram_notifications.py` so they match the current active+visibly-open suppression contract. Validation: `source .venv/bin/activate && python -m py_compile miniapp_telegram_notifications.py miniapp_config.py store_chats.py store_schema.py tests/test_miniapp_telegram_notifications.py tests/test_config_telegram_notifications.py tests/test_store_telegram_notifications.py` (passed); `source .venv/bin/activate && python -m pytest -q tests/test_miniapp_telegram_notifications.py tests/test_config_telegram_notifications.py tests/test_store_telegram_notifications.py` (`10 passed`); and `source .venv/bin/activate && python -m pytest -q tests/test_routes_auth.py -k "telegram_unread"` (`3 passed, 19 deselected`).
- R47 (2026-04-11): Split `static/startup_bindings_helpers.js` into focused internal controllers while preserving the exported `createController(...)` facade and existing `static/app.js` delegation surface. The helper now composes `createTranscriptBindingsController(...)` for transcript scroll/jump/tab bindings, `createActionBindingsController(...)` for async button wiring, `createStartupBootstrapController(...)` for binding checks + auth/bootstrap orchestration, `createShellModalController(...)` for shell/settings/dev-auth modal listeners, and `createPendingWatchdogController(...)` for the best-effort pending refresh loop. Added direct export coverage in `tests/startup_bindings_helpers.test.mjs` and kept the existing behavior/delegation suites green. Validation: `node --check static/startup_bindings_helpers.js tests/startup_bindings_helpers.test.mjs tests/startup_bindings_app_delegation.test.mjs static/app.js` (passed); `node --test tests/startup_bindings_helpers.test.mjs tests/startup_bindings_app_delegation.test.mjs` (`24 passed`); and `source .venv/bin/activate && python -m pytest -q tests/test_routes_meta.py -k "startup_bindings or bootstrap"` (`5 passed, 63 deselected`).
- R45 (2026-04-10): Split `job_runtime_worker_launcher.py` subprocess launch/stream handling into focused helper bands while preserving `SubprocessJobWorkerLauncher` public behavior and diagnostics fields. The launcher now routes subprocess ownership through narrower helpers for spawn/config (`_child_env`, `_assert_spawn_allowed`, `_spawn_subprocess`, `_register_spawn`, `_write_payload`), event transport/decode (`_stdout_line_queue`, `_decode_subprocess_event`, `_iter_subprocess_events`, `_record_stream_event`), attach/terminal event handling (`_handle_child_spawn_event`, `_handle_attach_ready_event`, `_handle_worker_terminal_event`), and teardown/error mapping (`_emit_timeout_error`, `_wait_for_subprocess_exit`, `_emit_nonzero_exit_error`, `_finalize_subprocess_stream`), shrinking `_stream_events_via_subprocess(...)` to a 78-line orchestration method. Validation: `source .venv/bin/activate && python -m py_compile job_runtime_worker_launcher.py tests/test_job_runtime_worker_launcher.py tests/test_routes_jobs_runtime.py` (passed); `source .venv/bin/activate && python -m pytest -q tests/test_job_runtime_worker_launcher.py` (`1 failed, 24 passed`) with the remaining failure isolated to the pre-existing dirty-tree/open-job-claim test `test_runtime_run_chat_job_uses_configured_worker_launcher`; and `source .venv/bin/activate && python -m pytest -q tests/test_job_runtime_worker_launcher.py -k "not test_runtime_run_chat_job_uses_configured_worker_launcher"` (`23 passed, 1 deselected`).
- R43 (2026-04-10): Decomposed the old `tests/chat_history_helpers.test.mjs` monolith into focused suites aligned with the chat-history seams. Added `tests/chat_history_test_harness.mjs` for shared fixtures, split meta/deferred-tab-switch coverage into `tests/chat_history_meta_controller.test.mjs`, split history open/hydrate/resume coverage into `tests/chat_history_open_hydrate.test.mjs`, split unread/read-threshold plus local mutation coverage into `tests/chat_history_read_mutation.test.mjs`, and split visibility-driven active-sync coverage into `tests/chat_history_visibility_sync.test.mjs`. Kept the existing `tests/chat_history_app_delegation.test.mjs` wrapper contract coverage intact. Validation: `node --check static/chat_history_helpers.js tests/chat_history_test_harness.mjs tests/chat_history_meta_controller.test.mjs tests/chat_history_open_hydrate.test.mjs tests/chat_history_read_mutation.test.mjs tests/chat_history_visibility_sync.test.mjs tests/chat_history_app_delegation.test.mjs` (passed) and `node --test tests/chat_history_meta_controller.test.mjs tests/chat_history_open_hydrate.test.mjs tests/chat_history_read_mutation.test.mjs tests/chat_history_visibility_sync.test.mjs tests/chat_history_app_delegation.test.mjs` (`65 passed`).
- R42 (2026-04-10): Split `static/chat_history_helpers.js` into focused internal controllers while preserving the exported `createController(...)` and `createMetaController(...)` facade that `static/app.js` consumes. The module now composes `createReadSyncController(...)` for unread/read-threshold + mark-read behavior, `createLocalMutationController(...)` for local system-message/pending-assistant/message-view mutations, and `createHistoryOpenController(...)` for load/open/hydrate/refresh/visibility flows, while keeping `createMetaController(...)` focused on active-chat metadata/deferred tab-switch work. Validation: `node --check static/chat_history_helpers.js tests/chat_history_test_harness.mjs tests/chat_history_meta_controller.test.mjs tests/chat_history_open_hydrate.test.mjs tests/chat_history_read_mutation.test.mjs tests/chat_history_visibility_sync.test.mjs tests/chat_history_app_delegation.test.mjs` (passed), `node --test tests/chat_history_meta_controller.test.mjs tests/chat_history_open_hydrate.test.mjs tests/chat_history_read_mutation.test.mjs tests/chat_history_visibility_sync.test.mjs tests/chat_history_app_delegation.test.mjs` (`65 passed`), and `source .venv/bin/activate && python -m pytest -q tests/test_routes_meta.py::test_chat_history_helpers_static_asset_is_no_store tests/test_routes_meta.py::test_desktop_dev_auth_bootstrap_guards_present` (`2 passed`).

## Backlog summary
- High: 0
- Medium: 3
- Low: 0

## Active backlog

- [ ] R49: Decompose `store_schema.py` startup schema/migration bootstrap into focused helpers
 - Status: todo
 - Severity: Medium
 - Scope/files: `store_schema.py` (+ helper module(s) if needed), relevant store/schema tests
 - Why it matters: `store_schema.py` is 447 LOC and `_init_db(...)` alone is about 243 LOC, mixing base table creation, startup running-job recovery, column backfills, invariant migration, runtime checkpoint/auth session setup, and legacy-history migration. The unread-notification preference column expanded this already fragile startup path, increasing blast radius for future schema changes.
 - Proposed change: Extract focused schema/bootstrap helper bands for base table/index creation, startup recovery, per-table column backfills, and late migrations while preserving the existing `StoreSchemaMixin` entrypoints and migration ordering.
 - Validation steps:
   - `source .venv/bin/activate && python -m py_compile store_schema.py tests/test_store.py`
   - `source .venv/bin/activate && python -m pytest -q tests/test_store.py -k "schema or startup or migration or preferences"`
 - Notes/dependencies: Preserve idempotent migrations for existing databases; avoid coupling this pass to unrelated chat/store behavioral changes.

- [ ] R50: Continue `static/app.js` decomposition around selection-quote and virtualized-history viewport rendering
 - Status: todo
 - Severity: Medium
 - Scope/files: `static/app.js`, adjacent helper modules such as `static/interaction_helpers.js` / `static/chat_history_helpers.js` / `static/composer_viewport_helpers.js`, and matching JS tests
 - Why it matters: `static/app.js` remains the largest frontend hotspot at 2551 LOC. The current largest unsplit ownership cluster is still concentrated around selection-quote scheduling/placement and virtualized history viewport rendering (`showSelectionQuoteAction`, `syncSelectionQuoteAction`, `renderVirtualizedHistory`, `tryAppendOnlyRender`, `restoreMessageViewport`) in the same 1304–1469 line region. This continues to make quote UX + transcript rendering changes expensive to reason about.
 - Proposed change: Extract the remaining quote-popup placement/scheduling logic and viewport restore/render path into focused helper/controller seams while preserving current DOM behavior and existing app-facing globals.
 - Validation steps:
   - `node --check static/app.js <new or updated helper files> tests/interaction_helpers.test.mjs tests/chat_history_* tests/composer_viewport_helpers.test.mjs`
   - `node --test tests/interaction_helpers.test.mjs tests/chat_history_meta_controller.test.mjs tests/chat_history_open_hydrate.test.mjs tests/chat_history_read_mutation.test.mjs tests/chat_history_visibility_sync.test.mjs tests/composer_viewport_helpers.test.mjs`
 - Notes/dependencies: Coordinate with `static/startup_bindings_helpers.js` ownership so startup flow and interaction/render flow do not cross back into each other.

- [ ] R51: Split `MiniAppConfig.from_env(...)` into focused config parsing helpers
 - Status: todo
 - Severity: Medium
 - Scope/files: `miniapp_config.py`, `tests/test_config.py`, and any startup/server wiring touched by config-loading helpers
 - Why it matters: `miniapp_config.py` is now 365 LOC and `MiniAppConfig.from_env(...)` alone is about 198 LOC, mixing operator-debug gates, worker-launcher tuning, warm-worker limits, auth/session policy, Telegram notification timeout parsing, origin/rate-limit settings, and dev-auth expiry handling in one constructor-sized method. The unread-notification/env growth pushed the config loader back into monolith territory, and the coverage scan found no direct test referencing `MINI_APP_TELEGRAM_NOTIFICATION_TIMEOUT_SECONDS`.
 - Proposed change: Extract focused parser/helper bands for runtime/worker settings, auth/Telegram settings, and web/security settings while preserving `MiniAppConfig.from_env()` as the public entrypoint and keeping current env-variable semantics unchanged.
 - Validation steps:
   - `source .venv/bin/activate && python -m py_compile miniapp_config.py tests/test_config.py`
   - `source .venv/bin/activate && python -m pytest -q tests/test_config.py -k "telegram_notification or dev_auth or persistent_runtime_ownership or mobile_tab_carousel"`
 - Notes/dependencies: Coordinate with R48 so the new timeout env var gains direct tests as part of or immediately before this split.

## Log pointers
- Completed-item archive: `docs/refactor-log.hermes-miniapp-v4.md`
- Legacy refresh snapshot archive: `docs/archive/refactor-plans/refactor-plan.hermes-miniapp-v4.refresh-2026-03-27.md`
- Compaction rule for this project: keep the active plan focused on open items plus the latest few completions; move older completed-item detail and refresh evidence into the refactor log.
