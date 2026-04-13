# Hermes Authority v1 Implementation Plan

This plan converts the earlier "Agent Vault" idea into Hermes Authority: a local-first capability broker for Hermes.

## Outcome

Ship a narrow v1 that proves Hermes can perform real actions via bounded capabilities instead of broad raw secret access.

## Phase 0: Reframe and rename

Goal: align the repo and language with the real product.

Tasks:
- Rename product references from Agent Vault / vault-v4 to Hermes Authority where appropriate
- Standardize terminology:
  - secret -> root secret
  - lease -> capability
  - exchange token -> runtime token or capability token depending on use
  - provider integration -> adapter
- Mark human-password-manager language as out of scope
- Add design doc and implementation plan to canonical docs

Deliverables:
- Naming map
- Updated README / docs
- Terminology glossary

## Phase 1: Establish the minimum domain model

Goal: build the smallest coherent authority model.

Required entities:
- Runtime
- RootSecret
- Capability
- PolicyRule
- AuditEvent
- AdapterExecution

Key requirements:
- Runtime identity is first-class
- Capability issuance has TTL and optional use count
- Capabilities are revocable
- Audit never stores plaintext secret values

Questions to settle early:
- Signed local tokens vs opaque DB-backed tokens
- Whether remaining_uses is required in v1 or phase 1.5
- Exact resource naming format

Recommendation:
- Use opaque capability ids with DB lookup for v1 simplicity
- Keep resource strings simple and namespaced:
  - repo:owner/name
  - email-account:primary
  - provider:openai

## Phase 2: Runtime identity

Goal: make every Hermes caller identifiable.

Implement:
- Runtime registration/auth endpoint
- Local signed runtime tokens for trusted Hermes processes
- Runtime metadata:
  - runtime_id
  - runtime_type
  - instance_id
  - parent_runtime_id optional
  - issued_at / expires_at

Initial runtime types:
- main
- miniapp_worker
- cron
- subagent

Policy examples:
- subagents cannot read raw root secrets
- miniapp workers may request only approved low-risk capabilities

## Phase 3: Capability issuance service

Goal: replace broad lease semantics with action-scoped capabilities.

Implement endpoint:
- POST /v1/capabilities/issue

Inputs:
- runtime token
- action
- resource
- optional requested constraints
- request context / correlation id

Outputs:
- allow/deny
- capability id/token
- expires_at
- normalized constraints
- matched policy id

V1 constraints to support:
- ttl_seconds
- max_uses
- repo allowlist / exact repo
- email account binding
- budget_usd for model-provider actions

Also implement:
- POST /v1/capabilities/revoke
- GET /v1/capabilities/:id

## Phase 4: Audit as a first-class feature

Goal: make the system explainable and reviewable from day one.

Audit events to emit:
- runtime.authenticated
- capability.issue.requested
- capability.issue.allowed
- capability.issue.denied
- capability.used
- capability.revoked
- adapter.execution.started
- adapter.execution.succeeded
- adapter.execution.failed
- root_secret.created / rotated / disabled
- raw_secret.read.requested / allowed / denied

Minimum fields:
- event_id
- occurred_at
- event_type
- runtime_id
- action
- resource
- capability_id optional
- result
- reason / matched_policy
- correlation_id
- metadata_json

Build a simple query interface first, not a fancy UI.

## Phase 5: Root secret custody

Goal: keep long-lived secrets local and encrypted, with controlled use.

Implement:
- Create/store root secrets
- Encryption at rest using existing good crypto foundation if still suitable
- Metadata fields:
  - provider
  - secret_type
  - created_at
  - last_rotated_at
  - labels
  - enabled flag

Strict rule:
- Normal adapter paths should not return root secret plaintext

Transitional-only path:
- POST /v1/raw-secret/read
- Disabled by default
- Allowed only for explicit migration/bootstrap cases
- Fully audited

## Phase 6: Provider adapters (the real value)

Goal: prove usefulness with a tiny set of real actions.

### Adapter 1: GitHub create issue
Action:
- github.create_issue

Inputs:
- capability
- repo
- title
- body
- labels optional

Rules:
- capability must match repo constraints
- adapter uses stored GitHub root secret internally
- do not expose PAT back to caller

### Adapter 2: Email send
Action:
- email.send

Inputs:
- capability
- from_account
- to
- subject
- body

Rules:
- account binding enforced
- destination constraints can be added later
- adapter uses stored mail/API credentials internally

### Adapter 3: LLM provider bounded call
Action:
- llm.responses.create

Inputs:
- capability
- provider
- model
- request payload

Rules:
- provider binding enforced
- optional budget accounting scaffolded
- adapter uses provider key internally

Success criterion:
- Hermes can do all three without a normal workflow reading raw root secrets

## Phase 7: Hermes integration

Goal: make Hermes actually use Authority in real workflows.

Integration order:
1. Main Hermes runtime requests capabilities for adapter actions
2. One subagent path requests narrower capabilities
3. Miniapp worker path adopts runtime identity and capability requests

Required call flow:
- Hermes determines needed action
- Hermes asks Authority for capability
- Hermes calls action endpoint with capability
- Authority performs action and returns result

Avoid:
- dumping secret ids or raw secrets into normal prompts
- letting subagents inherit main runtime authority by default

## Phase 8: Approval and break-glass policy

Goal: distinguish normal autonomy from high-risk actions.

V1.1 or late-v1 additions:
- Approval-required policy effect
- Break-glass mode with explicit operator action
- High-risk action classes:
  - payments
  - destructive inbox actions
  - wide infra mutation
  - raw secret reveal

For now, keep approval plumbing minimal if needed to unblock shipping.

## Phase 9: Migration path from current project

Preserve from the current codebase if solid:
- Encryption primitives
- Audit discipline
- Existing policy parsing ideas
- Localhost service deployment patterns

De-emphasize or retire:
- Human-facing local CLI vault split-brain behavior
- Generic secret-read API as the center of the system
- Product framing as 1Password-for-personal-use

Migration rule:
- Existing lease constructs can map to capabilities where possible
- Existing secret objects become root secrets
- Existing exchange auth becomes runtime auth if the semantics fit

## Suggested repo layout

Example only; adapt to actual repo conventions.

- authority/
  - runtime.py
  - capabilities.py
  - policy.py
  - audit.py
  - secrets.py
  - adapters/
    - github.py
    - email.py
    - llm_provider.py
- docs/
  - HERMES_AUTHORITY_V1.md
  - plans/
- tests/
  - authority/
  - adapters/
  - integration/

## Testing strategy

Must-have tests:
- Runtime auth success/failure
- Capability issue allow/deny
- Capability expiry and revocation
- Capability cannot be used outside resource scope
- Adapter performs action without returning raw root secret
- Audit contains decision metadata but not plaintext secrets
- Subagent denied for disallowed action

One important integration test:
- Hermes main -> request capability -> GitHub issue adapter -> success -> audit visible

## What to cut ruthlessly

Cut from v1:
- Human UI work
- Password-manager features
- Cloud sync
- Team/org semantics
- Wallet/payment execution
- Giant policy DSL
- Over-generic plugin abstractions before 3 real adapters exist

## Definition of done for v1

Hermes Authority v1 is done when:
- A named Hermes runtime can authenticate
- Policy can allow/deny an action request
- A capability can be issued, used, and revoked
- GitHub issue creation works through an adapter
- Email sending works through an adapter
- LLM provider access works through an adapter
- Audit can explain what happened
- Raw secret reveal is exceptional, off by default, and audited

## Decision guidance

If a design choice comes up, prefer:
- simpler implementation
- narrower scope
- stronger action mediation
- less raw secret exposure
- clearer auditability

over:
- generic elegance
- broad product ambition
- human-facing convenience features

## North star

The product is successful when Hermes can safely do meaningful work for the user through bounded capabilities, without the user manually handling credentials and without Hermes routinely receiving unlimited long-lived secrets.
