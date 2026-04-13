# Setup guide

This guide is the canonical setup path for Hermes Mini App v4.

If you only read one setup document, read this one.

If the setup doctor reports a failure or warning you do not understand, go straight to `setup-troubleshooting.md`.

## Recommended path

Use this path unless you already know you want something else:
- Python 3.11+
- Node.js 20+
- Linux/macOS (Bash/Zsh): `scripts/setup.sh` then `scripts/setup.sh doctor`
- Windows PowerShell: `./scripts/setup.ps1` then `./scripts/setup.ps1 doctor`
- Portable Python fallback: `python scripts/setup_bootstrap.py --write-env-if-missing` then `python scripts/setup_doctor.py`
- HTTP-backed Hermes mode (`HERMES_STREAM_URL` or `HERMES_API_URL`) unless you already have a local Hermes install you want to wire in

## Platform support

- Linux
  - primary supported path today
- macOS
  - expected to work for bootstrap, tests, and core runtime
  - run the setup doctor to verify your environment
- Windows
  - bootstrap, config, tests, and HTTP-backed Hermes mode are the best-supported paths today
  - local warm attach is currently disabled because it depends on AF_UNIX unix-domain sockets; other local-runtime details still skew Unix-first

That means Windows users should prefer HTTP-backed Hermes mode for now. If you try the local-runtime-heavy path on Windows, the app should now degrade cleanly instead of failing with a cryptic socket error.

## Setup flow in two phases

### Phase A: local bootstrap and validation

1. Run the bootstrap command for your shell:

Linux/macOS (Bash/Zsh):

```bash
scripts/setup.sh
```

Windows PowerShell:

```powershell
./scripts/setup.ps1
```

Portable Python fallback:

```bash
python scripts/setup_bootstrap.py --write-env-if-missing
```

On an interactive terminal, the bootstrap now prompts for the most important first-run values and writes them into `.env` for you:
- `TELEGRAM_BOT_TOKEN`
- `MINI_APP_URL`
- your preferred Hermes backend mode

The bootstrap now explains the backend tradeoffs before asking you to choose, and it gives a platform-aware recommendation when no backend is configured yet:
- `HERMES_STREAM_URL`
  - best live streaming UX if you already have a streaming Hermes endpoint
  - recommended by default on Unix-like systems when you are starting fresh
- `HERMES_API_URL`
  - simplest HTTP-backed setup and usually the easiest first-time path, especially on Windows
  - recommended by default on Windows when you are starting fresh
- local Hermes CLI/runtime
  - useful when Hermes is installed on the same machine, but more machine-specific than HTTP-backed mode
  - recommended only when you already know you want same-machine execution

If you are automating setup, use `--non-interactive` and fill `.env` another way.

2. Confirm `.env` has the minimum required values:
- `TELEGRAM_BOT_TOKEN`
- `MINI_APP_URL`
- one Hermes execution path:
  - `HERMES_STREAM_URL`, or
  - `HERMES_API_URL`, or
  - local agent/CLI configuration

3. Run the doctor:

Linux/macOS (Bash/Zsh):

```bash
scripts/setup.sh doctor
```

Windows PowerShell:

```powershell
./scripts/setup.ps1 doctor
```

Portable Python fallback:

```bash
python scripts/setup_doctor.py
```

4. Start the app:

```bash
python server.py
```

At this point you have validated the code, dependencies, and basic configuration.

### Phase B: Telegram-facing URL, DNS, and HTTPS

To use the Mini App in Telegram, `MINI_APP_URL` must be a real HTTPS URL.

This is usually the biggest setup friction, so the important thing to know is:
- the domain name itself does not matter much
- it does not need to be a public brand domain
- any domain or subdomain you control is fine
- if you do not already have one, the cheapest domain you can buy and control is usually good enough

What matters is:
- you control the domain or subdomain
- DNS points it at your reverse proxy or tunnel
- the site serves valid HTTPS
- the value in `MINI_APP_URL` exactly matches the URL your Telegram bot opens

Even if the Mini App is mainly for your own use, Telegram still expects a real HTTPS origin.

## What the bootstrap command does

Human-friendly wrappers:
- Linux/macOS: `scripts/setup.sh`
- Windows PowerShell: `./scripts/setup.ps1`

Portable Python implementation:
- `python scripts/setup_bootstrap.py --write-env-if-missing`

It:
- checks that Python 3.11+ is being used
- checks that Node.js 20+ is available unless you pass `--skip-node-check`
- creates `.venv` if needed
- installs `requirements.txt` and `requirements-dev.txt`
- creates `.env` from `.env.example` when needed
- prompts for key `.env` values on an interactive terminal unless disabled
- prints clear next steps

Flags:
- `--write-env-if-missing`
  - create `.env` from `.env.example` if `.env` does not exist
- `--skip-node-check`
  - skip the Node version check
- `--interactive`
  - force interactive prompts even if terminal detection would skip them
- `--non-interactive`
  - disable prompts for automation flows or scripted setup

## What the doctor command checks

Human-friendly wrappers:
- Linux/macOS: `scripts/setup.sh doctor`
- Windows PowerShell: `./scripts/setup.ps1 doctor`

Portable Python implementation:
- `python scripts/setup_doctor.py`

It checks:
- Python version
- Node version
- `.venv` exists
- runtime and dev dependencies import from `.venv`
- `.env` exists
- `TELEGRAM_BOT_TOKEN` is not still a placeholder
- `MINI_APP_URL` is a full HTTPS URL
- DNS resolution for the configured hostname, best effort
- whether a Hermes execution path is configured
- whether the current platform is in a preferred or limited support mode

Use JSON output for automation:

```bash
python scripts/setup_doctor.py --json
```

The JSON output includes:
- per-check results
- fail/warn/pass counts
- a `summary.next_steps` list that an agent or script can surface directly

## Choosing a Hermes backend mode

### `HERMES_STREAM_URL`

Choose this when:
- you already expose a streaming Hermes endpoint
- you want the best incremental/live streaming experience in the Mini App
- you are comfortable pointing the Mini App at a remote HTTP endpoint

Tradeoff:
- not the simplest endpoint shape to stand up from scratch if you do not already have it

### `HERMES_API_URL`

Choose this when:
- you want the simplest HTTP-backed setup
- Hermes already runs elsewhere and exposes a plain API endpoint
- you want the easiest first-time path, especially on Windows

Tradeoff:
- usually less stream-native than a dedicated streaming endpoint

### Local Hermes mode

Choose this when:
- Hermes runs on the same machine as the Mini App
- you prefer direct local execution instead of calling a remote HTTP endpoint
- your setup is private/local enough that machine-specific config is acceptable

Tradeoffs:
- more machine-specific setup
- less portable between machines
- Windows support is weaker than the HTTP-backed modes today

If Hermes runs on the same machine as the Mini App, you can use local agent/CLI configuration.

Relevant variables:
- `MINI_APP_AGENT_HOME`
- `MINI_APP_AGENT_HERMES_HOME`
- `MINI_APP_AGENT_WORKDIR`
- `MINI_APP_AGENT_VENV`
- `MINI_APP_AGENT_PYTHON`
- `HERMES_CLI_COMMAND`

Portable defaults are derived from `HOME` and `HERMES_HOME`, but explicit configuration is safer when your environment is unusual.

## Testing

Python:

```bash
.venv/bin/python -m pytest -q
```

Windows PowerShell:

```powershell
.venv\Scripts\python.exe -m pytest -q
```

Node:

```bash
node --test tests/*.mjs
```

## Troubleshooting

Use `setup-troubleshooting.md` for a keyed troubleshooting matrix based on the doctor output.
