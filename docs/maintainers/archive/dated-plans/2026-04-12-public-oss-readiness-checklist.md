# Hermes Mini App v4 public OSS readiness checklist

Status: in progress
Last updated: 2026-04-12

Goal
- Turn the repo from an operator-focused private project into a public-facing open-source project that a stranger can understand, run, test, and contribute to.

Current release recommendation
- Do not make the repository public yet.
- Finish the P0 items below first.

## P0: required before making the repo public

- [x] Create a tracked release-prep checklist.
- [x] Rewrite the README for public users instead of a single-machine operator workflow.
- [x] Add CONTRIBUTING.md.
- [x] Add SECURITY.md.
- [x] Add CODE_OF_CONDUCT.md.
- [x] Add LICENSE (MIT).
- [x] Add CI for Python and Node test suites.
- [x] Add explicit dev test dependencies and document how to install them.
- [x] Remove machine-specific runtime defaults from Hermes client bootstrap.
- [x] Fix the brittle failing metadata test so the suite can go green.
- [x] Run full validation again after the latest documentation/template pass.
- [x] Review git history for old secrets before public release.

## P1: strongly recommended in the same pass

- [x] Add a docs index explaining which docs are public-facing and which are internal historical notes.
- [x] Curate internal runbooks and planning artifacts into a clearly marked `docs/maintainers/` tree.
- [x] Add at least one deployment guide beyond local development.
- [x] Add issue and pull request templates.
- [x] Add an architecture diagram or a short architecture doc.

## P2: follow-up polish after public preview

- [ ] Continue decomposing very large frontend/runtime files to improve contributor onboarding.
- [ ] Add a containerized local-dev path if contributor demand justifies it.
- [ ] Expand public docs around production hardening and threat model.

## Files changed in this pass

- README.md
- CONTRIBUTING.md
- SECURITY.md
- CODE_OF_CONDUCT.md
- docs/README.md
- requirements.txt
- requirements-dev.txt
- .github/workflows/ci.yml
- .github/ISSUE_TEMPLATE/bug_report.md
- .github/ISSUE_TEMPLATE/feature_request.md
- .github/ISSUE_TEMPLATE/config.yml
- .github/pull_request_template.md
- LICENSE
- hermes_client.py
- docs/architecture.md
- docs/deployment.md
- tests/test_routes_meta.py

## Validation plan for this pass

- Python syntax check on touched Python files
- Targeted pytest for the previously failing metadata test and Hermes client tests affected by runtime default changes
- Full pytest suite
- Full Node test suite

## Latest validation results

- `.venv/bin/python -m pytest -q`
  - result: `519 passed`
- `node --test tests/*.mjs`
  - result: `493 passed`

## Maintainer-doc curation outcome

- Historical runbooks, plans, refactor logs, and archives are now grouped under `docs/maintainers/`.
- Public-facing docs remain at the top of `docs/` so first-time users do not have to wade through operator notes.
- Maintainer docs are still intentionally tracked for repository archaeology, but they are now clearly labeled as non-canonical for onboarding.

## History scrub summary

- High-signal git-history secret scan completed for common token/private-key patterns.
- Result: no matches found for Telegram bot token, OpenAI-style key, GitHub PAT, AWS access key, Slack token, or private-key block patterns in git history.
- Important follow-up: the current tracked docs tree still contains many historical maintainer references to local filesystem paths, worktrees, internal domains, and service-manager commands. Those are not credential leaks, but they should still be curated before a polished public release.
