# Setup troubleshooting

This page is the companion to `scripts/setup_doctor.py`.

Recommended order:
1. run the setup bootstrap
2. run the setup doctor
3. use the doctor key below to fix the specific issue
4. rerun the doctor until blocking issues are gone

Human-friendly commands:
- Linux/macOS: `scripts/setup.sh` then `scripts/setup.sh doctor`
- Windows PowerShell: `./scripts/setup.ps1` then `./scripts/setup.ps1 doctor`

Portable Python fallback:
- `python scripts/setup_bootstrap.py --write-env-if-missing`
- `python scripts/setup_doctor.py`

## Read the doctor output in this order

- Blocking issues
  - these prevent a normal first run
  - fix these first
- Warnings to fix next
  - these may still allow a local start, but they usually block real Telegram use or a smooth platform-specific experience
- Full check details
  - this is the per-check detail and exact fix text

## Doctor keys and what to do

### python

Meaning:
- your current interpreter is too old

Fix:
- install Python 3.11 or newer
- rerun bootstrap/doctor with that interpreter

### node

Meaning:
- Node.js is missing or too old for the frontend test suite

Fix:
- install Node.js 20+
- rerun the doctor

### venv

Meaning:
- `.venv` or its interpreter is missing

Fix:
- Linux/macOS: `scripts/setup.sh`
- Windows PowerShell: `./scripts/setup.ps1`
- portable fallback: `python scripts/setup_bootstrap.py --write-env-if-missing`

### dependencies

Meaning:
- one or more required Python packages are missing from `.venv`

Fix:
- rerun bootstrap to reinstall requirements
- if this keeps failing, inspect the pip error from bootstrap output

### env_file

Meaning:
- `.env` is missing

Fix:
- rerun bootstrap with env creation enabled
- or copy `.env.example` to `.env`

### telegram_bot_token

Meaning:
- `TELEGRAM_BOT_TOKEN` is missing or still a placeholder

Fix:
- edit `.env`
- set `TELEGRAM_BOT_TOKEN` to your real bot token

### mini_app_url

Meaning:
- `MINI_APP_URL` is missing or not a full HTTPS URL

Fix:
- edit `.env`
- set `MINI_APP_URL` to the exact HTTPS URL that Telegram will open
- do not use `http://localhost`

Important:
- the domain name itself does not matter much
- any domain or subdomain you control is fine
- if you do not already have one, the cheapest domain you can buy and control is usually enough

### dns

Meaning:
- the hostname in `MINI_APP_URL` does not resolve yet
- this is often normal before DNS has propagated

Fix:
- point the hostname at your reverse proxy or tunnel
- wait for DNS propagation
- rerun the doctor

### hermes_backend

Meaning:
- the Mini App cannot find a Hermes execution path

Fix:
choose one of these:
- set `HERMES_STREAM_URL`
- set `HERMES_API_URL`
- configure a local Hermes Agent path
- configure a local Hermes CLI command

Recommended default:
- use `HERMES_STREAM_URL` or `HERMES_API_URL` unless you specifically want a local Hermes runtime on the same machine

### platform_mode

Meaning:
- your platform is in a less-preferred support path

Current guidance:
- Linux is the primary supported path
- macOS is expected to work, but verify with the doctor
- Windows is best treated as:
  - supported for bootstrap, config, tests, and HTTP-backed Hermes mode
  - not yet fully first-class for every local-runtime feature

Important Windows note:
- warm attach currently depends on AF_UNIX unix-domain sockets
- that path is disabled on Windows intentionally
- prefer `HERMES_STREAM_URL` or `HERMES_API_URL` on Windows for the smoothest setup

## If the doctor still looks confusing

Use this minimal checklist:
1. run bootstrap
2. make sure `.env` exists
3. set `TELEGRAM_BOT_TOKEN`
4. set `MINI_APP_URL` to a real HTTPS URL on a domain you control
5. set one Hermes backend path
6. rerun doctor
7. start with `python server.py`

## For automation

Machine-readable output:

```bash
python scripts/setup_doctor.py --json
```

The JSON includes:
- `results`
- `summary.fail_count`
- `summary.warn_count`
- `summary.pass_count`
- `summary.next_steps`
