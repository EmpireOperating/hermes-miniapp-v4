# Security

## Reporting a vulnerability

Please do not report security vulnerabilities in public GitHub issues.

Use one of these private channels instead:
- GitHub Security Advisories / private vulnerability reporting for this repository, if enabled
- direct private contact with the maintainers through GitHub

When reporting, include:
- affected version or commit
- reproduction steps
- impact assessment
- any logs, screenshots, or traces that help reproduce the problem

We will try to acknowledge reports promptly and coordinate a fix before public disclosure when appropriate.

## Deployment cautions

This project can be run in development-friendly modes that are not appropriate for production. Before deploying publicly, review these areas carefully:

- Telegram auth configuration
- origin allowlists and origin enforcement
- proxy header trust
- secure cookies and TLS termination
- HSTS
- file preview allowed roots and denylist overrides
- operator/debug endpoints and tokens
- dev auth bypass settings
- rate limiting and abuse controls

## Sensitive defaults

Before a public or internet-facing deployment, verify that:
- dev auth bypass is disabled
- secrets are provided via environment or secret management, not committed files
- preview roots are restricted to the minimum needed paths
- reverse proxy and TLS settings match your actual deployment
- debug/operator tokens are rotated and stored securely

## Scope

This repository contains both public-facing docs and some maintainer-oriented historical notes. Treat old runbooks and planning docs as context, not authoritative hardening guidance, unless they are explicitly referenced by the current README.
