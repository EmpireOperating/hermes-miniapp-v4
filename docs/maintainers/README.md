# Maintainer docs

This directory contains Mini App maintainer-only context that is useful for ongoing development, debugging, and historical review, but is not required for first-time users.

Contents:
- `runbooks/`: operator/debugging procedures and incident-response notes
- `plans/`: active or near-active planning/spec documents that still guide current work
- `history/`: long-running refactor and backlog documents
- `archive/`: preserved historical snapshots, completed dated plans, and repository archaeology

These files may include machine-specific paths, past deployment assumptions, worktree references, and historical validation commands. Treat them as Mini App maintainer context, not as the canonical public setup path.

If a document belongs to a different project, it should be removed from this repository rather than filed here.

For public onboarding, start with:
- `../../README.md`
- `../architecture.md`
- `../deployment.md`
- `../../CONTRIBUTING.md`
- `../../SECURITY.md`
