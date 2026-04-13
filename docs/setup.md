# Setup guide

This guide is the canonical setup path for Hermes Mini App v4.

If you only read one setup document, read this one.

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

2. Edit `.env` and set the minimum required values:
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
- creates `.env` from `.env.example` when you pass `--write-env-if-missing`
- prints clear next steps

Flags:
- `--write-env-if-missing`
  - create `.env` from `.env.example` if `.env` does not exist
- `--skip-node-check`
  - skip the Node version check
- `--non-interactive`
  - reserved for automation flows; the current bootstrap is already non-interactive

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

## Choosing a Hermes backend mode

### Recommended: HTTP-backed Hermes mode

Use one of:
- `HERMES_STREAM_URL`
- `HERMES_API_URL`

This is the easiest path for:
- Windows users
- remote deployments
- setups where Hermes already runs elsewhere

### Local Hermes mode

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

## Troubleshooting by doctor result

- `.env is missing`
  - run `python scripts/setup_bootstrap.py --write-env-if-missing`
- `TELEGRAM_BOT_TOKEN is missing or still set to a placeholder value`
  - edit `.env` and paste your real bot token
- `MINI_APP_URL must be a full HTTPS URL`
  - use your real Telegram-facing HTTPS URL, not `http://localhost`
- `Could not resolve <host> yet`
  - set up DNS and wait for propagation
- `No Hermes execution path detected`
  - configure `HERMES_STREAM_URL`, `HERMES_API_URL`, or a local Hermes path
- `Windows detected. Local Hermes runtime mode is not yet a fully first-class path`
  - prefer HTTP-backed Hermes mode or use Linux/macOS for local-runtime-heavy workflows
