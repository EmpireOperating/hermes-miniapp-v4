# Miniapp Worker-Owned Warm Session Contract

> This document defines the next implementation target after the warm-session ownership decision.
> 
> It is the contract for what a future isolated-worker-owned warm session must look like.

Linked docs:
- Warm-session ownership decision: `docs/plans/2026-04-03-miniapp-warm-session-ownership-decision.md`
- Backend swap checklist: `docs/plans/2026-04-03-miniapp-backend-swap-updated-todo-checklist.md`
- Primary two-track plan: `docs/plans/2026-04-02-miniapp-chat-isolation-two-track-plan.md`
- Live QA checklist for the bounded implementation: `docs/plans/2026-04-04-miniapp-worker-owned-warm-continuity-qa-checklist.md`

Date: 2026-04-03

---

## Why this contract exists

We now have an explicit design decision:
- shared-backend warm ownership is not the final architecture
- checkpoint-only continuity is the current safety mode
- isolated-worker-owned warm continuity is the target end-state

This contract exists so future implementation work is concrete instead of hand-wavy.

---

## High-level target

A future warm miniapp chat should work like this:
- one chat maps to one isolated warm owner
- that owner lives outside the shared Flask/backend process
- the owner may survive across turns for the same chat
- the backend acts as scheduler/relay/state authority, not the live warm owner

In plain terms:
- keep the “same conversation brain” feel
- without putting that live brain back into the shared backend process

---

## Contract fields

The current code-level contract now exposes these fields via `WarmSessionContract`:

- `current_mode`
- `owner`
- `owner_class`
- `lifecycle_state`
- `lifecycle_scope`
- `eviction_policy`
- `requested`
- `enabled`
- `ownership`
- `launcher`
- `target_mode`
- `target_status`
- `safety_reason`

These fields exist so the system can distinguish:
- current safe mode
- current owner shape
- lifecycle semantics
- intended target shape

---

## Current modes

### 1. Shared backend warm runtime
Used only in legacy/non-isolated inline mode.

Expected fields:
- `current_mode = shared_backend_warm_runtime`
- `owner = shared_backend_process`
- `owner_class = backend_local_runtime`
- `lifecycle_state = active_when_session_manager_entry_exists`
- `lifecycle_scope = process_local_shared_backend`
- `eviction_policy = session_manager_idle_ttl_or_capacity`

Meaning:
- warm owner exists
- warm owner is in the shared backend process
- acceptable only as legacy/inline behavior

### 2. Checkpoint-only continuity
Current subprocess-safe mode.

Expected fields:
- `current_mode = checkpoint_only_continuity`
- `owner = none_checkpoint_only`
- `owner_class = no_live_warm_owner`
- `lifecycle_state = cold_start_each_turn`
- `lifecycle_scope = per_turn_worker_attempt`
- `eviction_policy = none_checkpoint_only`

Meaning:
- no live warm owner survives across turns
- each turn is effectively cold-started with checkpoint/history continuity
- this is safer, but not final if session-feel parity remains important

---

## Target worker-owned warm session model

Future target mode:
- `target_mode = isolated_worker_owned_warm_continuity`

Expected target semantics:
- owner is not the shared backend process
- owner survives across turns for the same chat when healthy
- owner can be evicted/retired safely
- one owner failure affects only its chat

Intended future field shape:
- `owner = isolated_chat_worker`
- `owner_class = worker_remote_runtime`
- `lifecycle_state = warm_across_turns_until_idle_or_failure`
- `lifecycle_scope = per_chat_isolated_worker`
- `eviction_policy = idle_ttl_or_explicit_backend_reap`

Note:
- these are target semantics, not yet implemented current values

---

## Required lifecycle guarantees for future implementation

Any real implementation of isolated-worker-owned warmth must guarantee:

1. Isolation
- one warm owner belongs to one chat
- one owner failure does not poison neighboring chats

2. Ownership clarity
- backend knows whether a warm owner exists for a chat
- backend can identify the owner class and lifecycle state

3. Explicit eviction
- idle expiration is defined
- failure invalidation is defined
- operator/backend reap path is defined

4. Resume/reconnect compatibility
- reconnecting clients can still observe the correct chat/job state
- stream resume must not accidentally attach to the wrong warm owner

5. Safe fallback
- if a warm owner is unavailable, system falls back predictably
- fallback must be attributable and visible

---

## First practical implementation steps toward this target

Future slices should likely proceed in this order:

1. Contract and diagnostics (landed)
- current/target warm-session semantics surfaced explicitly

2. Ownership registry abstraction (landed as first scaffolding slice)
- introduced explicit protocol:
  - `hermes_client_types.WarmSessionRegistry`
- `HermesClient` now exposes:
  - `_warm_session_registry`
- registry selection is now explicit:
  - shared/inline mode -> `PersistentSessionManager`
  - checkpoint-only/subprocess-safe mode -> `IsolatedWorkerWarmSessionRegistryScaffold`
- this is intentionally a contract seam, not yet a real isolated worker-owned implementation

3. Owner lifecycle events (expanded slice landed)
- created owner lifecycle/event primitives in the current registry implementation:
  - `created`
  - `attach`
  - `evicted_explicit`
  - `evicted_capacity`
  - `evicted_idle`
- added checkpoint-only/isolated-registry scaffold worker lifecycle events:
  - `scaffold_initialized`
  - `worker_started`
  - `worker_finished`
  - `lookup`
  - `evict_noop`
  - `create_rejected`
- exposed owner lifecycle state through registry diagnostics:
  - `owner_state()`
  - `owner_events()`
- surfaced registry owner state through `warm_sessions.owner_state`
- wired job runtime start/finish hooks to emit worker lifecycle state into the checkpoint-only scaffold registry
- note: this is still scaffolding and observability, not yet a true isolated worker-owned warm implementation

4. Structured per-session owner records (expanded scaffolding slice landed)
- isolated-worker scaffold now maintains per-session owner records with:
  - `session_id`
  - `state`
  - `lifecycle_phase`
  - `reusable`
  - `reusability_reason`
  - `chat_id`
  - `job_id`
  - `owner_pid`
  - `last_outcome`
  - `last_started_monotonic_ms`
  - `last_finished_monotonic_ms`
- runtime start/finish hooks now populate those records for checkpoint-only worker attempts
- this gives us a concrete owner-state model before true warm reuse exists

5. Reuse eligibility/state-machine scaffolding (expanded slice landed)
- checkpoint-only worker attempts now encode a real eligibility hint:
  - running attempt -> `reusable = false`, `reusability_reason = worker_attempt_in_progress`
  - completed attempt -> `reusable = true`, `reusability_reason = isolated_worker_warm_reuse_not_implemented`
- reusable candidates are now retained for a bounded window via:
  - `reusable_until_monotonic_ms`
  - scaffold-level `reusable_candidate_ttl_ms`
- candidate expiry now transitions records to:
  - `state = expired`
  - `lifecycle_phase = expired_candidate`
  - `reusable = false`
  - `reusability_reason = candidate_ttl_expired`
- explicit invalidation is now modeled too:
  - `state = evicted`
  - `lifecycle_phase = invalidated`
  - `reusable = false`
  - `reusability_reason = <action-specific reason>`
- real mutation/eviction paths now feed action-specific invalidation reasons, including:
  - `invalidated_by_clear`
  - `invalidated_by_remove`
- this makes the remaining gap explicit: reuse may be architecturally desirable, but is not behaviorally implemented yet

6. Candidate selection API (expanded into dry-run decisioning slice)
- registries now expose `select_reusable_candidate(session_id)`
- isolated-worker scaffold returns a reusable candidate only when the owner record is currently marked reusable and not expired
- client now exposes `select_warm_session_candidate(session_id)` so future runtime logic can query candidate reuse through one path
- client stream path now performs a dry-run probe at stream start:
  - records whether a candidate was available
  - records why it was unavailable when absent
- client now records an explicit reuse policy check before any future attempt path:
  - `evaluate_warm_reuse_policy(...)`
  - current policy result is always `disabled_by_policy`
- reusable candidates now emit an explicit normalized handoff contract:
  - `reuse_contract.contract_version = warm-reuse-v1`
  - `reuse_contract.session_id`
  - `reuse_contract.owner_class`
  - `reuse_contract.owner_pid`
  - `reuse_contract.lifecycle_phase`
  - `reuse_contract.reusability_reason`
  - `reuse_contract.resume_supported`
  - `reuse_contract.resume_capability`
  - `reuse_contract.supported_resume_modes`
  - `reuse_contract.required_transport`
  - `reuse_contract.attach_mechanism`
  - `reuse_contract.required_now`
  - `reuse_contract.reserved_for_future`
  - reserved placeholders now included for future rollout:
    - `resume_token`
    - `worker_endpoint`
    - `transport_kind`
    - `resume_deadline_ms`
- client now records a guarded reuse-attempt seam when policy allows:
  - `attempt_warm_reuse(...)`
  - attempt validation now reads the normalized `reuse_contract`
  - validation is now centralized in a dedicated helper:
    - `validate_warm_reuse_contract(...)`
  - worker-attach capable contracts now also produce a dedicated attach-handshake plan:
    - `plan_worker_attach_handshake(...)`
  - worker-attach planning now feeds a first execution stub:
    - `execute_worker_attach(...)`
  - attach planning/execution now roll up into a unified eligibility decision:
    - `decide_worker_attach_eligibility(...)`
  - attach-eligible cases now feed a first attach-action seam:
    - `execute_worker_attach_action(...)`
  - the attach-action seam now performs a minimal real handshake-readiness check and classifies outcomes such as:
    - `attach_action_handshake_unavailable`
    - `attach_action_handshake_ready`
  - the execution stub now performs a safe PID-liveness probe and lightweight process/session verification via proc metadata, classifying outcomes such as:
    - `attach_owner_missing`
    - `attach_owner_present_but_unverifiable`
    - `attach_owner_present_wrong_identity`
    - `attach_owner_identity_verified_session_unverified`
    - `attach_owner_identity_verified_session_verified`
  - validator results now distinguish:
    - `valid`
    - `missing_required_fields`
    - `invalid_session_binding`
    - `unsupported_contract_version`
  - validator now also surfaces resume-strategy metadata such as:
    - `resume_capability`
  - attempt telemetry now includes:
    - `validation`
    - `attach_plan`
    - `attach_execution`
    - `attach_eligibility`
    - `attach_action`
    - `missing_required_fields`
    - `reserved_future_fields`
  - attempt outcomes are now attributable, including:
    - `reuse_contract_missing_required_fields`
    - `reuse_contract_invalid_session_binding`
    - `reuse_contract_unsupported_version`
    - `reuse_resume_not_supported_yet`
    - `reuse_worker_attach_not_supported_yet`
  - each attempt now records explicit fallback attribution:
    - `fallback_to`
    - `fallback_reason`
  - allowed attempts still fall through safely to the existing cold-path behavior
- client records a reuse decision at stream start:
  - `candidate_available_policy_blocked`
  - `candidate_available_reuse_allowed`
  - `candidate_unavailable`
- diagnostics now surface:
  - `warm_sessions.recent_candidate_probes`
  - `warm_sessions.recent_reuse_policy_checks`
  - `warm_sessions.recent_reuse_attempts`
  - `warm_sessions.recent_reuse_decisions`
- this is now the clean policy-and-attempt seam between telemetry-only scaffolding and future real reuse behavior

7. Real worker-owned warm implementation
- bind a per-chat isolated worker/session to that lifecycle model
- preserve isolation boundaries

8. Bounded live implementation checkpoint (landed and live-verified)
- first turn can preserve a detached warm owner
- owner can remain `attachable_running` with live attach metadata
- later ordinary turns can attach back into the same worker
- attach contract refresh rotates before attached terminal `done`
- clear/remove invalidation and attach-deadline expiry preserve correct final owner state
- first-turn queue/SSE handoff now emits a normal terminal `done` before job completion
- browser/API verification steps are captured in:
  - `docs/plans/2026-04-04-miniapp-worker-owned-warm-continuity-qa-checklist.md`

---

## Handoff note

If a future agent starts implementing isolated-worker-owned warm continuity, they should update this document first if the target lifecycle semantics change.

If the implementation starts drifting back toward shared backend ownership, that is a design regression unless the decision doc is explicitly revised.
