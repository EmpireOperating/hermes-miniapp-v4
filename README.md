# Hermes Mini App v4

Telegram Mini App shell for Hermes Agent with a Hermes-style themed UI.

## What changed in v4

- single Hermes UI still stays simple
- multi-chat tabs added
- create new chats
- rename chats
- unread badges on inactive tabs when Hermes finishes replying there
- per-chat message history in SQLite
- active chat selection persists across reopen/auth
- queue-backed turn execution worker decouples response generation from UI connection lifecycle
- retry policy with exponential backoff and dead-letter capture for exhausted jobs
- pending turn state persists across reopen (if the latest turn is still awaiting Hermes)
- clear current chat
- keeps Hermes CLI / gateway architecture intact

## Architecture

- Telegram bot launches the Mini App
- Mini App authenticates with Telegram `initData`
- Flask backend verifies Telegram auth
- Backend calls Hermes through:
  - `HERMES_STREAM_URL` if available
  - `HERMES_API_URL` if available
  - otherwise direct in-process agent (when enabled) and finally local CLI
- chat threads and messages are stored in `sessions.db`

### Module map (server/store/client split)

- `server.py`
  - app bootstrap + shared runtime wiring (store/client/jobs/runtime objects)
  - route registration only (keeps endpoint logic out of the bootstrap file)
- `routes_auth.py`
  - Telegram auth verification, cookie/session issuance, auth guards
- `routes_chat.py`
  - chat/tab CRUD, message history reads/writes, stream endpoint wiring
- `routes_jobs_runtime.py`
  - queue/runtime status, retry/dead-letter inspection, runtime diagnostics
- `store.py`
  - SQLite data layer: chats, turns, unread state, job tables, dead letters
- `hermes_client.py`
  - Hermes routing and fallback policy (`HERMES_STREAM_URL` → `HERMES_API_URL` stream probe → direct agent paths → CLI)
  - persistent in-memory runtime session manager for direct-agent continuity

## Canonical workspace and runtime (important)

Use this path as source of truth:

- `/home/hermes-agent/workspace/active/hermes_miniapp_v4`

Do not run the app from legacy handoff paths under `/home/openclaw/Downloads/...`.

Canonical services:

- backend unit: `/home/openclaw/.config/systemd/user/hermes-miniapp-v4.service`
- tunnel unit: `/home/openclaw/.config/systemd/user/hermes-miniapp-v4-tunnel.service`
- command target: `server.py` in the Hermes workspace above
- env file loaded by services: `/home/hermes-agent/workspace/active/hermes_miniapp_v4/.env`

Quick verification commands:

```bash
# confirm service is running
systemctl --user status hermes-miniapp-v4.service

# confirm process cwd is Hermes workspace (not Downloads handoff)
pid=$(systemctl --user show -p MainPID --value hermes-miniapp-v4.service)
readlink -f /proc/$pid/cwd

# confirm listening port (from .env PORT)
ss -ltnp | grep ':8787'
```

## Quick start

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# or for hardened permanent-domain defaults:
# cp .env.permanent-domain.example .env
```

Fill in:

- `TELEGRAM_BOT_TOKEN`
- `MINI_APP_URL`
- optionally `HERMES_API_URL` or `HERMES_STREAM_URL`

Auth-switcher routing (recommended for persistent direct runtime):

- set `HERMES_MODEL=auto`
- set `HERMES_PROVIDER=auto`
- set `HERMES_BASE_URL=auto`
- ensure the miniapp service runs with:
  - `HOME=/home/hermes-agent`
  - `HERMES_HOME=/home/hermes-agent/.hermes`

With these values, the mini app resolves provider/base URL/model from the active Hermes auth/config context (`~/.hermes/auth.json` + `~/.hermes/config.yaml`) instead of requiring a fixed API key in miniapp `.env`.

Optional hardening settings:

- `FLASK_DEBUG=0` (default)
- `MAX_MESSAGE_LEN=4000`
- `MAX_TITLE_LEN=120`
- `MAX_CONTENT_LENGTH=1048576`
- `MINI_APP_TRUST_PROXY_HEADERS=1` (only when requests come through your trusted reverse proxy/tunnel)
- `MINI_APP_FORCE_SECURE_COOKIES=1` (always mark auth cookies as Secure)
- `MINI_APP_ALLOWED_ORIGINS=https://your-miniapp-domain.example` (comma-separated allowlist)
- `MINI_APP_ENFORCE_ORIGIN_CHECK=1` (reject mutating API calls from non-allowlisted origins)
- `MINI_APP_RATE_LIMIT_WINDOW_SECONDS=60`
- `MINI_APP_RATE_LIMIT_API_REQUESTS=180`
- `MINI_APP_RATE_LIMIT_STREAM_REQUESTS=24`
- `MINI_APP_ENABLE_HSTS=1` (enable only once permanent TLS domain is stable)
- `MINI_APP_JOB_MAX_ATTEMPTS=4` (queue worker retries before dead-letter)
- `MINI_APP_JOB_RETRY_BASE_SECONDS=2` (exponential backoff base seconds)
- `MINI_APP_JOB_EVENT_HISTORY_MAX_JOBS=256` (cap in-memory SSE history cache)
- `MINI_APP_JOB_EVENT_HISTORY_TTL_SECONDS=1800` (expire idle SSE history)

Optional dev hot-reload settings:

- `MINI_APP_DEV_RELOAD=1` enables dev-only polling reloads for template/CSS/JS/server changes
- `MINI_APP_DEV_RELOAD_INTERVAL_MS=1200` controls how often the client checks for changes
- static assets are cache-busted automatically with file mtime query params

Hot-reload verification:

```bash
curl -sS http://127.0.0.1:8787/dev/reload-state
# expect: {"ok":true,"enabled":true,...}

# watch version change when touching a watched file
before=$(curl -sS http://127.0.0.1:8787/dev/reload-state | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')
touch static/app.js
after=$(curl -sS http://127.0.0.1:8787/dev/reload-state | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')
echo "$before -> $after"
```

Run backend + tunnel (recommended: service mode):

```bash
# one-time install
systemctl --user daemon-reload
systemctl --user enable --now hermes-miniapp-v4.service
systemctl --user enable --now hermes-miniapp-v4-tunnel.service

# lifecycle
systemctl --user restart hermes-miniapp-v4.service hermes-miniapp-v4-tunnel.service
systemctl --user status hermes-miniapp-v4.service hermes-miniapp-v4-tunnel.service
journalctl --user -u hermes-miniapp-v4.service -u hermes-miniapp-v4-tunnel.service -f
```

Manual backend run (debugging only):

```bash
source .venv/bin/activate
set -a; source .env; set +a
python server.py
```

Note: this project does not auto-load `.env` by itself; service mode uses `EnvironmentFile=.../.env`.

Run tests:

```bash
python -m pytest -q
```

## Smoke test checklist

1) Start backend and tunnel with real values in `.env`
2) In Telegram Hermes chat, run `/app` and open the Mini App button
3) Verify auth loads and the operator name appears
4) Send a prompt and confirm streamed reply appears
5) Create and rename a chat (now via in-app modal, not browser prompt)
6) Switch tabs while a reply runs and verify unread badge behavior
7) Clear current chat and confirm history resets

## Notes

- The gateway can stay running for your normal Telegram Hermes chat.
- This Mini App is another frontend, not a gateway replacement.
- Unread badges are designed for replies that finish after you switch tabs.
- If a stream client disconnects mid-response (close/reopen), queue worker continues processing independently.
- Retries use exponential backoff; exhausted jobs move to dead-letter storage (`chat_job_dead_letters`) and a system message is written in-chat.
- Startup now emits structured dependency diagnostics (`HermesClient startup diagnostics` and `miniapp startup diagnostics`) with config/dependency readiness flags and redacted values.
- True external push from unrelated Hermes events is not implemented yet.
- Port `8080` may already be occupied on this machine; keep using the `.env` `PORT` value (`8787`) unless intentionally changed.

## Troubleshooting wrong build showing in Telegram

If Telegram shows an old UI/version:

1) Confirm the running backend process is the service process:

```bash
systemctl --user status hermes-miniapp-v4.service
pid=$(systemctl --user show -p MainPID --value hermes-miniapp-v4.service)
readlink -f /proc/$pid/cwd
```

2) Ensure no ad-hoc legacy process is running from `/home/openclaw/Downloads/hermes_miniapp_v4_handoff/...`.

3) Verify your `MINI_APP_URL` tunnel/proxy points to the same backend port as `.env` (`PORT=8787`).

4) Close and reopen the Mini App in Telegram (hard reopen) after backend restart.

5) Inspect queue/dead-letter state for the current authenticated user:

```bash
curl -sS -X POST http://127.0.0.1:8787/api/jobs/status \
  -H 'Content-Type: application/json' \
  -d '{"init_data":"<telegram-init-data>","limit":25}'
```

6) Inspect internal runtime recovery counters (operator-facing diagnostics):

```bash
curl -sS -X POST http://127.0.0.1:8787/api/runtime/status \
  -H 'Content-Type: application/json' \
  -d '{"init_data":"<telegram-init-data>"}'
```

Look under `runtime.queue_diagnostics` (and mirrored flat fields) for:
- `startup_recovered_running_total`
- `startup_clamped_exhausted_total`
- `preclaim_dead_letter_total`

For a fast incident snapshot, also inspect `runtime.incident_snapshot`:
- `workers.configured` / `workers.alive` and `wake_event_set` (runtime loop health)
- `terminal_events.terminal_counts` (`done` vs `error`)
- `terminal_events.recent_terminal` (most recent terminal event per job, with `age_seconds`)
- `terminal_events.age_stats_seconds` (`sample_size`, `median`, `p95` terminal age in seconds)
- `terminal_events.window_counts` (rolling `5m`/`15m`/`60m` done/error counts)
- `terminal_events.recent_error_messages` (deduped recent error messages for quick triage)
- `rate_windows.runtime` (rolling retry/dead-letter event counts)
- `rate_windows.terminal` (rolling terminal done/error counts)
- `severity_hint.level` + `severity_hint.reason` (quick triage hint without log-diving)

## Files

- `server.py` — Flask server and API routes
- `store.py` — SQLite storage for tabs, history, unread state
- `hermes_client.py` — Hermes CLI / HTTP adapter
- `templates/app.html` — Mini App shell
- `static/app.css` — Hermes-themed styling
- `static/app.js` — tabbed chat UI logic
