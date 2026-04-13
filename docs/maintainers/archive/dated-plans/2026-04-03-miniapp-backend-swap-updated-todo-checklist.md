# Miniapp Backend Swap — Updated Todo Checklist

> This is THE updated todo checklist for the miniapp backend isolation / robustness rewrite.
> 
> For Hermes or any follow-on agent: use this document as the primary execution checklist for remaining backend-swap work.
> 
> Linked context:
> - Primary architecture plan: `docs/maintainers/archive/dated-plans/2026-04-02-miniapp-chat-isolation-two-track-plan.md`
> - Implementation status snapshot: `docs/maintainers/archive/dated-plans/2026-04-03-miniapp-two-track-implementation-status.md`
> - Isolation runbooks:
>   - `docs/maintainers/runbooks/miniapp-worker-isolation-runbook.md`
>   - `docs/maintainers/runbooks/miniapp-child-spawn-hardening-runbook.md`

Date: 2026-04-03

---

## Purpose

This checklist answers one question:
- What still must be done before we can honestly call the miniapp backend swap complete?

Warm-session ownership decision anchor:
- `docs/maintainers/archive/dated-plans/2026-04-03-miniapp-warm-session-ownership-decision.md`

Latest broader sign-off snapshot:
- `docs/maintainers/archive/dated-plans/2026-04-04-miniapp-backend-swap-signoff-pass.md`

Use this doc for:
- agent handoff
- implementation sequencing
- sign-off readiness
- deciding what is required vs optional

Do not treat every item here as equal priority.
The top section is the real completion gate.

---

## Completion definition

Backend swap is done only when all of these are true:

1. One chat can fail, timeout, or spawn a bad descendant tree without taking down the shared miniapp backend.
2. The production-default execution path behaves like an isolated per-chat backend session, not merely a logically separated tab with shared process risk.
3. Transport selection is predictable and observable; unexpected fallback is visible and attributable.
4. Resume/reconnect/tab-switch behavior is stable under real multi-chat use.
5. The user-facing experience is close enough to CLI parity that miniapp is not silently degrading to a lower-fidelity mode during normal operation.
6. The remaining failure modes are either:
   - explicitly accepted design tradeoffs, or
   - covered by regression tests and operator diagnostics.

---

## Status legend

- Done: implemented and validated
- Partial: meaningful work landed, but not enough for sign-off
- Todo: not complete enough for sign-off
- Optional: useful after sign-off, but not required for backend-swap-done

---

## Must do before sign-off

### 1. Decide and finish the final warm-session ownership model
Status: Partial
Priority: P0

Why this matters:
- This is the biggest remaining architectural gap.
- Current subprocess isolation is safer, but it uses `checkpoint_only` ownership in subprocess mode.
- That improves robustness, but it is not yet the full “each chat behaves like its own CLI session” end-state.

Current state:
- subprocess worker boundary exists
- explicit warm-session ownership decision doc exists:
  - `docs/maintainers/archive/dated-plans/2026-04-03-miniapp-warm-session-ownership-decision.md`
- runtime/status diagnostics surface the current warm-session strategy and target mode via `warm_sessions`
- bounded worker-owned warm continuity now works end-to-end in the live path:
  - first turn can preserve a detached warm owner
  - later ordinary turns can attach back into the same worker
  - attach contract refresh rotates before attached terminal `done`
  - explicit clear/remove invalidation and attach-deadline expiry preserve correct final owner state
  - first-turn queue/SSE termination now ends with a normal `done` payload instead of synthetic terminal DB recovery
- compact live verification checklist now exists:
  - `docs/maintainers/archive/dated-plans/2026-04-04-miniapp-worker-owned-warm-continuity-qa-checklist.md`
- status remains Partial because broader backend-swap sign-off still requires stronger isolation, operator visibility, reconnect/tab-switch sign-off, and ugly-case regression coverage

Required decision:
Choose one explicit target and document it in code/docs:
- Option A: per-chat isolated warm worker/session
- Option B: checkpoint-only continuity is the intentional final design
- Option C: hybrid model with bounded warm worker lifetime outside the shared backend

Recommended direction:
- Prefer Option A or C if CLI-like session feel remains a real product goal.
- Do not move warm state back into the shared Flask/backend process.

Done when:
- the target model is explicitly chosen
- code matches that decision
- runtime/status surfaces the chosen model clearly
- tests prove the chosen model behaves as intended

Suggested files:
- `hermes_client.py`
- `hermes_client_agent_persistent.py`
- `job_runtime.py`
- `job_runtime_worker_launcher.py`
- `chat_worker_runner.py`
- `miniapp_config.py`
- docs under `docs/maintainers/plans/` and `docs/maintainers/runbooks/miniapp-worker-isolation-runbook.md`

---

### 2. Harden worker isolation from rlimit-only to stronger OS-level enforcement
Status: Partial
Priority: P0

Why this matters:
- rlimit enforcement is already a real improvement
- but stronger per-worker containment would make “one bad chat hurts only itself” much more trustworthy

Current state:
- RLIMIT_AS / RLIMIT_NPROC / RLIMIT_NOFILE are applied
- worker timeout and process-group cleanup exist
- parent can classify some worker limit failures

Remaining gap:
- no transient systemd scope / cgroup-backed per-worker isolation yet
- no stronger resource accounting boundary beyond subprocess + rlimit

Required outcome:
- move toward per-worker OS-enforced isolation envelope where practical
- if full cgroup/scope isolation is not feasible, explicitly document why and what residual risk remains

Done when:
- worker isolation boundary is as strong as the host/runtime model reasonably allows
- worker failure classification remains local and observable
- backend survives intentionally induced bad-worker cases

Suggested files:
- `job_runtime_worker_launcher.py`
- `chat_worker_subprocess.py`
- `app_factory.py`
- service/unit docs or wrapper scripts
- `docs/maintainers/runbooks/miniapp-worker-isolation-runbook.md`

---

### 3. Make transport/fallback attribution operator-grade
Status: Partial
Priority: P0

Why this matters:
- silent degradation destroys trust
- recent bugs showed direct-agent failure could quietly drop to CLI
- architecture is only “done” when path selection is understandable during incidents

Current state:
- transport transitions exist
- some fallback attribution exists
- direct-agent routing bug and CLI footer bug were fixed

Remaining gap:
- per-chat/per-job transport visibility is still not as easy as it should be during live debugging
- fallback reasons should be obvious without reconstructing them from scattered logs

Required outcome:
- for any running or failed chat/job, an operator can answer:
  - what path was selected?
  - did it fall back?
  - why?
  - was that expected?

Done when:
- runtime diagnostics or operator-debug surfaces show transport path and fallback reason clearly
- unexpected CLI fallback is obvious
- logs are sufficient to diagnose routing/auth/path issues quickly

Suggested files:
- `hermes_client.py`
- `routes_jobs_runtime.py`
- `routes_chat_stream.py`
- frontend/operator debug surfaces if needed

---

### 4. Complete reconnect / resume / tab-switch hardening
Status: Partial
Priority: P0

Latest live finding:
- overlapping multi-chat API behavior looks healthy in live sign-off testing
- browser reload/resume blocker was traced to delayed detached-worker job completion and then fixed
- latest snapshot: `docs/maintainers/archive/dated-plans/2026-04-04-miniapp-backend-swap-signoff-pass.md`

Why this matters:
- this is the highest-value user-facing stability area after basic containment
- many miniapp failures show up here before they show up as total crashes

Current state:
- a lot of resume/duplicate-runner hardening already landed
- stream contract mostly preserved
- several related bugs have already been addressed

Remaining gap:
- still needs explicit sign-off-level validation for:
  - reconnect while streaming
  - repeated resume calls
  - switching chats during active stream
  - one chat failure while another chat continues normally
  - stale resume/retry not mutating wrong active-chat state

Done when:
- reconnect/tab-switch flows are boring and predictable
- no cross-chat contamination
- no phantom duplicate runs
- no transient UX corruption during active stream lifecycle changes

Suggested files:
- `routes_chat_stream.py`
- `routes_chat_management.py`
- `static/stream_controller.js`
- `static/chat_history_helpers.js`
- `static/render_trace_helpers.js`
- related tests in `tests/`

---

### 5. Add one serious “bad day” regression/stress suite
Status: Todo
Priority: P1

Why this matters:
- robustness claims should be backed by ugly-case tests, not only happy-path targeted suites

Required scenarios:
- worker timeout
- worker nonzero exit
- open-files/task pressure simulation
- delegated subtree churn
- one chat fails while another survives
- repeated resume/reconnect during active job
- no runtime/thread leakage across repeated reload cycles

Done when:
- there is a repeatable suite or script set for these scenarios
- failures are local and attributable
- backend remains healthy under those repros

Suggested locations:
- `tests/test_fanout_storm_forensics.py`
- new runtime/soak/stress tests in `tests/`
- optionally `scripts/` for repro runners

---

## Strongly recommended before sign-off

### 6. Turn descendant telemetry into a compact incident snapshot
Status: Partial
Priority: P1

Goal:
- make live debugging much faster

Wanted snapshot fields:
- transport path selected
- transport transitions
- active child count / high-water
- descendant high-water
- limit breach classification
- worker terminal outcome
- cleanup outcome for descendants

Done when:
- a single diagnostic payload is enough to understand most incidents without deep log spelunking

---

### 7. Reconcile actual product goal for session feel vs safety tradeoff
Status: Todo
Priority: P1

Question to answer explicitly:
- is CLI parity defined as capability parity only?
- or is it also session-behavior parity, including warm continuity feel?

Why it matters:
- this determines whether checkpoint-only continuity is acceptable final architecture
- otherwise agents will keep making local optimizations without a shared finish line

Done when:
- docs define the accepted final behavior standard
- implementation and QA target that standard directly

---

## Nice to have after sign-off

### 8. Better operator-facing live transport/debug UI
Status: Optional
Priority: P2

Examples:
- per-chat transport badge in operator/debug mode
- worker/fallback reason inspector
- incident export bundle for bad chats

---

### 9. More explicit service-level operational runbook
Status: Optional
Priority: P2

Examples:
- restart guidance
- known-good diagnostic commands
- expected startup invariants
- triage tree for local chat failure vs backend-wide issue

---

## Recommended execution order

If picking up this work fresh, do it in this order:

1. Warm-session ownership decision and implementation
2. Stronger worker isolation boundary
3. Transport/fallback observability cleanup
4. Resume/reconnect/tab-switch QA hardening
5. Stress/regression suite for ugly-case containment
6. Final sign-off pass against the completion definition above

---

## Suggested sign-off checklist

Do not declare backend swap done until all are true:

- [ ] One chat can fail locally without backend-wide outage
- [ ] Current production-default transport path is isolated and expected
- [ ] Warm-session behavior choice is explicit and implemented
- [ ] Unexpected fallback is visible and attributable
- [ ] Reconnect/resume/tab-switch QA passes
- [ ] Stress/containment regression scenarios pass
- [ ] Isolation/incident diagnostics are good enough for future debugging
- [ ] Remaining tradeoffs are documented, not accidental

---

## Handoff note for future agents

If you are the next agent picking this up:
- start here
- then read the linked primary plan and implementation status doc
- update this checklist as items move from Todo -> Partial -> Done
- if you discover a new architectural blocker, add it here instead of leaving it only in chat history

This document should remain the easiest place to answer:
- what is left?
- what is required?
- what order should we do it in?
