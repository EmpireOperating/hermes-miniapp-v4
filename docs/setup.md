# Setup guide

This guide is the canonical setup path for Hermes Mini App v4.

If you only read one setup document, read this one.

If the setup doctor reports something unclear, go straight to `setup-troubleshooting.md`.

## Recommended path

Use this path unless you already know you want something else:
- Python 3.11+
- Node.js 20+
- Linux/macOS (Bash/Zsh): `scripts/setup.sh` then `scripts/setup.sh doctor`
- Windows PowerShell: `./scripts/setup.ps1` then `./scripts/setup.ps1 doctor`
- Portable Python fallback: `python scripts/setup_bootstrap.py --write-env-if-missing` then `python scripts/setup_doctor.py`
- HTTP-backed Hermes mode unless you already have local Hermes running on Linux/macOS or under WSL2

## Platform support

- Linux
  - primary supported path today
- macOS
  - expected to work for bootstrap, tests, and core runtime
  - run the setup doctor to verify your environment
- Windows
  - native Windows is fine for bootstrap, config, tests, and HTTP-backed Hermes mode
  - if you want local Hermes on the same machine, use WSL2 rather than native Windows
  - local warm attach is currently disabled on native Windows because it depends on AF_UNIX unix-domain sockets; other local-runtime details still skew Unix-first

That means Windows users should prefer HTTP-backed Hermes mode natively. For same-machine local Hermes, use WSL2. If you try the local-runtime-heavy path on native Windows, the app should now degrade cleanly instead of failing with a cryptic socket error.

## Setup flow in two phases

### Phase A: local bootstrap and validation

1. Run the bootstrap command for your shell:

Linux/macOS (Bash/Zsh):

```bash
scripts/setup.sh
```

Windows PowerShell (native Windows, best with HTTP-backed Hermes):

```powershell
./scripts/setup.ps1
```

Portable Python fallback:

```bash
python scripts/setup_bootstrap.py --write-env-if-missing
```

On an interactive terminal, bootstrap fills the main first-run values in `.env` for you.

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

Windows PowerShell (native Windows, best with HTTP-backed Hermes):

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

This is usually the biggest setup friction. The short version:
- the domain name itself does not matter much
- any domain or subdomain you control is fine
- if you do not already have one, the cheapest domain you can buy and control is usually good enough
- it must serve valid HTTPS and match the URL your Telegram bot opens

## Bootstrap command

Use:
- Linux/macOS: `scripts/setup.sh`
- Windows PowerShell: `./scripts/setup.ps1`
- portable Python: `python scripts/setup_bootstrap.py --write-env-if-missing`

Bootstrap creates `.venv`, installs dependencies, creates `.env` when needed, and prompts for key values on an interactive terminal.

Flags:
- `--write-env-if-missing`
  - create `.env` from `.env.example` if `.env` does not exist
- `--skip-node-check`
  - skip the Node version check
- `--interactive`
  - force interactive prompts even if terminal detection would skip them
- `--non-interactive`
  - disable prompts for automation flows or scripted setup

## Doctor command

Use:
- Linux/macOS: `scripts/setup.sh doctor`
- Windows PowerShell: `./scripts/setup.ps1 doctor`
- portable Python: `python scripts/setup_doctor.py`

Doctor checks Python, Node, `.venv`, dependencies, `.env`, key config values, DNS, backend configuration, and platform mode.

Use JSON output for automation:

```bash
python scripts/setup_doctor.py --json
```

The JSON output includes:
- per-check results
- fail/warn/pass counts
- a `summary.next_steps` list that an agent or script can surface directly

## Backend mode notes

Use:
- `HERMES_STREAM_URL` for the best live UX if you already have a streaming endpoint
- `HERMES_API_URL` for the simplest remote setup
- local Hermes for same-machine setups that can tolerate more machine-specific configuration; on Windows, use WSL2 for this path

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

Windows PowerShell (native Windows, best with HTTP-backed Hermes):

```powershell
.venv\Scripts\python.exe -m pytest -q
```

Node:

```bash
node --test tests/*.mjs
```

## Troubleshooting

Use `setup-troubleshooting.md` for a keyed troubleshooting matrix based on the doctor output.
