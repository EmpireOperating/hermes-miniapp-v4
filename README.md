# Hermes Mini App v4

Hermes Mini App v4 is a Telegram Mini App frontend for Hermes Agent.

It provides a chat-oriented web UI inside Telegram while keeping Hermes execution on the backend. The app supports multi-chat workflows, streaming replies, persisted chat history, unread state, and operator-focused diagnostics.

## Highlights

- Telegram Mini App authentication flow
- Multi-chat tabs with rename, clear, archive/remove, and pinned chat support
- Streaming assistant responses with reconnect/resume behavior
- Desktop keyboard shortcuts with an in-app shortcuts help surface for onboarding
- Persisted chat and job state in SQLite
- Queue-backed background execution so work can continue after UI disconnects
- File preview controls with allow-root and denylist protections
- Rate limiting, origin checks, CSP, and secure-cookie support
- Extensive Python and Node-based test coverage

## Architecture

Request path:
- Telegram opens the Mini App
- the frontend sends Telegram `initData` to the Flask backend
- the backend verifies auth and manages chat/job state
- the backend routes Hermes requests through one of these paths:
  - `HERMES_STREAM_URL` when available
  - `HERMES_API_URL` when available
  - direct local Hermes Agent runtime when enabled
  - local Hermes CLI fallback

Primary components:
- `server.py` / `app_factory.py`: Flask app bootstrap and shared wiring
- `routes_*.py`: auth, chat, streaming, and runtime endpoints
- `store*.py`: SQLite-backed chat, auth, and job persistence
- `hermes_client.py`: routing and fallback policy for Hermes execution
- `static/*.js`: Telegram Mini App frontend controllers and helpers
- `tests/`: Python backend tests and Node-based frontend/helper tests

## Who this repo is for

This repository is for people who want to:
- run a Telegram Mini App frontend for Hermes Agent
- study or adapt the Telegram + Flask + Hermes integration
- contribute to the Mini App UI, backend, or runtime behavior

You will get the best experience if you already have a working Hermes Agent setup or an HTTP endpoint that exposes Hermes-compatible chat behavior.

## Requirements

- Python 3.11+
- Node.js 20+
- Telegram bot token for Mini App auth flow
- A Hermes backend path, one of:
  - `HERMES_STREAM_URL`
  - `HERMES_API_URL`
  - local Hermes Agent installation / CLI

No npm install step is required for the frontend tests in this repository; they use the built-in Node test runner.

## Platform support

- Linux: primary supported path today
- macOS: expected to work for bootstrap, tests, and core runtime; verify with the setup doctor
- Windows: bootstrap, config, and HTTP-backed Hermes mode are the best-supported paths today; some local-runtime features still assume Unix behavior

If you want the smoothest first setup, start with:
- Python 3.11+
- Node 20+
- Bash/Zsh on Linux/macOS: `scripts/setup.sh`
- PowerShell on Windows: `./scripts/setup.ps1`
- HTTP-backed Hermes mode (`HERMES_STREAM_URL` or `HERMES_API_URL`) unless you already have a local Hermes install you want to wire in

## Desktop usability and shortcut discovery

The desktop UI includes keyboard-first navigation and a built-in shortcuts help surface intended to make the open-source experience more discoverable for new users.

- A visible shortcuts entry point is wired into the app shell on desktop
- Press `?` on desktop to open the keyboard shortcuts help
- Shortcut behavior is covered by dedicated Node tests in `tests/keyboard_shortcuts_helpers.test.mjs`

This is intentionally part of the public product surface, not stray internal-only feature work.

## Quickstart

Recommended setup flow:

1. Run the bootstrap command for your shell.

Linux/macOS (Bash/Zsh):

```bash
scripts/setup.sh
```

Windows PowerShell:

```powershell
./scripts/setup.ps1
```

Portable Python equivalent:

```bash
python scripts/setup_bootstrap.py --write-env-if-missing
```

The bootstrap command sets up `.venv`, installs dependencies, creates `.env` when needed, and prompts for the key first-run values on an interactive terminal.

2. Confirm the minimum required values in `.env`.

If you skip the prompts or rerun later, make sure `.env` contains:
- `TELEGRAM_BOT_TOKEN`
- `MINI_APP_URL`
- one Hermes execution path:
  - `HERMES_STREAM_URL`, or
  - `HERMES_API_URL`, or
  - local agent/CLI configuration

3. Run the setup doctor.

Linux/macOS (Bash/Zsh):

```bash
scripts/setup.sh doctor
```

Windows PowerShell:

```powershell
./scripts/setup.ps1 doctor
```

Portable Python equivalent:

```bash
python scripts/setup_doctor.py
```

4. Start the server.

```bash
python server.py
```

5. Open the Mini App from your Telegram bot and verify you can authenticate and send a message.

Important: `MINI_APP_URL` must be a real HTTPS URL on a domain or subdomain you control. The name itself does not matter much; if you do not already have one, the cheapest domain you can buy and control is usually fine.

For a fuller walkthrough, platform notes, and troubleshooting, see `docs/setup.md` and `docs/setup-troubleshooting.md`.

## Local Hermes Agent runtime configuration

If you want the Mini App to use a local Hermes Agent installation instead of an HTTP endpoint, configure these environment variables as needed:

- `MINI_APP_AGENT_HOME`
- `MINI_APP_AGENT_HERMES_HOME`
- `MINI_APP_AGENT_WORKDIR`
- `MINI_APP_AGENT_VENV`
- `MINI_APP_AGENT_PYTHON`

Portable defaults are derived from the current environment when these are unset:
- `MINI_APP_AGENT_HOME` defaults to `HOME`
- `MINI_APP_AGENT_HERMES_HOME` defaults to `HERMES_HOME` or `HOME/.hermes`
- `MINI_APP_AGENT_WORKDIR` defaults to `HERMES_HOME/hermes-agent`
- `MINI_APP_AGENT_VENV` defaults to `MINI_APP_AGENT_WORKDIR/venv`
- `MINI_APP_AGENT_PYTHON` defaults to the platform-appropriate virtualenv interpreter:
  - POSIX: `MINI_APP_AGENT_VENV/bin/python`
  - Windows: `MINI_APP_AGENT_VENV/Scripts/python.exe`

If your Hermes Agent lives elsewhere, set the variables explicitly.

## Testing

Run the Python suite:

```bash
.venv/bin/python -m pytest -q
```

On Windows, use:

```powershell
.venv\Scripts\python.exe -m pytest -q
```

Run the Node suite:

```bash
node --test tests/*.mjs
```

## Security and production hardening

For production deployments, review and configure these settings carefully:

- `MINI_APP_ALLOWED_ORIGINS`
- `MINI_APP_ENFORCE_ORIGIN_CHECK`
- `MINI_APP_FORCE_SECURE_COOKIES`
- `MINI_APP_TRUST_PROXY_HEADERS`
- `MINI_APP_ENABLE_HSTS`
- `MINI_APP_RATE_LIMIT_*`
- `MINI_APP_FILE_PREVIEW_ALLOWED_ROOTS`
- `MINI_APP_FILE_PREVIEW_DENY_*`

Also make sure dev-only auth bypass settings stay disabled in production.

See `SECURITY.md` for reporting guidance.

## Docs map

- `README.md`: public overview and local setup
- `LICENSE`: MIT license for reuse and contribution
- `CONTRIBUTING.md`: contributor workflow
- `SECURITY.md`: vulnerability reporting and deployment cautions
- `docs/setup.md`: canonical setup, doctor, and platform-support walkthrough
- `docs/architecture.md`: system structure and request flow
- `docs/deployment.md`: deployment and hardening guidance
- `docs/README.md`: docs index and explanation of public vs maintainer-oriented docs
- `docs/maintainers/README.md`: maintainer-only history, runbooks, plans, and archives

Note: files under `docs/maintainers/` are preserved for maintainers and repository archaeology. They may include machine-specific paths, old worktree references, and point-in-time operational notes; the top-level README and public docs are the canonical onboarding path.

## Project status

This repository is under active development. Interfaces, runtime behavior, and deployment guidance may still evolve as the Mini App moves from private operator use toward a cleaner public release.
