# Hermes Authority v1

Purpose: a local-first capability broker for Hermes.

Hermes Authority is not a human password manager. It is a private control plane that lets Hermes act on the user's behalf with bounded authority, auditability, revocation, and minimal raw secret exposure.

## Product goal

Enable Hermes to perform meaningful actions safely without holding unlimited long-lived credentials in normal runtime memory.

Primary pattern:
- Prefer action mediation over secret disclosure
- Prefer short-lived capabilities over ambient credentials
- Prefer explicit runtime identity over anonymous local access
- Prefer auditable policy decisions over implicit trust

## Non-goals

Not in v1:
- Human-facing password manager UX
- Browser autofill
- Passkeys / consumer login vault features
- Team / enterprise multi-tenant product scope
- Generic cloud-hosted Vault competitor

## Core principles

1. Actions over secrets
   - Better: github.create_issue, email.send, cloudflare.dns.write
   - Worse: give Hermes a PAT / SMTP password / API key directly

2. Local-first root custody
   - Long-lived root secrets are stored locally, encrypted at rest
   - Backup/export/recovery are explicit operator workflows

3. Every Hermes actor has an identity
   - Main agent
   - Miniapp worker
   - Cron job
   - Subagent
   - Future remote runner

4. Capabilities are bounded
   - Scope
   - TTL
   - Optional use-count limit
   - Optional budget / destination / repo / provider constraints

5. Everything important is auditable
   - Requester identity
   - Requested action
   - Decision and matched policy
   - Adapter execution result
   - Request/correlation ids

## Trust model

Hermes Authority assumes a mostly trusted local host, but aims to reduce blast radius between Hermes runtimes.

Threats reduced:
- Secret sprawl in env/config files
- Subagents inheriting unnecessary authority
- Unbounded long-lived credentials in normal agent flows
- Poor visibility into what used which credential

Threats not fully solved in v1:
- Fully hostile host compromise
- Hardware-backed enclave assurances
- Strong remote attestation
- Consumer-password-manager sync/recovery ergonomics

## Architecture

### 1. Root secret custody
Stores long-lived roots of authority:
- API keys
- OAuth refresh tokens
- SSH keys
- SMTP/API credentials
- Wallet signing roots later, not v1

Properties:
- Encrypted at rest
- Metadata includes type, provider, created_at, rotation hints, labels
- Raw reveal is exceptional and tightly controlled

### 2. Runtime identity
Every caller must authenticate as a named Hermes runtime.

Example runtime ids:
- hermes.main
- hermes.miniapp.worker
- hermes.cron.digest
- hermes.subagent.code-review

Runtime identity fields:
- runtime_id
- runtime_type
- host / instance id
- optional parent runtime
- issued_at / expires_at

V1 can use local signed runtime tokens. Later versions can add stronger attestation.

### 3. Capabilities
Capabilities replace the old broad "lease" framing.

Capability fields:
- capability_id
- subject_runtime
- action
- resource
- constraints
- issued_at
- expires_at
- remaining_uses
- revocable
- parent_request_id

Examples:
- action=email.send resource=account:primary constraints={to_domain_allowlist:[...], max_messages:1}
- action=github.create_issue resource=repo:EmpireOperating/hermes-agent constraints={labels_allowlist:[bug,feat]}
- action=llm.responses.create resource=provider:openai constraints={budget_usd:3, ttl_minutes:20}

### 4. Policy engine
Policy decides whether a runtime can obtain or use a capability.

V1 policy format should stay small and boring.

Rule dimensions:
- runtime_id or runtime_type
- action
- resource prefix / exact match
- optional constraints
- effect: allow / deny
- optional approval requirement

Examples:
- hermes.subagent.* may create GitHub issues only in approved repos
- miniapp workers may send email from notifications@ only
- no subagent may request raw root secret reveal
- payments over threshold require explicit approval

### 5. Provider adapters
Adapters create actual usefulness.

V1 adapters:
- GitHub: create issue
- Email: send message
- LLM provider: create response / bounded provider call

Adapter contract:
- Validate capability against requested action
- Use root secret internally
- Avoid returning raw root secret when possible
- Emit audit events

### 6. Audit ledger
Audit events are append-only logical records.

Event examples:
- runtime.authenticated
- capability.issued
- capability.denied
- adapter.github.create_issue.success
- adapter.email.send.error
- root_secret.rotated
- raw_secret.reveal.denied

Audit records should exclude plaintext secret material.

## API surface (v1)

Suggested internal API shape:
- POST /v1/runtime/auth
- POST /v1/capabilities/issue
- POST /v1/capabilities/revoke
- GET  /v1/capabilities/:id
- POST /v1/actions/github/create-issue
- POST /v1/actions/email/send
- POST /v1/actions/llm/responses-create
- GET  /v1/audit/events

Transitional-only endpoints:
- POST /v1/raw-secret/read
  - disabled by default
  - only for migration/bootstrap

## Data model (v1)

Core tables / collections:
- runtimes
- root_secrets
- capabilities
- policy_rules
- audit_events
- adapter_executions
- approvals (optional, can be phase 2)

## Hermes integration goals

Hermes should not think in terms of secret ids first. Hermes should think in terms of actions.

Desired call pattern:
1. Hermes decides it needs an action
2. Hermes requests a capability for that action
3. Hermes receives approval/denial + bounded token
4. Hermes calls the adapter action endpoint
5. Authority executes and logs result

## V1 success criteria

Hermes Authority v1 is successful if:
- Hermes main runtime can send an email without seeing the SMTP/API root secret
- A subagent can create a GitHub issue in an approved repo with bounded authority
- LLM provider credentials can be used through bounded capability issuance
- Audit can answer who did what and why
- Raw secret reveal is not part of normal workflows

## What to defer

Defer until after v1:
- Wallet/payment actions
- Browser/session brokerage
- Generic plugin platform
- Multi-user/team support
- Remote sync/cloud control plane
- Fancy policy DSL

## Naming guidance

Use terms that reinforce the right product:
- Project: Hermes Authority
- Secret store objects: root secrets
- Temporary access: capabilities
- Actual work executors: adapters
- Decision layer: policy engine
- Human override: approval / break-glass

Avoid re-centering around "vault" language that suggests storage is the main product.

## Summary

Hermes Authority is useful if it becomes the layer that lets Hermes safely do real work.

It is not primarily a storage product.
It is a power-management system for Hermes autonomy.
