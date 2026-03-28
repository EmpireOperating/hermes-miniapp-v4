# Refactor Plan — hermes-miniapp-v4 (refresh 2026-03-27)

## Project snapshot
- Project: hermes-miniapp-v4
- Project slug: hermes-miniapp-v4
- Generated: 2026-03-27T18:12:07-06:00
- Branch: main
- Git status summary: dirty (tracked modifications in app/runtime/store/routes/tests and untracked split transport/runtime/bootstrap modules + docs/runtime limits additions)
- Analysis mode: planning refresh after execution + new full-project hardening assessment pass (no code behavior changes in this step)

## Progress metrics
- Total items: 18
- Done: 15
- In progress: 0
- Blocked: 0
- Todo: 3
- % complete: 83%
- Last completed item: R14
- Last updated: 2026-03-28T02:14:52Z

## Next up
- R15: Decompose `store_chats.py` into read/query vs mutation/cancellation helpers.
- R16: Finish `server.py` composition split by extracting request/auth adapter wiring.
- R18: Introduce shared job-status/domain constants to reduce cross-module string drift.

Note: “Next up” is only a prioritized subset, not the full backlog.

## Recently completed
- R14 (2026-03-28): Decomposed `store_jobs.py` lifecycle internals into focused helper modules (`store_jobs_claim.py`, `store_jobs_retry.py`, `store_jobs_queries.py`) while preserving `SessionStore` public method contracts and SQL behavior.
- R17 (2026-03-28): Added direct contract/regression suites for extracted modules (`tests/test_hermes_client_bootstrap.py`, `tests/test_job_runtime_events.py`, `tests/test_job_runtime_chat_job.py`, `tests/test_server_startup.py`, `tests/test_server_public_routes.py`) to prevent silent drift.
- R13 (2026-03-28): Split runtime event-bus responsibilities into a dedicated `JobEventBroker` (`job_runtime_events.py`) and wired `JobRuntime` through compatibility-preserving delegation/proxy attributes for monkeypatch/test contract stability.
- R12 (2026-03-28): Extracted Hermes client bootstrap/config parsing logic into `hermes_client_bootstrap.py` and routed `HermesClient` config-loading/routing methods through the dedicated bootstrap layer.
- R11 (2026-03-28): Extracted server startup diagnostics and public-route registration into `server_startup.py` and `server_public_routes.py`, reducing `server.py` composition blast radius while preserving entrypoints.
- R10 (2026-03-27): Expanded module-level transport/shim regressions with explicit tests for persistent worker exception wrapping, shim logger proxy behavior under close-failure cleanup, and shim subprocess module replacement contract.
- R9 (2026-03-27): Removed duplicated direct-agent tool-display formatting drift by making the parent process own `display` rendering from `tool_name`/`preview`/`args`; child runner now emits normalized tool payload only.
- R8 (2026-03-27): Added persistent-agent watchdog timeout around `event_queue.get(...)` in `_stream_via_persistent_agent` with deterministic `HermesClientError` timeout messaging including session context.
- R7 (2026-03-27): Split `hermes_client_agent.py` into focused modules (`hermes_client_agent_direct.py`, `hermes_client_agent_persistent.py`) and kept a compatibility composition shim for monkeypatch surfaces (`logger`, `subprocess`) and existing imports.

## Backlog summary
- High: 0
- Medium: 3
- Low: 0

## Backlog

- [x] R1: Harden direct-agent subprocess FD lifecycle
 - Status: done
 - Severity: High
 - Scope/files: `hermes_client_agent.py`, `tests/test_hermes_client.py`
 - Why it matters: `_stream_via_agent` uses `Popen(..., stdin/stdout/stderr=PIPE)` and kills/waits process in `finally`, but does not explicitly close `process.stdout`/`process.stderr` handles after reader completion. Under repeated retries/failures this can contribute to transient FD pressure and amplify `[Errno 24] Too many open files` incidents.
 - Proposed change: Add deterministic handle cleanup (`stdin`/`stdout`/`stderr`) with idempotent close helpers after stream loop exits and on timeout/error paths; ensure reader-thread completion ordering does not retain open pipes.
 - Validation steps:
   - `.venv/bin/python -m pytest -q tests/test_hermes_client.py`
   - Add/execute targeted regression that asserts pipe close methods are called in success + timeout paths.
 - Notes/dependencies: Should land before additional retry/worker hardening so FD behavior is stable.
 - Execution result: Completed 2026-03-27. Added `_safe_close_stream(...)` idempotent cleanup helper in `_stream_via_agent`, explicit teardown closes for stdin/stdout/stderr, and regression assertions for handle close behavior in success + timeout + non-zero exit tests.

- [x] R2: Repair broad-exception policy regression in `job_runtime.py`
 - Status: done
 - Severity: High
 - Scope/files: `job_runtime.py`, `tests/test_broad_exception_policy.py`
 - Why it matters: Current quality gate fails because newly introduced broad handlers in `_fd_metrics` are missing the required `broad-except-policy:` annotation.
 - Proposed change: Add policy-tagged justification comments (and logging/intentional-no-log declarations) for the two `except Exception` blocks.
 - Validation steps:
   - `.venv/bin/python -m pytest -q tests/test_broad_exception_policy.py`
   - `.venv/bin/python -m pytest -q tests/test_routes_jobs_runtime.py`
 - Notes/dependencies: Unblocks CI/static gate confidence for future refactors.
 - Execution result: Completed 2026-03-27. Added required `broad-except-policy:` annotations (with intentional-no-log rationale) on `_fd_metrics` broad handlers while preserving best-effort fallback behavior.

- [x] R3: Extend broad-exception policy coverage to `hermes_client_agent.py`
 - Status: done
 - Severity: Medium
 - Scope/files: `tests/test_broad_exception_policy.py`, `hermes_client_agent.py`
 - Why it matters: `hermes_client_agent.py` contains multiple broad handlers (`except Exception`) that are currently outside the static policy gate. This creates a blind spot where new broad catches can regress observability standards.
 - Proposed change: Include `hermes_client_agent.py` in `TARGET_FILES`, annotate existing broad handlers with policy rationale, and ensure each handler logs or explicitly declares intentional-no-log.
 - Validation steps:
   - `.venv/bin/python -m pytest -q tests/test_broad_exception_policy.py`
   - `.venv/bin/python -m pytest -q tests/test_hermes_client.py`
 - Notes/dependencies: Coordinate with R1 so cleanup-path handlers get final policy text once behavior is settled.
 - Execution result: Completed 2026-03-27. `TARGET_FILES` in policy test now includes `hermes_client_agent.py`; broad handlers are now policy-annotated and satisfy logging/intentional-no-log policy checks.

- [x] R4: Add runtime-level retry-exhaustion regression coverage (not only store-level)
 - Status: done
 - Severity: Medium
 - Scope/files: `tests/test_routes_jobs_runtime.py`, `job_runtime.py`
 - Why it matters: Store-level tests now guard bounded attempts and dead-letter transitions, but runtime worker behavior still lacks a direct regression for user-facing exhaustion messaging and retry/dead telemetry under repeated `JobRetryableError` paths.
 - Proposed change: Add runtime test harness that forces retryable failures across attempts and asserts: (a) bounded attempt text, (b) terminal dead-letter behavior, (c) retrying stops at max.
 - Validation steps:
   - `.venv/bin/python -m pytest -q tests/test_routes_jobs_runtime.py`
 - Notes/dependencies: Complements R1/R2 by proving end-to-end worker semantics.
 - Execution result: Completed 2026-03-27. Added `test_worker_retry_exhaustion_stops_at_max_and_surfaces_terminal_error` to assert retry exhaustion path semantics (no retries past max, dead-letter transition, bounded terminal messaging/events).

- [x] R5: Enforce `chat_jobs` invariants at schema level
 - Status: done
 - Severity: Medium
 - Scope/files: `store_schema.py`, migration path, `tests/test_store.py`
 - Why it matters: Retry logic now enforces limits in code, but DB still allows invalid states (`attempts < 0`, `max_attempts <= 0`, arbitrary status strings). Schema-level checks reduce corruption risk from manual edits/tooling mistakes and make recovery behavior predictable.
 - Proposed change: Introduce migration-safe check constraints (or equivalent guard/migration table rewrite for SQLite) for status domain and numeric bounds; backfill/coerce invalid rows during migration.
 - Validation steps:
   - `.venv/bin/python -m pytest -q tests/test_store.py`
   - Migration regression on pre-existing DB fixture with invalid values.
 - Notes/dependencies: Design carefully for SQLite ALTER TABLE limitations.
 - Execution result: Completed 2026-03-27. Added `chat_jobs` CHECK invariants, legacy-row normalization, and migration-safe table rebuild path in `store_schema.py`; added `test_store_init_migrates_chat_jobs_invariants_and_normalizes_invalid_rows`.

- [x] R6: Expose FD pressure + retry/dead counters in runtime diagnostics endpoint
 - Status: done
 - Severity: Medium
 - Scope/files: `server.py`, `job_runtime.py`, `routes_jobs_runtime.py`, `tests/test_routes_jobs_runtime.py`
 - Why it matters: FD metrics are currently only in logs; operators lack fast API-visible health signals during incidents.
 - Proposed change: Add lightweight runtime diagnostics fields (e.g., `fd_open`, `fd_limit_soft`, recent dead-letter/retry counters) to `/api/runtime/status` while keeping sensitive data redacted.
 - Validation steps:
   - `.venv/bin/python -m pytest -q tests/test_routes_jobs_runtime.py tests/test_config.py`
 - Notes/dependencies: Should remain best-effort and non-fatal if `/proc`/`resource` are unavailable.
 - Execution result: Completed 2026-03-27. `register_jobs_runtime_routes` now uses a dynamic `runtime_getter`; `/api/runtime/status` includes `runtime` diagnostics payload, and regression coverage verifies exposed counters/FD fields.

- [x] R7: Split `hermes_client_agent.py` into focused modules
 - Status: done
 - Severity: Low
 - Scope/files: `hermes_client_agent.py` (+ new helper modules), `tests/test_hermes_client.py`
 - Why it matters: Single 500+ line module combines persistent runtime, direct subprocess streaming, formatting, and env wiring. This increases cognitive load and raises regression risk for future hardening.
 - Proposed change: Extract direct-agent subprocess orchestration and persistent-session runtime into separate internal modules with narrower responsibilities.
 - Validation steps:
   - `.venv/bin/python -m pytest -q tests/test_hermes_client.py`
   - `.venv/bin/python -m pytest -q` (full suite when host FD pressure is stable)
 - Notes/dependencies: Behavior-preserving refactor; prioritize after high/medium reliability items.
 - Execution result: Completed 2026-03-27. Extracted direct subprocess path into `hermes_client_agent_direct.py` and persistent runtime path into `hermes_client_agent_persistent.py`; kept `hermes_client_agent.py` as a backward-compatible composition shim and preserved monkeypatch compatibility for `logger`/`subprocess` surfaces.

- [x] R8: Add persistent-agent watchdog timeout and queue-drain hardening
 - Status: done
 - Severity: High
 - Scope/files: `hermes_client_agent_persistent.py`, `tests/test_hermes_client.py`
 - Why it matters: `_stream_via_persistent_agent` currently blocks on `event_queue.get()` without timeout. If the worker thread stalls before posting `end` (e.g., dependency deadlock/hung call path), request handling can hang indefinitely.
 - Proposed change: Add bounded wait loop using `self.timeout_seconds` (or explicit persistent timeout knob), emit terminal timeout error with session context, and ensure worker completion path is still drained safely.
 - Validation steps:
   - `.venv/bin/python -m pytest -q tests/test_hermes_client.py -k "persistent and (timeout or watchdog or stream_events)"`
   - Add regression test that simulates worker non-termination and asserts deterministic `HermesClientError` timeout.
 - Notes/dependencies: Coordinate with existing fallback-to-direct behavior so timeout surfaces remain user-readable and non-duplicative.
 - Execution result: Completed 2026-03-27. `_stream_via_persistent_agent` now uses bounded `event_queue.get(timeout=...)` polling with `self.timeout_seconds` watchdog and raises deterministic timeout errors including session_id. Added `test_persistent_agent_stream_times_out_when_worker_stalls`.

- [x] R9: De-duplicate direct-agent tool-progress formatter and emoji map
 - Status: done
 - Severity: Medium
 - Scope/files: `hermes_client_agent_direct.py`, optional helper module, `tests/test_hermes_client.py`
 - Why it matters: `_format_tool_progress()` and `_agent_runner_script()` each carry near-identical tool emoji maps/formatting logic. This creates drift risk and inconsistent UX when one path changes without the other.
 - Proposed change: Consolidate mapping/format rules in one canonical helper and have both in-process formatter and child runner consume the same serialized map/constants.
 - Validation steps:
   - `.venv/bin/python -m pytest -q tests/test_hermes_client.py -k "tool_progress or stream_via_agent"`
   - Add snapshot-style assertion that parent/child formatter outputs stay equivalent for representative tool/progress payloads.
 - Notes/dependencies: Keep behavior backward compatible for current tool-progress modes (`all`, `new`, `verbose`, `off`).
 - Execution result: Completed 2026-03-27. Introduced module-level `_TOOL_PROGRESS_EMOJIS` canonical map, removed duplicated child-runner formatter/map, and made parent `_stream_via_agent` compute `display` from normalized `tool_name`/`preview`/`args`. Added tests validating script de-duplication and parent-side tool display formatting.

- [x] R10: Add explicit module-level regression tests for split direct/persistent transports + compatibility shim
 - Status: done
 - Severity: Medium
 - Scope/files: `tests/test_hermes_client.py` (or split transport-specific test modules), `hermes_client_agent.py`
 - Why it matters: After the split, most coverage still drives behavior through higher-level client flows; there is limited direct contract testing for shim export/proxy behavior and isolated transport failure edges.
 - Proposed change: Add focused tests for shim proxy surfaces (`logger`, `subprocess`), direct transport teardown invariants, and persistent transport checkpoint/exception propagation edge cases.
 - Validation steps:
   - `.venv/bin/python -m pytest -q tests/test_hermes_client.py`
   - Optional: split into `tests/test_hermes_client_agent_direct.py` / `tests/test_hermes_client_agent_persistent.py` and run both directly.
 - Notes/dependencies: Can be executed in parallel with R9 if helper extraction lands first.
 - Execution result: Completed 2026-03-27. Added focused regression tests for persistent worker exception wrapping (`test_persistent_agent_wraps_worker_exception_as_hermes_client_error`), shim logger proxy behavior in direct transport cleanup (`test_shim_logger_proxy_is_used_by_direct_module_cleanup`), and shim subprocess replacement contract (`test_shim_subprocess_proxy_supports_module_replacement`).

- [x] R11: Split `server.py` app bootstrap/composition into focused modules
 - Status: done
 - Severity: High
 - Scope/files: `server.py`, `app_factory.py`, new helper module(s) (e.g., `server_bootstrap.py`, `startup_diagnostics.py`), related route wiring tests.
 - Why it matters: `server.py` is ~545 lines and currently mixes env/config constants, auth/session wrappers, startup diagnostics assembly, Flask hook registration, static/public handlers, and route wiring. This monolith increases blast radius for changes and makes behavior-preserving review difficult.
 - Proposed change: Extract (1) startup diagnostics payload/logging, (2) auth/request helper adapters, and (3) blueprint registration/bootstrap orchestration into dedicated modules with explicit data contracts; keep `create_app()`/entrypoint stable.
 - Validation steps:
   - `.venv/bin/python -m pytest -q tests/test_routes_chat.py tests/test_routes_jobs_runtime.py tests/test_routes_auth.py`
   - `.venv/bin/python -m pytest -q tests/test_config.py`
 - Notes/dependencies: Preserve dynamic getter/lambda injection pattern already used for monkeypatch-safe route tests.
 - Execution result: Completed 2026-03-28. Extracted startup diagnostics into `server_startup.py` and public-route registration into `server_public_routes.py`; `server.py` now delegates both concerns while keeping `create_app()` and route wiring entrypoints stable.

- [x] R12: Decompose `hermes_client.py` into config/bootstrap vs transport orchestration
 - Status: done
 - Severity: Medium
 - Scope/files: `hermes_client.py`, potential new modules (e.g., `hermes_client_config.py`, `hermes_client_diagnostics.py`), `tests/test_hermes_client.py`.
 - Why it matters: `hermes_client.py` (~526 lines) combines env/config parsing, auth/config file parsing, diagnostics/health reporting, and runtime transport routing/fallback logic. This coupling makes transport changes risky and obscures regression boundaries.
 - Proposed change: Isolate pure configuration + diagnostics loading into dedicated helpers/dataclasses and leave `HermesClient.stream_events()` transport decision tree as a narrower orchestration layer.
 - Validation steps:
   - `.venv/bin/python -m pytest -q tests/test_hermes_client.py`
   - Add focused tests for config-loader helpers independent from transport mocks.
 - Notes/dependencies: Coordinate with existing split modules (`hermes_client_agent_direct.py`, `hermes_client_agent_persistent.py`) to avoid reintroducing shim drift.
 - Execution result: Completed 2026-03-28. Added `hermes_client_bootstrap.py` and routed `HermesClient` config/bootstrap methods (`_resolve_agent_routing`, `_load_*_from_config`, `_load_active_provider_from_auth_store`) through the extracted bootstrap component; follow-up cleanup removed redundant in-class config/bootstrap bodies while preserving logging/diagnostics semantics and reduced `hermes_client.py` to 354 lines.

- [x] R13: Break `JobRuntime` monolith into worker lifecycle + event bus components
 - Status: done
 - Severity: Medium
 - Scope/files: `job_runtime.py`, potential internal helpers (event pub/sub, retry/dead-letter handling, keepalive/touch logic), `tests/test_routes_jobs_runtime.py`.
 - Why it matters: `job_runtime.py` (~746 lines) mixes event queue management, watchdog/worker loops, stream consumption, retry/dead-letter semantics, truncation/chunking, and telemetry counters. The current shape raises defect risk when touching unrelated paths.
 - Proposed change: Extract cohesive units (e.g., event history broker, job execution runner, retry/dead-letter policy helper) behind small private interfaces while preserving `JobRuntime` public API.
 - Validation steps:
   - `.venv/bin/python -m pytest -q tests/test_routes_jobs_runtime.py tests/test_store.py`
   - Add targeted tests for extracted helper boundaries (event pruning + retry/dead transitions).
 - Notes/dependencies: Execute after R11/R12 to keep operational startup/routing stable while runtime internals are split.
 - Execution result: Completed 2026-03-28. Extracted event history/pub-sub/pruning into `job_runtime_events.py` (`JobEventBroker`) and updated `JobRuntime` to delegate event responsibilities through the broker while preserving compatibility shim attributes (`_event_lock`, `_event_history`, `_event_queues`, `_event_timestamps`); follow-up cleanup extracted chat-job stream execution into `job_runtime_chat_job.py` (`execute_chat_job`) and reduced `job_runtime.py` to 509 lines while preserving `run_chat_job()` API behavior.

- [x] R14: Decompose `store_jobs.py` into lifecycle-focused helpers (claim/retry/dead-letter/queries)
 - Status: done
 - Severity: High
 - Scope/files: `store_jobs.py`, potential new modules (`store_jobs_claim.py`, `store_jobs_retry.py`, `store_jobs_queries.py`), `tests/test_store.py`, `tests/test_routes_jobs_runtime.py`.
 - Why it matters: `store_jobs.py` is still 512 lines and mixes job claiming, retry backoff policy, dead-letter writes, stale cleanup, and API/state projection payload shaping. This coupling raises regression risk in a reliability-critical path.
 - Proposed change: Extract cohesive SQL clusters into private helpers/modules with explicit call contracts while preserving `SessionStore` public methods and transaction boundaries.
 - Validation steps:
   - `.venv/bin/python -m pytest -q tests/test_store.py tests/test_routes_jobs_runtime.py`
   - Add focused tests for each extracted helper path: claim race/no-row update, retry scheduling vs dead-letter, stale cleanup reason mapping.
 - Notes/dependencies: Keep SQL semantics behavior-identical; do not alter retry timing policy in this pass.
 - Execution result: Completed 2026-03-28. Split store-job lifecycle SQL into helper modules (`store_jobs_claim.py`, `store_jobs_retry.py`, `store_jobs_queries.py`) and reduced `store_jobs.py` to orchestration wrappers + dead-letter insert primitive. Added stale cleanup reason regression `test_cleanup_stale_jobs_thread_missing_reason_mapping`; validated store/runtime job suites.

- [x] R15: Decompose `store_chats.py` into read/query vs mutating/cancellation responsibilities
 - Status: done
 - Severity: Medium
 - Scope/files: `store_chats.py`, potential helper modules (`store_chat_queries.py`, `store_chat_mutations.py`), `tests/test_store.py`, `tests/test_routes_chat.py`.
 - Why it matters: `store_chats.py` is 470 lines and currently combines hydration/query CTEs, mutation flows, archival/reopen, and chat-job cancellation side effects. This broad scope makes chat UX fixes riskier.
 - Proposed change: Isolate read models/query builders from mutation flows and extract shared cancellation/dead-letter side effects into dedicated internal helpers.
- Validation steps:
  - `.venv/bin/python -m pytest -q tests/test_store.py tests/test_routes_chat.py`
  - Add focused regressions for `clear_chat`/`remove_chat` cancellation behavior and active-chat fallback invariants.
- Notes/dependencies: Coordinate with R14 so chat/job side effects remain single-sourced.
 - Execution result: Completed 2026-03-28. Extracted read/query and mutation/cancellation logic into `store_chat_queries.py` and `store_chat_mutations.py`, keeping `store_chats.py` as orchestration mixin surface. Added cancellation regression coverage (`test_clear_chat_cancels_open_jobs`) and validated with `pytest -q tests/test_store.py tests/test_routes_chat.py`.

- [x] R16: Finish `server.py` composition split by extracting request/auth adapter wiring
 - Status: done
 - Severity: Medium
 - Scope/files: `server.py`, new adapter module(s) (e.g., `server_request_adapters.py`), route registration tests.
 - Why it matters: `server.py` is still 460 lines and retains many thin wrappers (`_verify_*`, `_json_*`, `_sse_*`, token/session adapters) plus middleware/hook composition. This remains a high-blast-radius integration point.
 - Proposed change: Move adapter wrappers and request-context glue into dedicated helper module(s), leaving `server.py` as minimal bootstrap + blueprint assembly.
- Validation steps:
  - `.venv/bin/python -m pytest -q tests/test_routes_auth.py tests/test_routes_chat.py tests/test_routes_jobs_runtime.py`
  - `.venv/bin/python -m pytest -q tests/test_config.py`
- Notes/dependencies: Preserve dynamic getter/lambda injection conventions for monkeypatch-based tests.
 - Execution result: Completed 2026-03-28. Added `server_request_adapters.py` and moved request/auth adapter wiring out of `server.py` while preserving monkeypatch-friendly dynamic call resolution (auth verification wrappers + lambda-based route/template hooks). Verified targeted suites: `pytest -q tests/test_routes_auth.py tests/test_routes_meta.py tests/test_routes_jobs_runtime.py tests/test_routes_chat.py tests/test_store.py` (all passing).

- [x] R17: Add direct contract tests for newly extracted modules to prevent hidden drift
 - Status: done
 - Severity: High
 - Scope/files: `tests/test_hermes_client_bootstrap.py` (new), `tests/test_job_runtime_events.py` (new), `tests/test_job_runtime_chat_job.py` (new), `tests/test_server_startup.py` (new), `tests/test_server_public_routes.py` (new).
 - Why it matters: Current coverage still primarily exercises these extractions indirectly via larger integration tests. There are currently no direct module-level tests referencing `hermes_client_bootstrap`, `job_runtime_events`, `job_runtime_chat_job`, `server_startup`, or `server_public_routes`, increasing silent drift risk.
 - Proposed change: Add focused contract tests around each extracted module’s API behavior (inputs/outputs, edge paths, monkeypatch contracts) so future refactors fail fast.
 - Validation steps:
   - `.venv/bin/python -m pytest -q tests/test_hermes_client_bootstrap.py tests/test_job_runtime_events.py tests/test_job_runtime_chat_job.py tests/test_server_startup.py tests/test_server_public_routes.py`
   - `.venv/bin/python -m pytest -q tests/test_hermes_client.py tests/test_routes_jobs_runtime.py tests/test_routes_chat.py`
 - Notes/dependencies: Can run in parallel with R14/R15/R16 since this is additive coverage.
 - Execution result: Completed 2026-03-28. Added five direct module-level suites with focused contract assertions across bootstrap routing/config parsing, event broker replay/pruning/terminal delivery semantics, extracted chat-job execution behavior, startup diagnostics payload/log invariants, and public-route registration behavior.

- [x] R18: Introduce shared job-status/domain constants to reduce cross-module string drift
 - Status: done
 - Severity: Medium
 - Scope/files: `store_jobs.py`, `store_chats.py`, `job_runtime.py`, `routes_chat_stream.py`, `routes_jobs_runtime.py`, potential new `job_status.py` constants module, related tests.
 - Why it matters: Status domains (`queued/running/done/error/dead`) and open-job predicates are repeated across store/runtime/routes with inline string literals and slightly different predicates, increasing future drift risk.
 - Proposed change: Centralize status constants and common predicates (open/terminal/retryable sets) in one shared module and migrate call sites incrementally.
- Validation steps:
  - `.venv/bin/python -m pytest -q tests/test_store.py tests/test_routes_jobs_runtime.py tests/test_routes_chat.py`
  - Add focused tests asserting shared constants drive open/terminal checks consistently.
- Notes/dependencies: Keep SQL text readable; avoid over-abstracting query clauses.
 - Execution result: Completed 2026-03-28. Added shared status/event domain module `job_status.py` (status constants, open/terminal sets, SQL status-list helpers, and terminal event constants) and migrated store/runtime/route call sites (`store_jobs*.py`, `store_chat_mutations.py`, `job_runtime.py`, `routes_chat_stream.py`, `routes_jobs_runtime.py`) off ad-hoc literals while preserving response contracts. Validation: `pytest -q tests/test_store.py tests/test_routes_jobs_runtime.py tests/test_routes_chat.py tests/test_job_runtime_chat_job.py tests/test_job_runtime_events.py` and full `pytest -q` (185 passed).

## Evidence from this refresh pass
- `git status --short --branch`:
  - `## main...origin/main`
  - tracked modifications in runtime/store/routes/tests and untracked docs/new modules.
- Initial baseline signal before execution:
  - `.venv/bin/python -m pytest -q tests/test_store.py tests/test_routes_jobs_runtime.py tests/test_broad_exception_policy.py`
  - `42 passed, 1 failed`
  - failure: `tests/test_broad_exception_policy.py::test_broad_exception_handlers_require_policy_and_observability`
  - violations: `job_runtime.py` lines 221 and 229 missing `broad-except-policy:` justification.
- Execution validations (controller session, 2026-03-27):
  - `.venv/bin/python -m pytest -q tests/test_broad_exception_policy.py` → `1 passed in 0.03s`
  - `.venv/bin/python -m pytest -q tests/test_hermes_client.py` → `26 passed in 1.52s`
  - `.venv/bin/python -m pytest -q tests/test_routes_jobs_runtime.py` → `18 passed in 1.62s`
  - `.venv/bin/python -m pytest -q tests/test_store.py` → `27 passed in 0.17s`
  - `.venv/bin/python -m pytest -q tests/test_config.py` → `7 passed in 0.02s`
  - `.venv/bin/python -m pytest -q tests/test_routes_jobs_runtime.py tests/test_store.py tests/test_config.py` → `52 passed in 1.74s`
- Code audit signals addressed:
  - `hermes_client_agent.py` subprocess PIPE lifecycle now has explicit idempotent stdio close handling in teardown paths.
- Planning refresh evidence (2026-03-27 post-R7):
  - `git status --short --branch` → dirty working tree with split transport modules and runtime/store/route updates still in-flight.
  - `search_files("except Exception")` highlights persistent broad handlers and embedded child-runner broad catch in `_agent_runner_script()` (string code path not AST-checked by broad-exception policy gate).
  - `search_files("hermes_client_agent_(direct|persistent)", tests/)` indicates transport modules are mostly covered via top-level client tests, with limited direct module contract coverage.
  - `.venv/bin/python -m pytest -q tests/test_broad_exception_policy.py tests/test_hermes_client.py` → `27 passed in 1.56s`.
- Execution validations for R8/R9 (2026-03-27):
  - `.venv/bin/python -m pytest -q tests/test_hermes_client.py -k "persistent and (timeout or watchdog or stream_events)"` → `3 passed, 26 deselected in 0.15s`.
  - `.venv/bin/python -m pytest -q tests/test_hermes_client.py -k "tool_progress or stream_via_agent"` → `5 passed, 24 deselected in 1.70s`.
  - `.venv/bin/python -m pytest -q tests/test_broad_exception_policy.py tests/test_hermes_client.py` → `30 passed in 2.80s`.
- Execution validations for R10 (2026-03-27):
  - `.venv/bin/python -m pytest -q tests/test_hermes_client.py` → `32 passed in 3.23s`.
  - `.venv/bin/python -m pytest -q tests/test_broad_exception_policy.py tests/test_hermes_client.py` → `33 passed in 3.18s`.
- Refactor-pass refresh evidence (monolith audit, 2026-03-27):
  - `find . -name '*.py' -not -path './.venv/*' -print0 | xargs -0 wc -l | sort -nr | head -n 30` shows top monoliths: `job_runtime.py` (746), `server.py` (545), `hermes_client.py` (526), `store_jobs.py` (512), `store_chats.py` (470).
  - `read_file` audit confirmed multi-concern mixing in `server.py` (bootstrap/hooks/routes), `hermes_client.py` (config/diagnostics + routing), and `job_runtime.py` (worker loop + event bus + policy).
  - `.venv/bin/python -m pytest -q tests/test_routes_chat.py tests/test_routes_jobs_runtime.py tests/test_hermes_client.py` → `81 passed in 5.40s`.
- Follow-up cleanup evidence (2026-03-28, hermes_client monolith reduction):
  - `wc -l hermes_client.py` → `354`.
  - `.venv/bin/python -m pytest -q tests/test_broad_exception_policy.py tests/test_hermes_client.py` → `33 passed in 3.18s`.
  - `.venv/bin/python -m pytest -q tests/test_routes_chat.py tests/test_routes_jobs_runtime.py tests/test_routes_auth.py` → `55 passed in 2.50s`.
  - `.venv/bin/python -m pytest -q tests/test_config.py tests/test_store.py` → `34 passed in 0.19s`.
- Follow-up cleanup evidence (2026-03-28, job_runtime monolith reduction):
  - `wc -l job_runtime.py job_runtime_chat_job.py` → `509 job_runtime.py`, `194 job_runtime_chat_job.py`.
  - `python -m py_compile job_runtime.py job_runtime_chat_job.py` (with `.venv` active) → success.
  - `.venv/bin/python -m pytest -q tests/test_broad_exception_policy.py tests/test_routes_jobs_runtime.py` → `19 passed in 1.57s`.
  - `.venv/bin/python -m pytest -q tests/test_routes_chat.py tests/test_routes_auth.py` → `37 passed in 0.98s`.
  - `.venv/bin/python -m pytest -q tests/test_config.py tests/test_store.py` → `34 passed in 0.16s`.
- Full-project refactor/hardening assessment refresh (2026-03-28):
  - `git status --short --branch` confirms broad dirty tree still centered in server/runtime/store/routes/tests with newly extracted helper modules untracked.
  - `find . -name '*.py' -not -path './.venv/*' -print0 | xargs -0 wc -l | sort -nr | head -n 30` current top monoliths: `store_jobs.py` (512), `job_runtime.py` (509), `store_chats.py` (470), `server.py` (460), `hermes_client_agent_direct.py` (372).
  - `search_files("TODO|FIXME|XXX|HACK", "*.py")` → no placeholder debt markers in code.
  - `search_files("job_runtime_chat_job|job_runtime_events|server_startup|server_public_routes|hermes_client_bootstrap", path=tests/)` → no direct test references for newly extracted modules; added R17 to close this gap.
  - `.venv/bin/python -m pytest -q tests/test_broad_exception_policy.py tests/test_hermes_client.py` → `33 passed in 3.22s`.
- Execution validations for R17 (2026-03-28):
  - `.venv/bin/python -m pytest -q tests/test_hermes_client_bootstrap.py tests/test_job_runtime_events.py tests/test_job_runtime_chat_job.py tests/test_server_startup.py tests/test_server_public_routes.py` → `16 passed in 0.12s`.
  - `.venv/bin/python -m pytest -q tests/test_hermes_client.py tests/test_routes_jobs_runtime.py tests/test_routes_chat.py` → `81 passed in 5.40s`.
- Execution validations for R14 (2026-03-28):
  - `python -m py_compile store_jobs.py store_jobs_claim.py store_jobs_retry.py store_jobs_queries.py` (with `.venv` active) → success.
  - `.venv/bin/python -m pytest -q tests/test_store.py tests/test_routes_jobs_runtime.py` → `46 passed in 1.81s`.
  - Added targeted stale-cleanup reason regression: `test_cleanup_stale_jobs_thread_missing_reason_mapping`.
- Post-batch policy sanity check (2026-03-28):
  - `.venv/bin/python -m pytest -q tests/test_broad_exception_policy.py` → `1 passed in 0.03s`.
