# Miniapp Telegram Unread Notifications Spec

> For Hermes: implement this from the current miniapp codebase. Preserve current unread-dot semantics. Do not invent a second notification model that diverges from unread behavior.

Goal: Send a real Telegram bot message to the signed-in user when the mini app produces a newly unread reply while the relevant chat is not visibly open, so Telegram itself delivers the push even when the mini app is minimized or closed.

Architecture: Reuse the existing unread source of truth instead of adding browser-push logic. Add a small server-side visibility/presence lease so the backend can distinguish visible-in-chat from backgrounded/closed, then emit at most one Telegram notification when a chat transitions from read to unread. Deliver via the existing bot token, not from the webview.

Tech Stack: Flask miniapp backend, SQLite session store, existing chat/job runtime, Telegram Bot API over requests, current miniapp JS lifecycle hooks.

---

## Product decision this spec implements

What the user actually wants is not “web push from the mini app.”

What they want is:
- if the mini app would show an unread dot,
- and the app is not visibly open on that chat,
- Telegram should ping them like a normal bot message.

That means:
- use the backend, not browser push
- send a normal Telegram message through the bot
- key notification delivery off unread semantics, not off stream chunks, tool events, or generic background activity

This keeps the feature aligned with existing UX:
- unread dot in app
- Telegram push outside app
- both driven by the same underlying state transition

---

## Why this needs a server-side visibility lease

Current unread behavior is split across two layers:

1. Persistent unread source of truth
- `chat_threads.last_read_message_id` in `store_schema.py`
- unread count derived in `store_chat_queries.py`
- active chat marked read in routes such as `routes_auth_service.py` and `routes_chat_management_service.py`

2. Immediate client UX behavior
- `static/runtime_unread_helpers.js`
- hidden/inactive chat logic increments unread locally when a reply lands outside the visible chat

Problem:
- `user_preferences.active_chat_id` alone is not enough to decide whether to notify
- when the mini app is minimized or killed, the backend may still think that chat is active
- so server-side notifications need one extra signal: “is this user visibly looking at this chat right now?”

Required solution:
- maintain an expiring visible-chat lease in the backend
- refresh it from the frontend while the document is visible
- let it expire automatically when the app is closed, backgrounded, or connectivity drops

Without that lease, the backend cannot accurately mirror unread-dot semantics for the active chat when Telegram closes the webview.

---

## User-facing behavior

### MVP behavior

Add one user-facing feature toggle:
- “Telegram alerts for unread chats”

When enabled:
- send a Telegram notification only when a chat transitions from read to unread
- do not notify for additional unread replies while that same chat remains unread
- do not notify if the user is visibly on that chat
- do notify if the user is on a different chat
- do notify if the mini app is hidden, minimized, or closed and the visibility lease has expired

### Explicit notification rule

A Telegram notification is sent only when all are true:
- notifications are enabled for the user
- a new `hermes` message was persisted
- unread count for that chat was effectively 0 before this reply and >0 after it
- the chat does not currently hold a valid visible lease for that user
- no notification has already been sent for this unread generation

### What does NOT notify in MVP

Do not notify on:
- stream chunks
- tool trace events
- queue/running meta events
- retries
- dead letters/errors with no new unread Hermes reply
- multiple parts of the same already-unread chat if the dot is already present

This is intentionally strict because the user said: notify me when there is an unread message.

### Telegram message shape

Keep the alert short and plain text:

Example:
`Unread reply in Main\nHermes: I finished the draft and found 2 failing tests.`

Optional second line if configured:
`Open: https://t.me/<bot_username>/<miniapp_short_name>?startapp=chat-73`

Do not use Markdown formatting in the alert body.

---

## Existing code landmarks

Primary files that define today’s behavior:
- `static/runtime_unread_helpers.js`
- `static/chat_history_helpers.js`
- `static/visibility_skin_helpers.js`
- `static/app.js`
- `routes_auth_service.py`
- `routes_chat_management_service.py`
- `store_schema.py`
- `store_chats.py`
- `store_chat_queries.py`
- `job_runtime.py`
- `job_runtime_chat_job.py`
- `miniapp_config.py`
- `routes_auth.py`

Most important current hooks:
- unread derivation: `store_chat_queries.py`
- mark read: `store_chats.py`, `routes_auth_service.py`, `routes_chat_management_service.py`
- final Hermes reply persistence: `job_runtime_chat_job.py`
- app visibility lifecycle: `static/visibility_skin_helpers.js`

---

## Backend design

## 1. Presence / visibility lease

Add a lightweight in-memory presence tracker.

New file:
- `miniapp_presence.py`

Responsibilities:
- track `(user_id, chat_id)` visible lease expiry timestamps
- optionally also track the user’s last visible `active_chat_id`
- expose helpers:
  - `mark_visible(user_id, chat_id, ttl_seconds)`
  - `mark_hidden(user_id, chat_id=None)`
  - `is_chat_visibly_open(user_id, chat_id, now=None)`
  - `prune_expired(now=None)`

Recommended lease TTL:
- 45 seconds

Recommended client heartbeat cadence:
- every 15 seconds while visible

Why in-memory is acceptable for MVP:
- this signal is ephemeral, not durable state
- on process restart we should prefer sending a notification over silently missing one
- the actual unread state remains persisted in SQLite

## 2. Notification preferences

Persist user preference in SQLite.

Schema change in `store_schema.py`:
- add `telegram_unread_notifications_enabled INTEGER NOT NULL DEFAULT 0` to `user_preferences`

Store methods in `store_chats.py`:
- `get_telegram_unread_notifications_enabled(user_id: str) -> bool`
- `set_telegram_unread_notifications_enabled(user_id: str, enabled: bool) -> None`

Optional phase-2 schema:
- add `telegram_notifications_muted INTEGER NOT NULL DEFAULT 0` to `chat_threads`

Do not add per-chat muting in MVP unless implementation cost stays trivial.

## 3. Notification outbox and dedupe

Do not call Telegram inline with no persistence.
That is the fastest implementation, but it risks duplicate sends on retries and loses auditability.

Add a small outbox table.

Schema additions in `store_schema.py`:
- new table `telegram_notification_outbox`

Suggested columns:
- `id INTEGER PRIMARY KEY AUTOINCREMENT`
- `user_id TEXT NOT NULL`
- `chat_id INTEGER NOT NULL`
- `job_id INTEGER`
- `kind TEXT NOT NULL`  — MVP value: `'unread_reply'`
- `first_unread_message_id INTEGER NOT NULL`
- `payload_json TEXT NOT NULL`
- `status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','suppressed'))`
- `attempts INTEGER NOT NULL DEFAULT 0`
- `last_error TEXT`
- `created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP`
- `sent_at TEXT`

Add unique index:
- `(user_id, chat_id, kind, first_unread_message_id)`

This gives exactly-once dedupe for an unread generation.

## 4. Telegram delivery service

Add a delivery helper.

New file:
- `miniapp_telegram_notifications.py`

Responsibilities:
- build plain-text alert body
- send `POST https://api.telegram.org/bot<TOKEN>/sendMessage`
- target `chat_id = int(user_id)`
- use a short timeout, e.g. 8 seconds
- return structured success/failure result

Suggested send payload:
- `chat_id`: Telegram user id from verified auth user
- `text`: plain text body
- `disable_web_page_preview`: false if a deep link is included, else true

Configuration needed in `miniapp_config.py`:
- `telegram_unread_notifications_enabled_default` is not needed; DB default handles opt-in
- `telegram_notification_send_timeout_seconds` default 8
- `telegram_bot_username` optional, for deep links
- `telegram_miniapp_short_name` optional, for direct reopen link

Environment variables:
- `MINI_APP_TELEGRAM_NOTIFICATION_TIMEOUT_SECONDS`
- `MINI_APP_TELEGRAM_BOT_USERNAME`
- `MINI_APP_TELEGRAM_MINIAPP_SHORT_NAME`

If deep-link config is missing, still send the notification without a link.

## 5. Dispatcher loop

Add a tiny background dispatcher thread, separate from job execution.

Possible implementation options:

Option A: integrate into `JobRuntime`
- pros: already owns background lifecycle and shutdown
- cons: mixes delivery concerns into job runtime

Option B: add a dedicated notification dispatcher object owned by `server.py`
- pros: cleaner separation
- cons: one more service lifecycle to wire

Recommendation:
- use Option B for cleanliness
- create it in `server.py`
- start once on app startup
- stop during runtime shutdown / module reload cleanup

New file:
- `miniapp_notification_dispatcher.py`

Responsibilities:
- poll outbox for pending items
- deliver them
- mark rows sent/failed/suppressed
- back off failed sends modestly

MVP can be simple:
- wake every 2 seconds, or use a threading event
- process a small batch, e.g. 20 rows
- suppress permanently on 400/403 from Telegram
- mark failed and retry later on network/5xx errors

---

## Unread transition algorithm

This is the critical logic and must stay aligned with today’s unread semantics.

Hook point:
- `job_runtime_chat_job.py`
- specifically around the section where `role="hermes"` messages are persisted and the `done` event is published

Algorithm:

1. Before writing new Hermes reply parts:
- read current chat row
- compute `had_unread_before = (chat.unread_count > 0)`

2. Persist tool trace and Hermes reply parts exactly as today

3. Capture `first_unread_message_id`
- if `had_unread_before` is false, use the id of the first newly inserted Hermes message part
- if the reply was chunked into multiple persisted parts, still use only the first new Hermes message id as the unread-generation key

4. Decide whether the chat is visibly open
- query presence tracker for `(user_id, chat_id)` visible lease

5. If all true, enqueue one outbox item:
- notifications enabled for user
- `had_unread_before == false`
- visible lease is absent/expired
- no existing outbox row with the same unique key

6. Finish job normally regardless of notification delivery outcome

Important consequence:
- a 3-part long reply produces one Telegram notification, not three
- a second reply in the same chat while the first is still unread produces no additional push in MVP
- once the user reads the chat and unread returns to 0, the next reply can notify again

---

## Frontend design

The frontend does not send notifications. It only tells the backend whether the user is visibly on a chat.

## 1. Presence route

Add a new API route.

New file or route registration extension:
- preferably `routes_presence.py`

Endpoint:
- `POST /api/presence/state`

Payload:
- `init_data`
- `chat_id` (current active chat if any)
- `visible` boolean
- optional `reason` string for diagnostics (`boot`, `visibilitychange`, `heartbeat`, `pagehide`, `open-chat`)

Behavior:
- auth as normal JSON route
- if `visible=true` and `chat_id>0`, refresh visible lease for `(user_id, chat_id)`
- if `visible=false`, clear visible lease for that user, or at minimum for that chat
- return `{ ok: true }`

## 2. Frontend lifecycle hooks

Wire calls from existing lifecycle files.

Primary files:
- `static/visibility_skin_helpers.js`
- `static/app.js`
- `static/chat_history_helpers.js`

Required send points:
- after auth success / initial hydration when an active chat is known
- whenever `openChat(chatId)` succeeds
- on `visibilitychange`
- on `pagehide`
- on a repeating heartbeat while document is visible

Recommended behavior:
- visible heartbeat every 15 seconds for the active chat
- send hidden update immediately on `pagehide` and when visibility becomes non-visible
- if there is no active chat, no visible lease should be held

Do not block UI on these requests.
They are best-effort presence hints.

---

## Settings UX

Add a simple toggle to the existing settings surface.

Primary files:
- `templates/app.html`
- `static/app.js`
- `routes_auth.py`
- `store_chats.py`

UI text:
- label: `Telegram alerts for unread chats`
- help text: `Send me a Telegram message when Hermes replies in a chat I’m not currently viewing.`

API:
- `POST /api/preferences/notifications`
- payload: `init_data`, `telegram_unread_notifications_enabled`

Response:
- `{ ok: true, telegram_unread_notifications_enabled: true|false }`

MVP default:
- off by default
- explicit opt-in

Reasoning:
- even good notifications are sensitive enough to require user intent
- opt-in avoids surprising users with bot messages in their main chat

---

## Deep-link behavior

Best-case delivery:
- notification includes a direct reopen link into the mini app and target chat

Config needed:
- `MINI_APP_TELEGRAM_BOT_USERNAME`
- `MINI_APP_TELEGRAM_MINIAPP_SHORT_NAME`

Suggested link format:
- `https://t.me/<bot_username>/<miniapp_short_name>?startapp=chat-<chat_id>`

Server should treat this as optional.
If unavailable, still send the notification.

Phase-2 enhancement:
- teach auth/bootstrap to parse `startapp` payload and open the target chat automatically on launch

---

## Failure handling

### Telegram API 403 / blocked bot

If Telegram returns a permanent error like 403:
- mark outbox row `suppressed`
- store last error text
- do not crash job processing
- optionally surface a subtle in-app status later: `Telegram alerts unavailable until you re-enable/start the bot again`

Do not auto-disable the preference on first failure unless repeated failures prove the bot is blocked.

### Network or 5xx failures

If transient:
- mark row `failed`
- increment attempts
- retry later with backoff

### Presence uncertainty

If presence is missing or stale:
- prefer sending the notification

This is the correct bias for the feature request.
Missing a notification is worse than one extra alert.

---

## Testing plan

## Backend tests

Add/extend tests in:
- `tests/test_config.py`
- `tests/test_store.py`
- `tests/test_routes_auth.py`
- `tests/test_routes_chat.py`
- `tests/test_job_runtime_chat_job.py`
- `tests/test_routes_jobs_runtime.py`
- new: `tests/test_routes_presence.py`
- new: `tests/test_miniapp_telegram_notifications.py`
- new: `tests/test_notification_dispatcher.py`

Required cases:

1. Store migration
- preference column added with default off
- outbox table created
- unique key prevents duplicate unread-generation rows

2. Presence route
- visible call records lease
- hidden call clears lease
- unauthenticated call rejected

3. Notification enqueue
- no enqueue when notifications disabled
- enqueue when unread transitions 0 -> >0 and no visible lease
- no enqueue when unread already existed before reply
- no duplicate enqueue for multi-part reply
- no enqueue when visible lease is active for same chat
- enqueue when a different chat is visible

4. Dispatcher
- successful send marks row sent
- transient send failure marks failed and increments attempts
- permanent 403 marks suppressed

5. End-to-end-ish runtime behavior
- final Hermes message persistence still works unchanged
- notification failure never prevents job completion

## Frontend tests

Add/extend JS tests in:
- `tests/interaction_helpers.test.mjs` only if shared helpers are touched
- new/extended tests for whichever module owns presence posting

Required cases:
- visible heartbeat scheduled only while document visible
- pagehide sends hidden state
- opening a new chat refreshes visible lease for the new chat

---

## Rollout plan

## Phase 1: strict unread notifications only

Ship only:
- presence lease
- settings toggle
- unread-transition outbox
- Telegram bot send
- optional deep link if config exists

This phase should not notify for:
- failures
- stalls
- queue status
- tool activity
- clarifications without a persisted unread Hermes reply

This exactly matches the stated user need.

## Phase 2: per-chat mute + diagnostics

Add:
- per-chat mute toggle
- notification status in operator/runtime diagnostics
- optional admin endpoint showing pending/sent/failed notification counts

## Phase 3: richer alert classes, only if wanted later

Possible future extensions:
- stall/failure alerts
- “needs input” alerts distinct from generic unread
- alert summaries for pinned/background chats

Do not include these in MVP.
They are outside the current requirement and would risk noise.

---

## Recommended implementation order

### Task 1: Add config and schema support
Files:
- Modify: `miniapp_config.py`
- Modify: `store_schema.py`
- Modify: `store_chats.py`
- Test: `tests/test_config.py`
- Test: `tests/test_store.py`

### Task 2: Add presence tracker and presence route
Files:
- Create: `miniapp_presence.py`
- Create: `routes_presence.py`
- Modify: `server.py`
- Test: `tests/test_routes_presence.py`

### Task 3: Wire frontend visibility heartbeats
Files:
- Modify: `static/visibility_skin_helpers.js`
- Modify: `static/app.js`
- Possibly modify: `static/chat_history_helpers.js`
- Test: JS lifecycle tests

### Task 4: Add outbox store methods and Telegram sender
Files:
- Create: `miniapp_telegram_notifications.py`
- Modify: `store_chats.py` or a dedicated store mixin file
- Test: `tests/test_miniapp_telegram_notifications.py`

### Task 5: Add notification dispatcher lifecycle
Files:
- Create: `miniapp_notification_dispatcher.py`
- Modify: `server.py`
- Test: `tests/test_notification_dispatcher.py`

### Task 6: Enqueue notifications from final reply persistence path
Files:
- Modify: `job_runtime_chat_job.py`
- Possibly modify: `job_runtime.py` if dependency wiring passes through runtime
- Test: `tests/test_job_runtime_chat_job.py`

### Task 7: Add settings toggle
Files:
- Modify: `routes_auth.py`
- Modify: `templates/app.html`
- Modify: `static/app.js`
- Test: `tests/test_routes_auth.py`

### Task 8: Optional deep-link reopen support
Files:
- Modify: `miniapp_config.py`
- Modify: notification sender
- Later modify bootstrap/open-chat logic if `startapp` payload should auto-open target chat

---

## Acceptance criteria

This feature is done when all are true:
- user can opt into Telegram unread alerts in settings
- when a chat goes from read to unread and is not visibly open, a real Telegram bot message is sent
- when the user is visibly on that chat, no Telegram alert is sent
- minimizing/closing the mini app eventually expires presence and allows alerts
- one unread generation causes at most one Telegram notification
- multi-part long replies do not spam multiple alerts
- notification delivery failures do not affect chat completion
- current unread-dot behavior in the mini app is preserved

---

## Non-goals

Do not do any of the following in this feature:
- browser push notifications inside the Telegram webview
- OS-native notification registration from the mini app
- per-chunk or per-tool-call alerts
- generic background activity alerts unrelated to unread replies
- changing unread-count semantics to fit the notification system

The notification system must conform to unread behavior, not the other way around.
