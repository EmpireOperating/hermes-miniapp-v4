# Code reading guide

This file is for newcomers who want to understand the repository structure without opening files in a random order.

The repo can look larger than it is because the backend and frontend are intentionally split into many small modules. Use this map to build a mental model quickly.

## Recommended reading order

### 1. Start with the product-level docs

Read these first:
1. `../README.md`
2. `setup.md`
3. `architecture.md`

That gives you the deployment shape, setup expectations, and request flow before you start tracing modules.

### 2. Understand app bootstrap

Open:
- `../server.py`
- `../app_factory.py`

Why:
- this is the fastest way to see how configuration, routes, and shared services come together
- if you only open one backend entry point, start here

Questions these files answer:
- how does the Flask app start?
- where are routes registered?
- where do shared dependencies get wired?

### 3. Read the main route entry points

Open these next:
- `../routes_auth.py`
- `../routes_chat.py`
- `../routes_chat_stream.py`
- `../routes_jobs_runtime.py`
- `../routes_meta.py`

Why:
- these are the main public/backend-facing entry points
- they show the app contract more clearly than diving straight into helpers

If you want the shortest newcomer path, focus on auth, chat, and stream first.

### 4. Learn how Hermes execution is chosen

Open:
- `../hermes_client.py`
- then the related helpers it imports, especially:
  - `../hermes_client_http.py`
  - `../hermes_client_agent.py`
  - `../hermes_client_cli.py`
  - `../hermes_client_bootstrap.py`

Why:
- this is where the repo decides whether to use `HERMES_STREAM_URL`, `HERMES_API_URL`, local agent runtime, or CLI fallback
- many setup questions make more sense after reading this layer

### 5. Understand persistence separately from routes

Open:
- `../store.py`
- then `../store_*.py`

Suggested order:
- `../store_models.py`
- `../store_auth.py`
- `../store_chats.py`
- `../store_jobs.py`
- `../store_runtime.py`

Why:
- the route layer gets much easier to follow once you understand the SQLite-backed state model
- these files explain how chats, jobs, auth state, unread state, and runtime metadata are persisted

### 6. Read the job/runtime layer only after the route/storage layer makes sense

Open:
- `../job_runtime.py`
- `../job_runtime_chat_job.py`
- `../job_runtime_worker_launcher.py`
- `../chat_worker_runner.py`
- `../chat_worker_subprocess.py`

Why:
- these files support the queue/background execution path
- they are important, but they are easier to understand after you already know the main request path

### 7. Frontend reading order

Open in this order:
1. `../static/app.js`
2. `../static/stream_controller.js`
3. `../static/bootstrap_auth_helpers.js`
4. `../static/chat_history_helpers.js`
5. `../static/chat_tabs_helpers.js`
6. `../static/runtime_*.js`
7. the remaining UI-focused helper modules under `../static/`

Why:
- `app.js` shows the top-level orchestration
- `stream_controller.js` explains how progressive replies are handled
- the helper modules become easier to place once you know the main app shell and stream flow

## If you only care about setup difficulty

Read in this order:
1. `../README.md`
2. `setup.md`
3. `../scripts/setup_bootstrap.py`
4. `../scripts/setup_doctor.py`
5. `../scripts/setup_telegram.py`
6. `../tests/test_setup_bootstrap.py`
7. `../tests/test_setup_doctor.py`
8. `../tests/test_setup_telegram.py`

That gives you the actual operator path plus the tests that enforce it.

## If you only care about agent-friendliness

Focus on:
- `../scripts/setup_bootstrap.py`
- `../scripts/setup_doctor.py --json`
- `../scripts/test.sh`
- `../scripts/install_smoke.sh`
- `../tests/test_install_smoke.py`

These are the main reasons the repo is easier for an agent than many comparable projects.

## Quick repo map

Broadly, the repo splits into these areas:
- app bootstrap: `server.py`, `app_factory.py`
- route surface: `routes_*.py`
- persistence: `store*.py`
- Hermes execution routing: `hermes_client*.py`
- background execution/runtime: `job_runtime*.py`, `chat_worker*.py`
- frontend UI/runtime: `static/*.js`
- setup/operator scripts: `scripts/*.py`, `scripts/*.sh`
- verification: `tests/`

## Good first files for contributors

Depending on your goal:
- setup/docs improvements
  - `../README.md`, `setup.md`, `setup-troubleshooting.md`, `../CONTRIBUTING.md`
- backend API behavior
  - `../routes_chat.py`, `../routes_chat_stream.py`, `../routes_auth.py`
- runtime behavior
  - `../hermes_client.py`, `../job_runtime.py`, `../job_runtime_worker_launcher.py`
- frontend UX
  - `../static/app.js`, `../static/stream_controller.js`, helper modules in `../static/`
- tests first
  - search `../tests/` for the route/helper/runtime you want to touch before editing implementation files

## Final advice

Do not start by reading every file in `static/` or every `store_*.py` module in alphabetical order.

Start at the top-level app entry points, then follow the request path, then read the helper layers only when you need them.
