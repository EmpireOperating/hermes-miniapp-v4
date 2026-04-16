# Setup troubleshooting

This page is the companion to `scripts/setup_doctor.py`.

Recommended order:
1. run the setup bootstrap
2. run the setup doctor
3. use the doctor key below to fix the specific issue
4. rerun the doctor until blocking issues are gone
5. once DNS + HTTPS are ready, run `scripts/setup.sh telegram`

Human-friendly commands:
- Linux/macOS: `scripts/setup.sh` then `scripts/setup.sh doctor`
- Windows: open a WSL2 shell, then run `scripts/setup.sh` and `scripts/setup.sh doctor` there

Portable Python fallback:
- `python3 scripts/setup_bootstrap.py --write-env-if-missing`
- `python3 scripts/setup_doctor.py`

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
- Windows: open a WSL2 shell, then run `scripts/setup.sh`
- portable fallback: `python3 scripts/setup_bootstrap.py --write-env-if-missing`

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
- Windows should use WSL2 for Mini App setup and runtime
- Hermes Agent does not support a native Windows runtime path

Important Windows note:
- do Mini App setup from WSL2, even if the app will talk to an HTTP-backed Hermes endpoint
- use `scripts/setup.sh` and `scripts/setup.sh doctor` from inside WSL2

## If the doctor still looks confusing

Use this minimal checklist:
1. run bootstrap
2. make sure `.env` exists
3. set `TELEGRAM_BOT_TOKEN`
4. set `MINI_APP_URL` to a real HTTPS URL on a domain you control
5. set one Hermes backend path
6. rerun doctor
7. start with `.venv/bin/python server.py`
8. verify `curl http://127.0.0.1:8080/health`
9. run `scripts/setup.sh telegram`
10. open the Mini App from Telegram and send a message

## Telegram finalize command failures

Common failure patterns:
- `Could not reach MINI_APP_URL over HTTPS`
  - DNS is not live yet, TLS is broken, or the app is not actually serving at the final public URL
- `Could not reach the Mini App health endpoint`
  - the public app origin is up, but `/health` is not reachable on that same origin
- `Telegram bot token verification failed`
  - the token is wrong or was copied with extra characters
- `Telegram menu button verification failed`
  - Telegram accepted the request but did not report the expected web app button after the change

When this happens:
1. confirm `.env` has the exact final `MINI_APP_URL`
2. open that URL in a browser and confirm it loads over HTTPS
3. confirm `https://<your-domain>/health` works on the same origin
4. rerun `scripts/setup.sh telegram`

## For automation

Machine-readable output:

```bash
python3 scripts/setup_doctor.py --json
```

The JSON includes:
- `results`
- `summary.fail_count`
- `summary.warn_count`
- `summary.pass_count`
- `summary.next_steps`

Clean install smoke harness:

```bash
scripts/install_smoke.sh
```

Use that when you want to verify the documented bootstrap path in a disposable container before changing setup docs or CI.
