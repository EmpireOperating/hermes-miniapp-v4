# Architecture overview

Hermes Mini App v4 is a Telegram Mini App frontend backed by a Flask application that brokers chat requests to Hermes Agent.

## High-level request flow

1. Telegram opens the Mini App webview.
2. The frontend collects Telegram `initData` and sends it to the backend.
3. The backend verifies auth, initializes or restores session/chat state, and returns bootstrap metadata.
4. The frontend starts or resumes chat streaming.
5. The backend routes requests to Hermes through one of these execution paths:
   - `HERMES_STREAM_URL` for streaming HTTP backends
   - `HERMES_API_URL` for compatible API backends
   - local Hermes Agent runtime when enabled/configured
   - local Hermes CLI fallback
6. Results are persisted so the UI can reconnect, resume, and show prior chat history.

## Main backend components

- `server.py`, `app_factory.py`
  - Flask app bootstrap and shared service wiring.
- `routes_*.py`
  - HTTP endpoints for auth, chat, streaming, runtime diagnostics, metadata, and file preview.
- `store*.py`
  - SQLite-backed persistence for chat sessions, jobs, auth state, and metadata.
- `hermes_client.py`
  - Hermes routing policy, environment-driven runtime selection, and local fallback handling.
- `job_runtime_*`, `chat_worker_*`
  - Background execution helpers, worker launch logic, and stream/job lifecycle support.
- `security_headers.py`, `request_guards.py`, `rate_limit.py`
  - Security and abuse mitigation helpers.

## Main frontend components

- `static/app.js`
  - Main app bootstrap, event wiring, and page-level UI orchestration.
- `static/stream_controller.js`
  - Streaming lifecycle handling, SSE/event processing, and transcript updates.
- `static/chat_history_helpers.js`
  - Chat list, hydration, and persisted-history merge behavior.
- `static/bootstrap_auth_helpers.js`
  - Auth bootstrap and startup state restoration.
- `static/*`
  - UI helpers for tabs, pinned chats, files, diagnostics, and Telegram-specific integration.

## Persistence model

The app uses SQLite for local persistence. This enables:
- chat history recovery after reload
- reconnect/resume after transient disconnects
- queued/background work continuation when the UI closes
- unread and metadata tracking

## Security model highlights

Important security controls include:
- Telegram auth verification
- optional origin allowlist enforcement
- CSP and security headers
- request rate limiting
- secure-cookie support
- token-gated operator/runtime diagnostics
- file preview allow-root and denylist protections

Review `SECURITY.md` and deployment config carefully before exposing the app publicly.

## Operational note

The repository still preserves maintainer-oriented historical docs under `docs/maintainers/`. Treat this file and the top-level `README.md` as the primary public architecture entry points.
