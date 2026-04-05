# Miniapp Warm Session Ownership Decision

> This document records the explicit architecture decision for warm-session behavior in the miniapp backend rewrite.
> 
> For Hermes or follow-on agents: do not re-decide this ad hoc in code. Treat this doc as the decision anchor for backend-swap work.

Linked docs:
- Primary two-track plan: `docs/plans/2026-04-02-miniapp-chat-isolation-two-track-plan.md`
- Implementation status: `docs/plans/2026-04-03-miniapp-two-track-implementation-status.md`
- Updated backend-swap checklist: `docs/plans/2026-04-03-miniapp-backend-swap-updated-todo-checklist.md`
- Isolation runbook: `docs/miniapp-worker-isolation-runbook.md`

Date: 2026-04-03

---

## Decision summary

Decision:
- The shared Flask/backend process must not own production warm per-chat agent state once subprocess worker isolation is the architecture default.
- The current production-safe mode remains checkpoint-only continuity when `MINI_APP_JOB_WORKER_LAUNCHER=subprocess`.
- The target end-state is a hybrid/per-chat isolated warm-session model where warm continuity, if restored, is owned by an isolated worker boundary rather than the shared backend process.

Short version:
- shared-backend warm session ownership is not the final architecture
- checkpoint-only is the current safety default
- isolated-worker-owned warm continuity is the intended destination

---

## Why this decision exists

The rewrite goal is not merely “fewer crashes.”
It is:
- preserve CLI capability parity
- improve chat isolation
- prevent one chat or delegated subtree from crashing the whole miniapp backend

The old model allowed logical chat separation while still sharing the main fault domain:
- one backend process
- one persistent in-memory runtime owner
- one shared memory/task/fd budget

That makes shared warm persistence in the backend process fundamentally at odds with true per-chat isolation.

So the design rule is now:
- warm continuity may exist
- but its ownership must move out of the shared backend process

---

## Options considered

### Option A: Keep shared in-process warm persistence in the Flask/backend service
Rejected as final architecture.

Pros:
- best session feel with minimal replay
- easy reuse of existing `PersistentSessionManager`

Cons:
- shared backend remains a chat-state fault domain
- one bad warm runtime can still pressure the shared service
- conflicts with the isolation goals of Track A

Conclusion:
- acceptable only as legacy/inline behavior, not as final production isolation architecture

### Option B: Permanent checkpoint-only continuity
Accepted as current safe mode, but not preferred as final target.

Pros:
- simplest and safest with subprocess worker isolation
- easy to reason about
- no shared in-memory warm ownership in the main backend

Cons:
- weaker CLI-session feel
- repeated turns rely on replay/checkpoint continuity instead of true warm ownership
- may fall short of the product goal if session feel parity matters

Conclusion:
- valid safety fallback and current production-safe mode
- not the preferred destination if session-feel parity remains a goal

### Option C: Hybrid / per-chat isolated warm worker ownership
Accepted as target end-state.

Definition:
- each chat may have warm continuity
- but that warm state is owned by an isolated worker/session boundary outside the shared backend
- backend remains orchestrator/relay, not the owner of live warm agent state

Pros:
- aligns with CLI-like session feel
- aligns with per-chat fault-domain containment
- preserves capability parity without putting warm state back into the shared backend

Cons:
- more implementation complexity
- requires lifecycle management, cleanup, and observability
- needs careful reconnect/resume semantics

Conclusion:
- this is the preferred end-state

---

## Final decision

The architecture target is Option C.

The implementation rule is:
- when running with subprocess worker isolation, warm session ownership must not live in the shared backend process
- current production-safe continuity mode remains checkpoint-only until isolated-worker-owned warm continuity is implemented safely
- any future restoration of warm per-chat session behavior must be worker-owned and isolation-compatible

This means:
- `shared` ownership is not the sign-off target for subprocess production mode
- `checkpoint_only` is a temporary/acceptable safe mode, not the intended final session model
- backend-swap-done should mean isolated-worker-owned warm continuity or an explicit product decision to permanently accept checkpoint-only continuity

---

## Practical implementation guidance

### Allowed now
- subprocess worker isolation with checkpoint-only continuity
- explicit diagnostics showing that warm continuity is safety-limited
- replay/checkpoint continuity to preserve correctness

### Not allowed
- moving shared warm runtime ownership back into the Flask/backend process for subprocess production mode
- silently re-enabling shared warm persistence just to improve session feel
- hidden fallback from isolation-compatible mode to shared-backend warm ownership

### Required for future warm-session work
Any future warm continuity implementation must satisfy all of these:
- ownership is outside the shared backend process
- one chat failure remains local
- reconnect/resume semantics are preserved
- cleanup/idle eviction is explicit
- operator diagnostics expose current warm owner and state

---

## First implementation slice aligned with this decision

The first slice after this decision should do two things:

1. Make the current strategy explicit in diagnostics
- current continuity mode
- ownership mode
- whether warm persistence is intentionally disabled for safety
- target strategy

2. Make future implementation direction explicit in docs/checklists
- warm-session work should converge on isolated-worker-owned warmth
- not shared-backend warmth

Implementation checkpoint (landed 2026-04-03):
- Added explicit code-level contract object:
  - `hermes_client_types.WarmSessionContract`
- Added client helper:
  - `HermesClient.warm_session_contract()`
- Exposed normalized warm-session strategy through diagnostics:
  - `runtime_status()['warm_sessions']`
  - `startup_diagnostics()['warm_sessions']`
  - `/api/runtime/status -> warm_sessions`
- This gives future agents and operators one canonical structure for the current warm-session mode and target direction.

This allows future agents to build toward the same target instead of reopening the design question.

---

## Completion implications

Backend swap is not fully complete until one of these is true:

1. Isolated-worker-owned warm continuity is implemented and validated
or
2. The product decision is updated to explicitly accept checkpoint-only continuity as the permanent final model

Until one of those is true, the backend rewrite should be described as:
- materially improved
- safer and more isolated
- not yet final in warm-session ownership design

---

## Handoff note

If a future agent proposes restoring in-memory shared persistence in the main backend process for subprocess production mode, treat that as a design regression unless this document is explicitly updated first.
