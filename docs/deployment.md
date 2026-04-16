# Deployment guide

This document describes a minimal production-oriented deployment shape for Hermes Mini App v4.

## Recommended baseline topology

- Telegram bot configured to open the Mini App URL
- reverse proxy or tunnel terminating HTTPS for the public app URL
- Flask app running Hermes Mini App v4
- Hermes backend reachable through one of:
  - `HERMES_STREAM_URL`
  - `HERMES_API_URL`
  - local Hermes Agent runtime / CLI
- persistent storage location for the Mini App SQLite database and related state

## Required inputs

At minimum, configure:
- `TELEGRAM_BOT_TOKEN`, or set `MINI_APP_USE_HERMES_TELEGRAM_BOT_TOKEN=1` to reuse the Telegram bot token already stored in `~/.hermes/.env`
- `MINI_APP_URL`
- one Hermes execution path:
  - `HERMES_STREAM_URL`, or
  - `HERMES_API_URL`, or
  - local agent runtime variables

## Platform support notes

- Linux is the primary deployment target today.
- macOS can work for local bootstrap and validation, but production deployment is more commonly done on Linux.
- Windows operators should use WSL2 for Mini App setup and runtime. Hermes Agent does not support a native Windows runtime path.

## Why you need a domain / DNS

Telegram Mini Apps expect an HTTPS URL. In practice, that means most deployments need a domain or subdomain you control so `MINI_APP_URL` can point at a real HTTPS origin.

This is often the biggest setup friction for new operators, so the important thing to know is:
- the domain name itself is usually not important
- it does not need to be a meaningful public brand name
- if you do not already have a domain to use, the cheapest domain you can buy and control is usually good enough
- a subdomain you already control is also fine

What actually matters is:
- you control the DNS for the domain/subdomain
- it resolves to your reverse proxy or tunnel
- the site presents valid HTTPS
- `MINI_APP_URL` exactly matches the URL your Telegram bot is configured to open

Even if the Mini App is mainly for your own use, you still typically need this DNS + HTTPS layer because Telegram launches the web app from a URL, not from a local filesystem path.

## Suggested production hardening

Review and set these based on your deployment:
- `MINI_APP_ALLOWED_ORIGINS`
- `MINI_APP_ENFORCE_ORIGIN_CHECK=1`
- `MINI_APP_FORCE_SECURE_COOKIES=1`
- `MINI_APP_TRUST_PROXY_HEADERS=1` only if you actually trust the proxy in front of the app
- `MINI_APP_ENABLE_HSTS=1` only when the site is always served over HTTPS
- `MINI_APP_RATE_LIMIT_*`
- `MINI_APP_FILE_PREVIEW_ALLOWED_ROOTS`
- `MINI_APP_FILE_PREVIEW_DENY_*`

Keep any dev-auth bypass variables unset in production.

## Reverse proxy expectations

If you deploy behind Nginx, Caddy, Cloudflare Tunnel, or another proxy/tunnel:
- terminate HTTPS before user traffic reaches the Flask app
- preserve host/scheme headers only when `MINI_APP_TRUST_PROXY_HEADERS` is intentionally enabled
- make sure streaming endpoints are not buffered aggressively
- keep idle/read timeouts long enough for streaming responses

## Local-agent deployment notes

If Hermes runs on the same machine as the Mini App, set these explicitly if the defaults do not match your environment:
- `MINI_APP_AGENT_HOME`
- `MINI_APP_AGENT_HERMES_HOME`
- `MINI_APP_AGENT_WORKDIR`
- `MINI_APP_AGENT_VENV`
- `MINI_APP_AGENT_PYTHON`

Portable defaults are derived from `HOME` and `HERMES_HOME`, but public deployments should prefer explicit configuration.

## Validation checklist after deploy

1. Run `scripts/setup.sh telegram` from the deployed repo or equivalent environment.
2. Confirm the finalize step reports the expected menu button label (`Open Hermes` by default).
3. Open the Mini App inside Telegram.
4. Verify auth/bootstrap succeeds.
5. Send a prompt and confirm streaming updates appear progressively.
6. Reload/reopen and confirm the active chat restores correctly.
7. Confirm rate limiting, origin checks, and secure cookies behave as expected.
8. If file preview is enabled, verify access is restricted to intended roots.
9. Review backend logs to ensure no secrets are being logged.

## Minimal operator path

For the simplest real-user rollout, aim for this exact sequence:

1. Set DNS / HTTPS for the final Mini App URL.
2. Paste `TELEGRAM_BOT_TOKEN` into `.env`, or set `MINI_APP_USE_HERMES_TELEGRAM_BOT_TOKEN=1` if Hermes Agent on that machine already has the right Telegram bot token.
3. Optionally set `MINI_APP_MENU_BUTTON_TEXT` if you want something other than `Open Hermes`.
4. Run `scripts/setup.sh telegram`.
5. Open the bot in Telegram and confirm `Open Hermes` launches the Mini App.

## Safe rollout sequence

For the lowest-risk real-world rollout:

1. Stand up a separate test bot and test HTTPS subdomain first.
2. Confirm local startup with `.venv/bin/python server.py` and `curl http://127.0.0.1:8080/health`.
3. Point the public test subdomain at your service or tunnel.
4. Paste the test bot token into `.env` or opt into reusing the Hermes-stored token, then run `scripts/setup.sh telegram`.
5. Open the test bot in Telegram, tap `Open Hermes`, and send a real prompt.
6. Rotate any bot token that was pasted into chat or other shared logs during testing.
7. Repeat the same flow for the production bot/domain once the test pass is clean.

## What this guide does not assume

This repository does not require a specific hosting provider, proxy, or process manager. The important part is correctly handling HTTPS, Telegram auth, streaming, and Hermes connectivity.
