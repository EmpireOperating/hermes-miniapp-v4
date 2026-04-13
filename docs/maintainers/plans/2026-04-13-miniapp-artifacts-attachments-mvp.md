# Miniapp Artifacts / Attachments MVP Spec

> For Hermes: do not start implementation from this document on the open-source release branch. This is a release-safe planning/spec document only. If implementation proceeds later, do it on a dedicated feature branch after the OSS rollout is complete.

Goal: Add a narrow, high-leverage attachment flow to Hermes Mini App so users can send screenshots and common documents to the agent, and later receive agent-generated artifacts back in the same thread.

Architecture: Reuse the existing chat/message pipeline rather than introducing a parallel media system. Treat attachments as structured message metadata tied to normal chat messages, store uploaded files under a dedicated server-controlled root, and render them in transcript UI with the same chat persistence and reopen semantics as existing messages.

Tech Stack: Flask backend, current SQLite-backed miniapp state, existing `/api/chat` and `/api/chat/stream` routes, current transcript/composer JS modules, existing file-preview infrastructure.

---

## Release constraint

The immediate priority is open-sourcing the repository cleanly.

That means this spec intentionally recommends:
- no partial attachment feature code on the release branch
- no default-off feature flag as a substitute for branch isolation
- no new API surface merged just before OSS rollout

Preferred release sequence:
1. ship/document the current OSS snapshot
2. preserve this spec
3. implement attachments later on a dedicated branch such as `feat/miniapp-attachments-mvp`

---

## Product decision this spec implements

The useful first version is not “become a full chat app with media.”

It is:
- user -> agent attachments for screenshots and common work files
- eventually agent -> user artifact delivery in the same thread
- all scoped as a narrow artifacts workflow, not a broad social messaging feature

Why this is worth doing:
- screenshots are one of the highest-value debugging inputs for the mini app
- logs, patches, text files, JSON, PDFs, and repro artifacts fit the agent workflow well
- the agent already benefits from local file access and file-preview concepts
- artifacts align with the thread title `[feat]artifacts` better than a generic “photo sharing” feature

Why the MVP must stay small:
- today’s goal is a clean OSS release, not a rushed UX expansion
- media features sprawl quickly if drag/drop, paste, multi-select, galleries, camera capture, and arbitrary binary support are added together
- storage/auth/cleanup rules need to be explicit before any upload surface ships

---

## Terms

Use consistent language:

- attachment:
  - any user-supplied uploaded file associated with a chat message
- artifact:
  - any file surfaced in-thread as part of work, including user uploads now and agent-generated files later
- upload:
  - user -> server transfer before message send
- transcript attachment rendering:
  - how a sent message shows its attached files in history/reopen/reload flows

For MVP planning, “attachments” is the implementation term and “artifacts” is the broader product framing.

---

## Existing code landmarks

These current code areas matter most for a future implementation:

Frontend:
- `templates/app.html`
  - current composer/transcript shell
- `static/app.js`
  - app bootstrap, composer submission wiring, file-preview config exposure
- `static/stream_controller.js`
  - stream send path and optimistic local message handling
- `static/render_trace_message_helpers.js`
  - message rendering orchestration
- `static/render_trace_text_helpers.js`
  - inline file-ref rendering and allowed-root gating
- `static/chat_history_helpers.js`
  - transcript history normalization/signature behavior

Backend:
- `routes_chat_sync.py`
  - sync send path and transcript serialization
- `routes_chat_stream.py`
  - streaming send path
- `routes_auth_service.py`
  - transcript/bootstrap message serialization on app load
- `routes_chat_management.py`
  - file-preview endpoint behavior
- `server.py`
  - app-level config wiring for file preview and feature exposure
- `file_refs.py`
  - current structured file reference extraction behavior
- current SQLite/chat storage modules
  - message persistence and chat history retrieval

Important existing capability to reuse:
- the mini app already understands file references and has a controlled file-preview path model
- that makes attachment rendering and agent-side file inspection more natural than building an entirely separate media subsystem

---

## Scope split: two distinct features

There are really two features here.

### Phase A: user -> agent attachments

User can:
- choose one local image or common document
- see it staged in the composer
- send it with a prompt, or by itself if policy allows attachment-only sends

Agent/backend can:
- access the uploaded file as a structured file input
- keep the attachment associated with the user’s message in transcript history

### Phase B: agent -> user artifacts

Agent can:
- return a generated file or reference a produced artifact

User can:
- see/download/open the returned artifact in the thread

Recommendation:
- implement Phase A first
- defer Phase B until the inbound flow and transcript rendering are solid

---

## MVP scope

### In scope for MVP

- single attachment per message
- file picker upload from device storage
- support for:
  - images: png, jpg/jpeg, webp, gif
  - common work docs/files: pdf, txt, md, json, csv, tsv, log, yaml/yml
- composer attachment chip before send
- transcript rendering after send:
  - image thumbnail or image chip
  - filename/type/size chip for non-image files
- persisted association between message and attachment metadata
- backend validation of mime type/extension and size
- server-controlled upload root
- authenticated access rules for preview/download
- attachment history surviving reload/reopen/reconnect

### Explicitly out of scope for MVP

- multi-attachment send
- drag and drop
- paste from clipboard
- direct camera capture
- gallery UI
- arbitrary binary blobs or zip bundles by default
- rich document preview for every format
- image editing/cropping/annotation
- background resumable uploads
- public URLs

---

## User experience

### Composer behavior

Desktop/mobile MVP behavior:
- composer shows an attach control
- selecting a file uploads it immediately or stages it for upload before send; pick one consistent model and document it in implementation
- selected file appears as a removable chip above or inside the composer
- user can remove/replace the attachment before sending
- send remains keyboard-first on desktop

Recommended UX copy:
- attach button label or tooltip: `Attach screenshot or file`
- chip metadata: filename + compact size
- error copy should be plain and short:
  - `File too large.`
  - `Unsupported file type.`
  - `Upload failed. Try again.`

### Transcript behavior

Operator/user message with attachment should render as:
- normal message body if text exists
- attachment chip(s) below the body
- attachment-only message should still render a visible attachment container instead of looking blank

For images:
- small thumbnail in transcript
- tap/click opens preview or download

For docs/files:
- chip with filename, icon/type, size
- tap/click opens preview when supported, otherwise download

### Retry/reconnect behavior

Must be explicit:
- failed upload must not silently disappear
- send retry must not duplicate already-uploaded files without reason
- reconnect/reopen must preserve attachment association in transcript

---

## Data model recommendation

Attachments should be structured message metadata, not hidden text markers if we can avoid it.

Preferred model:
- every persisted message may optionally carry `attachments`
- `attachments` is a list, even if MVP only allows one item
- message body stays human text only

Suggested attachment metadata shape:

```json
{
  "id": "att_...",
  "kind": "image",
  "filename": "screenshot.png",
  "content_type": "image/png",
  "size_bytes": 123456,
  "storage_path": "/absolute/server/path/.../screenshot.png",
  "preview_url": "/api/chats/attachments/<id>/preview",
  "download_url": "/api/chats/attachments/<id>/download",
  "width": 1440,
  "height": 900
}
```

For non-images, width/height are optional/omitted.

Important guidance:
- avoid encoding attachments into the visible message body as sentinel text if possible
- if a temporary compatibility shim is ever needed, treat it as migration glue only, not the long-term contract

---

## Storage design

Uploads must live under a dedicated root that the server controls.

Recommended layout:
- one configured upload root, outside static public assets
- per-user and per-chat partitioning beneath it

Example:
- `<upload_root>/user-<user_id>/chat-<chat_id>/<generated_name>-<safe_filename>`

Requirements:
- never trust client-supplied paths
- always generate storage names server-side
- sanitize display filename separately from stored filename
- keep metadata in persisted message data, not just filesystem naming

### Size limits

MVP should start conservative.

Recommended initial limits:
- images: 10 MB max
- documents/files: 10 MB max
- one attachment per message

If mobile upload reliability is shaky, start lower and raise later.

### Cleanup policy

Need a deliberate rule before shipping:
- attachments tied to persisted messages should remain available with chat history
- orphaned uploads that never became part of a message should be garbage-collected after a short TTL

Recommended MVP policy:
- uploaded-but-unsent temporary files: delete after 24 hours
- message-bound attachments: retain until explicit future retention policy exists

---

## Security and auth requirements

This is the part most likely to go wrong if rushed.

### Required server-side checks

- authenticated user only
- attachment must belong to the requesting user and chat
- resolved storage path must stay inside the configured upload root
- allowed mime types/extensions enforced server-side, not only in HTML input attributes
- size cap enforced server-side
- no executable/script upload types in MVP

### Preview/download rules

- no direct static public serving from an unauthenticated path
- preview/download endpoints should re-check ownership
- image preview may stream inline with safe headers
- document download should use attachment download headers unless/until safe preview support is explicit

### Privacy

Do not make uploads globally addressable.

No:
- public CDN URLs
- guessable unauthenticated file paths
- embedding raw absolute storage paths into UI where avoidable

---

## Backend API recommendation

A future implementation likely needs two API stages.

### 1. Upload endpoint

Purpose:
- accept multipart upload
- validate and store file
- return attachment metadata token/object to associate with a later message send

Suggested route:
- `POST /api/chats/upload`

Suggested response:

```json
{
  "ok": true,
  "attachment": {
    "id": "att_123",
    "kind": "image",
    "filename": "screenshot.png",
    "content_type": "image/png",
    "size_bytes": 123456,
    "preview_url": "/api/chats/attachments/att_123/preview",
    "download_url": "/api/chats/attachments/att_123/download"
  }
}
```

### 2. Message send contract

Both send paths should accept the same logical shape:
- `/api/chat`
- `/api/chat/stream`

Suggested request addition:

```json
{
  "message": "please inspect this screenshot",
  "attachments": [
    {
      "id": "att_123"
    }
  ]
}
```

Implementation note:
- server should re-resolve stored metadata from attachment id rather than trusting all metadata echoed from the browser

### 3. Preview/download endpoints

Suggested routes:
- `GET /api/chats/attachments/<attachment_id>/preview`
- `GET /api/chats/attachments/<attachment_id>/download`

---

## Agent/runtime contract

The agent should receive attachments as structured inputs, not as only prose saying “a file was uploaded.”

Preferred shape in runtime request context:
- attachment metadata list on the operator message
- local server file path available to tooling where appropriate
- attachment kind/content type available for model/tool routing

MVP requirement:
- screenshots and uploaded files must be inspectable by the agent/tooling in the same environment where the mini app backend runs

This is a major reason to do attachments at all.

---

## Frontend implementation direction for later

When implementation starts later, preserve the current architecture instead of scattering ad-hoc state.

Recommended later work areas:

1. composer UI
- `templates/app.html`
- `static/app.css`

2. composer state + upload handling
- `static/app.js`

3. stream send path parity
- `static/stream_controller.js`

4. transcript rendering
- `static/render_trace_message_helpers.js`
- `static/render_trace_text_helpers.js`
- possibly `static/chat_history_helpers.js`

Key rule:
- sync and stream paths must stay behaviorally aligned
- attachment rendering must survive reload/history hydration, not just optimistic local UI

---

## Testing requirements for future implementation

Any later implementation should add tests before rollout.

### Backend tests

Need coverage for:
- upload route success
- unsupported file type rejection
- oversize rejection
- path traversal rejection
- ownership/auth rejection on preview/download
- sync send path persists attachments
- stream send path persists attachments
- transcript/bootstrap serialization returns attachments correctly

### Frontend tests

Need coverage for:
- composer attach/remove behavior
- send path includes attachments for both sync and stream flows
- attachment-only message rendering
- transcript reopen preserves attachment chips/thumbnails
- failed upload state does not silently disappear

### Manual QA

Required before sign-off:
- desktop keyboard-first flow
- mobile upload flow
- reconnect after sending attachment
- reopen old thread with attachments
- image preview
- document download

---

## Rollout phases

### Phase 0: now
- write this spec only
- keep release branch clean
- open source safely

### Phase 1: inbound attachments MVP
- single attachment
- upload + transcript persistence + agent visibility
- desktop/mobile QA

### Phase 2: outbound artifacts
- agent-generated file return in-thread
- download/preview affordances

### Phase 3: UX polish
- drag/drop
- paste screenshots
- multi-attachment support
- richer preview behavior

---

## Acceptance criteria for MVP

Do not call the MVP done unless all are true:

- user can attach one supported image or common document
- attached file survives send and transcript reload
- sync and stream send paths behave the same
- agent can inspect the uploaded file as structured input
- image attachments visibly render in transcript
- non-image attachments visibly render in transcript
- preview/download requires auth and ownership
- unsupported files and oversize files fail clearly
- there is no blank/ghost message for attachment-only sends
- release branch remains free of partial attachment code until implementation is intentionally started later

---

## Open questions to resolve before implementation

1. Should MVP allow attachment-only sends with no text?
- recommendation: yes, but render clearly and keep backend contract explicit

2. Should upload happen immediately on file selection or only when send is pressed?
- recommendation: immediate upload usually gives better validation/error UX, but creates orphan cleanup needs

3. Should image thumbnails be generated server-side or use direct image preview route?
- recommendation: direct image preview route first; avoid thumbnail generation complexity in MVP unless performance demands it

4. Should agent-returned artifacts reuse the exact same attachment model?
- recommendation: yes, with a `source` or `producer` field if needed

5. Should file-preview allowed roots include the upload root?
- recommendation: yes, but only through authenticated ownership-checked routes or carefully controlled preview rules

---

## Recommended next step after OSS release

After the repository is open sourced and stable:
- create `feat/miniapp-attachments-mvp`
- turn this spec into a task-by-task implementation plan if needed
- implement inbound attachments first
- do a QA walkthrough before merge
