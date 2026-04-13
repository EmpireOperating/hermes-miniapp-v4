# Docs index

This repository contains a small set of public-facing docs plus a separate maintainer/history area.

The docs tree is intended to stay scoped to Hermes Mini App. Unrelated project docs should not live here.

## Recommended reading order for new users

1. `../README.md`
2. `setup.md`
3. `../CONTRIBUTING.md`
4. `../SECURITY.md`

## Public-facing docs

- `setup.md`
  - canonical bootstrap, config, doctor, and platform-support walkthrough
- `architecture.md`
  - high-level component and request-flow overview
- `deployment.md`
  - deployment and production-hardening guidance

Public-facing product notes that are currently described in `../README.md` include:
- desktop keyboard-first navigation
- a built-in keyboard shortcuts help surface for onboarding
- a `?` desktop shortcut to open shortcuts help

## Maintainer-oriented docs

These files are useful for Mini App implementation history, incident response, and repository archaeology, but they are not the primary public onboarding path:

- `maintainers/README.md`
  - index for maintainer-only docs and historical notes
- `maintainers/history/`
  - refactor plans, backlog history, and execution logs
- `maintainers/runbooks/`
  - operator/debugging procedures and incident runbooks
- `maintainers/plans/`
  - active or near-active planning/spec documents that still guide current work
- `maintainers/archive/`
  - preserved historical snapshots, archived dated plans, and repository archaeology

## Important note

Historical maintainer docs may include:
- development-time assumptions
- old worktree or service references
- validation notes tied to a particular machine or point in time
- internal hostnames, local filesystem paths, or service-manager commands that should be treated as historical maintainer context

Treat them as maintainer context unless the current top-level README explicitly points you to them for an active setup step.
