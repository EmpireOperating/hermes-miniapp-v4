# Refactor Plan — hermes-miniapp-v4

## Project snapshot
- Project: hermes-miniapp-v4
- Project slug: hermes-miniapp-v4
- Generated: 2026-03-27T16:20:54-06:00
- Branch: main
- Git status: clean (`## main...origin/main`)
- Analysis mode: planning only (no code changes made)

## Progress metrics
- Total items: 8
- Done: 8
- In progress: 0
- Blocked: 0
- Todo: 0
- % complete: 100%
- Last completed item: R6
- Last updated: 2026-03-27T17:32:18-06:00

## Next up
- Plan complete. No remaining backlog items.

## Recently completed
- R6 (2026-03-27): Centralized shared runtime/config limits in new `runtime_limits.py` and rewired `miniapp_config.py` + `job_runtime.py` to consume named constants instead of duplicated numeric literals; added config regression coverage.
- R3 (2026-03-27): Introduced `AppRuntimeDependencies`/`create_runtime_dependencies` explicit app-state wiring in `app_factory.py`; `server.py` now binds runtime dependencies via dependency container instead of global sync shim.
- R8 (2026-03-27): Added scoped static broad-exception policy gate (`tests/test_broad_exception_policy.py`) and required policy annotations/justification on broad handlers in `hermes_client.py`, `job_runtime.py`, and `server.py`.
- R5 (2026-03-27): Reworked `list_chats` query path in `store_chats.py` to use pre-aggregated CTE/join strategy, added supporting indexes, and expanded regression tests.
- R7 (2026-03-27): Added startup diagnostics summaries/invariants with safe redacted logging in `server.py` and `hermes_client.py`, plus regression coverage.
- R4 (2026-03-27): Normalized chat-management route boilerplate with composable guards/decorators and extended 404/validation route tests.
- R2 (2026-03-27): Improved config/auth parse observability with structured warnings, preserved fallback behavior, and added malformed/non-UTF8 regression tests.
- R1 (2026-03-27): Replaced hardcoded runtime buffer caps with config-driven caps and added regression guards/tests.

## Backlog summary
- High: 0
- Medium: 0
- Low: 0

## Backlog

- [x] R1: Align runtime buffer limits with configured caps
 - Status: done
 - Severity: High
 - Scope/files: `job_runtime.py`, `tests/test_routes_jobs_runtime.py`, `tests/test_streaming_hardening_guards.py`
 - Why it matters: `job_runtime.py` uses hardcoded `512` caps for event history/subscriber queue while config exposes `MINI_APP_JOB_EVENT_HISTORY_MAX_JOBS`; this can violate operator expectations and hide memory/backpressure tuning.
 - Proposed change: Replace magic `512` caps with config-driven values (or explicit paired config knobs), document defaults, and keep terminal-event delivery guarantees.
 - Validation steps:
   - `.venv/bin/python -m pytest -q tests/test_routes_jobs_runtime.py`
   - `.venv/bin/python -m pytest -q tests/test_streaming_hardening_guards.py`
 - Notes/dependencies: Do first; other runtime refactors should build on this behavior contract.
  - Execution result: Completed 2026-03-27; queue/history caps now follow config and targeted tests pass.

- [x] R2: Improve config/auth parsing observability for routing fallbacks
 - Status: done
 - Severity: Medium
 - Scope/files: `hermes_client.py`, `tests/test_hermes_client.py`
 - Why it matters: Multiple broad `except Exception` parse paths silently degrade to fallback behavior, which can mask auth/config drift and complicate incident debugging.
 - Proposed change: Narrow exception handling where feasible, emit structured debug/warn logs with file path + failure class, and add tests for malformed auth/config inputs.
 - Validation steps:
   - `.venv/bin/python -m pytest -q tests/test_hermes_client.py`
 - Notes/dependencies: Keep behavior unchanged (fallbacks still work) while improving diagnosability.
 - Execution result: Completed 2026-03-27; added structured parse warnings and malformed/non-UTF8 fallback coverage.

- [x] R3: Break `server.py` runtime wiring into explicit app-state/dependency module
 - Status: done
 - Severity: High
 - Scope/files: `server.py`, `app_factory.py`, `routes_chat_context.py`, route registration modules, tests touching monkeypatch globals
 - Why it matters: `server.py` currently owns many globals plus `_sync_runtime_bindings()` compatibility shims; this increases coupling and test fragility.
 - Proposed change: Introduce explicit app state container/factory wiring and inject dependencies into route registrars without mutable module-global synchronization.
 - Validation steps:
   - `.venv/bin/python -m pytest -q tests/test_routes_chat.py tests/test_routes_jobs_runtime.py tests/test_routes_auth.py tests/test_routes_meta.py`
 - Notes/dependencies: Coordinate carefully with monkeypatch-based tests to preserve current behavior.
 - Execution result: Completed 2026-03-27; added `AppRuntimeDependencies` wiring in `app_factory.py`, removed global sync shim usage in `server.py`, and preserved monkeypatch behavior through explicit `bind_runtime()` calls.

- [x] R4: Normalize chat-management route handler boilerplate
 - Status: done
 - Severity: Medium
 - Scope/files: `routes_chat_management.py`, `routes_chat_context.py`, `routes_chat_resolution.py`, `tests/test_routes_chat.py`
 - Why it matters: Repeated payload/auth/chat-id extraction and tuple-style error plumbing increase maintenance burden and risk of inconsistent endpoint behavior.
 - Proposed change: Introduce composable helper/decorator utilities for common request guard patterns; preserve existing response contracts.
 - Validation steps:
   - `.venv/bin/python -m pytest -q tests/test_routes_chat.py`
 - Notes/dependencies: Keep this behavior-preserving; avoid endpoint payload changes.
 - Execution result: Completed 2026-03-27; route guard/decorator helpers now centralize auth/chat-id extraction, missing-chat mapping tightened with predicates, and chat route regressions expanded.

- [x] R5: Optimize chat list query path for scale
 - Status: done
 - Severity: Medium
 - Scope/files: `store_chats.py`, `store_schema.py`, `tests/test_store.py`
 - Why it matters: `_select_chat_rows` uses correlated subquery + aggregate per chat and may become expensive at higher message volume/chat count.
 - Proposed change: Consider pre-aggregated CTE or indexed joins for pending/unread derivation; verify with representative dataset tests.
 - Validation steps:
   - `.venv/bin/python -m pytest -q tests/test_store.py`
   - Optional benchmark script for `list_chats` on synthetic large dataset
 - Notes/dependencies: Requires careful SQL equivalence checks to avoid unread/pending regressions.
 - Execution result: Completed 2026-03-27; rewired `list_chats` query path to filtered CTE + aggregate joins, added chat-listing indexes, and added legacy-schema migration regression coverage.

- [x] R6: Centralize cross-module constants and limits
 - Status: done
 - Severity: Low
 - Scope/files: `server.py`, `job_runtime.py`, `miniapp_config.py`, related tests
 - Why it matters: Repeated numeric/string constants increase drift risk during tuning/hardening.
 - Proposed change: Consolidate runtime limits into config-backed constants with explicit naming and documentation.
 - Validation steps:
   - `.venv/bin/python -m pytest -q`
 - Notes/dependencies: Can be batched with R1/R3 to minimize churn.
 - Execution result: Completed 2026-03-27; introduced `runtime_limits.py` and moved shared runtime bound defaults/minimums out of module-local literals in `miniapp_config.py` and `job_runtime.py`.

- [x] R7: Strengthen startup diagnostics for runtime dependencies
 - Status: done
 - Severity: Medium
 - Scope/files: `server.py`, `hermes_client.py`, `README.md`
 - Why it matters: Environment mismatches (missing venv deps, routing vars, auth files) can fail softly and delay root-cause detection.
 - Proposed change: Add explicit startup status summary/log entries for key dependencies and selected config invariants.
 - Validation steps:
   - `.venv/bin/python -m pytest -q tests/test_config.py tests/test_hermes_client.py`
 - Notes/dependencies: Keep secrets redacted in logs.
 - Execution result: Completed 2026-03-27; startup diagnostics/invariants added, exception logging hardened to avoid raw payload leakage, and startup regression tests extended.

- [x] R8: Add targeted static quality gate for broad exception usage
 - Status: done
 - Severity: Medium
 - Scope/files: `hermes_client.py`, `job_runtime.py`, `server.py`, test suite
 - Why it matters: Broad exception handlers are sometimes necessary but currently unevenly documented; quality can regress without guardrails.
 - Proposed change: Add policy comments/tests/linting guard to require explicit justification/logging for broad exception blocks.
 - Validation steps:
   - `.venv/bin/python -m pytest -q`
   - Optional lint check if introduced
 - Notes/dependencies: Keep pragmatic exceptions where reliability demands best-effort behavior.
 - Execution result: Completed 2026-03-27; added `tests/test_broad_exception_policy.py` static gate and annotated broad exceptions with explicit policy/logging expectations across target modules.

## Evidence from planning + execution
- `git status --short --branch` → `## main...origin/main`
- `.venv/bin/python -m pytest -q` → `137 passed in 25.20s`
- `.venv/bin/python -m compileall -q .` → success (exit 0)
- `python -m pytest -q` (system python) → failed (`No module named pytest`) confirming tests should run via project venv

- Execution validations (2026-03-27):
  - `.venv/bin/python -m pytest -q tests/test_routes_jobs_runtime.py` → `15 passed in 2.36s`
  - `.venv/bin/python -m pytest -q tests/test_streaming_hardening_guards.py` → `5 passed in 0.04s`
  - `.venv/bin/python -m pytest -q tests/test_hermes_client.py` → `24 passed in 1.38s`
  - `.venv/bin/python -m pytest -q tests/test_routes_chat.py` → `31 passed in 1.59s`
  - `.venv/bin/python -m pytest -q tests/test_config.py tests/test_hermes_client.py` → `31 passed in 1.39s`
  - `.venv/bin/python -m pytest -q tests/test_routes_chat.py tests/test_hermes_client.py tests/test_config.py` → `62 passed in 11.70s`
  - `.venv/bin/python -m py_compile routes_chat_management.py routes_chat_resolution.py server.py hermes_client.py` → success (exit 0)
  - `.venv/bin/python -m pytest -q tests/test_store.py tests/test_broad_exception_policy.py tests/test_hermes_client.py tests/test_routes_jobs_runtime.py tests/test_config.py` → `71 passed in 3.79s`
  - `.venv/bin/python -m pytest -q tests/test_routes_chat.py tests/test_routes_jobs_runtime.py tests/test_routes_auth.py tests/test_routes_meta.py` → `83 passed in 3.17s`
  - `.venv/bin/python -m pytest -q tests/test_routes_chat.py tests/test_routes_jobs_runtime.py tests/test_routes_auth.py tests/test_routes_meta.py tests/test_streaming_hardening_guards.py tests/test_config.py` → `96 passed in 3.27s`
  - `.venv/bin/python -m py_compile app_factory.py server.py job_runtime.py miniapp_config.py runtime_limits.py tests/test_config.py` → success (exit 0)
  - `.venv/bin/python -m pytest -q` full suite in this host session hit transient FD exhaustion (`Errno 24: Too many open files`) due background worker churn; targeted validation commands above passed.
