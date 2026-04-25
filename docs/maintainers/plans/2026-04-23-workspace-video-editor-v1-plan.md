# Workspace Video Editor V1 Implementation Plan

> For Hermes: Use subagent-driven-development skill to implement this plan task-by-task.

Goal: Turn the existing visual-dev workspace into a chat-scoped timeline editor for short-form media projects so Hermes can assemble drafts and the operator can manually tweak clips on rails before export.

Architecture: Reuse the existing visual-dev workspace shell, chat attachment model, and postMessage bridge, but swap the “preview-only” mental model for a structured editor surface. Keep timeline state as durable project data on the backend, let the workspace iframe render and edit that state in-browser, and let Hermes edit through explicit project operations instead of raw DOM-driving. Final render/export should be backend-first using ffmpeg, while workspace playback stays lightweight and interactive.

Tech Stack: Existing Flask backend + SQLite store + current visual-dev workspace frontend modules + new editor iframe app + structured project JSON + ffmpeg export pipeline.

---

## Why this fits the current branch

The current `feat/visual-dev-mode-phase2` branch already provides the right scaffolding:
- `templates/app.html` already has a right-side workspace panel
- `static/visual_dev_shell_helpers.js` already manages workspace open/close, width, preview frame swapping, runtime drawer, and chat-scoped state
- `static/visual_dev_mode_helpers.js` already loads attached sessions, syncs active-chat workspace context, and brokers selection/screenshot/runtime events
- `static/visual_dev_preview_helpers.js` and `static/visual_dev_bridge.js` already define a message bridge between parent app and iframe tool surface
- `routes_visual_dev.py`, `routes_visual_dev_service.py`, and `store_visual_dev.py` already persist chat-scoped workspace sessions, selections, artifacts, and console/runtime telemetry

That means V1 should be an evolution of the existing workspace, not a separate standalone app.

---

## Product definition for V1

V1 is not a full NLE. It is a short-form “AI timeline composer” attached to a chat.

### User mental model
- Left: chats
- Right: workspace
- Active chat owns one active media project
- Hermes edits the project through structured operations
- Operator sees the rails, preview, and inspector live
- Operator can make precise manual tweaks
- Export produces an mp4 artifact back into the workspace/chat flow

### Hard V1 constraints
- Short-form only: target 5s–60s projects
- One active project per chat
- Initial formats: 9:16 first, optionally 1:1 and 16:9
- Tracks: visual, text, audio only
- Editing ops: add/move/trim/split/delete/duplicate/select
- Backend export only; no heavy browser export requirement
- Keep the UX responsive over completeness

### Explicitly out of scope for V1
- Keyframes
- Masks
- Nested sequences
- Advanced transitions/effects library
- Real-time multi-user cursors
- Long-form editing optimization
- Fully autonomous “magic movie” generation with zero structure

---

## V1 UX spec

### Workspace layout

Modify the current workspace panel so the iframe hosts an editor app, not just an arbitrary preview.

Top area:
- Project title and aspect-ratio badge
- Play / pause
- Current time / total duration
- Export button
- Hermes actions menu: “Ask Hermes for cut”, “Apply suggested changes”, “Revert suggested changes”

Main editor area inside iframe:
- Preview player at top
- Timeline ruler below
- Three rails:
  - Visual
  - Text
  - Audio
- Asset bin side panel inside editor surface
- Selection inspector panel inside editor surface

### Timeline clip behavior

Each clip block should show:
- clip label
- media type icon or color
- start position on timeline
- duration width
- selected state
- optional dirty/AI badge if changed by Hermes draft ops

### Manual editing interactions

Required for V1:
- click clip to select
- drag clip horizontally to move it
- drag clip edges to trim
- keyboard delete/backspace to remove selected clip
- duplicate selected clip
- split selected clip at playhead
- drag playhead / scrub preview
- mute audio clip
- reorder clips within a track if needed by simple z-order controls, not freeform layer chaos

### Inspector behavior

Selection inspector fields for V1:
- clip label
- start time
- duration
- source in / source out
- text content for text clip
- text style preset: title / caption / body
- crop mode for visual clip: contain / cover
- audio gain for audio clip
- fade in / fade out toggle or short preset duration

### Hermes collaboration behavior

Hermes should not directly click around the editor.
Hermes should produce operation batches, for example:
- “tighten opening”
- “insert title card”
- “add captions from transcript”
- “lower music under narration”
- “make a 12-second cut from these three clips”

The UI should surface Hermes changes as a visible patch:
- summary of intended changes
- affected clips
- accept / reject / inspect actions

Do not silently mutate the timeline with no explanation.

---

## Canonical data model

Add a new project domain rather than overloading `visual_dev_sessions`.

### Project
```json
{
  "project_id": "proj_123",
  "chat_id": 17,
  "title": "Launch teaser",
  "aspect_ratio": "9:16",
  "resolution": {"width": 1080, "height": 1920},
  "fps": 30,
  "duration_ms": 15000,
  "status": "draft",
  "created_at": "...",
  "updated_at": "..."
}
```

### Asset
```json
{
  "asset_id": "asset_123",
  "project_id": "proj_123",
  "kind": "image|video|audio|text|screenshot|generated_image",
  "storage_path": "/abs/path/or/url",
  "content_type": "image/png",
  "label": "intro shot",
  "metadata": {
    "duration_ms": 4200,
    "width": 1080,
    "height": 1920
  }
}
```

### Track
```json
{
  "track_id": "track_visual",
  "project_id": "proj_123",
  "kind": "visual|text|audio",
  "position": 0,
  "label": "Visual"
}
```

### Clip
```json
{
  "clip_id": "clip_123",
  "project_id": "proj_123",
  "track_id": "track_visual",
  "asset_id": "asset_123",
  "kind": "asset|text",
  "start_ms": 0,
  "duration_ms": 3200,
  "source_in_ms": 0,
  "source_out_ms": 3200,
  "z_index": 0,
  "params": {
    "crop_mode": "cover",
    "x": 0,
    "y": 0,
    "scale": 1,
    "opacity": 1,
    "text": "",
    "style_preset": "title",
    "audio_gain": 1
  }
}
```

### Operation
```json
{
  "operation_id": "op_123",
  "project_id": "proj_123",
  "author": "user|hermes",
  "batch_id": "batch_123",
  "kind": "move_clip",
  "payload": {"clip_id": "clip_123", "start_ms": 1800},
  "created_at": "..."
}
```

### Suggested operation batch
```json
{
  "batch_id": "batch_123",
  "project_id": "proj_123",
  "author": "hermes",
  "status": "pending|accepted|rejected",
  "summary": "Tighten the opening and add a title card",
  "operations": [...]
}
```

Important: keep clip mutation operations as the only write path. Manual edits and Hermes edits should both compile down to operation records.

---

## Backend design

### New modules
Create:
- `media_project_models.py`
- `media_project_service.py`
- `store_media_projects.py`
- `routes_media_projects.py`
- `routes_media_project_export.py`
- `media_project_render_ffmpeg.py`

### Store responsibilities
`store_media_projects.py` should provide:
- create/get project by chat id
- list/create assets
- list/create/update/delete clips
- list tracks
- append operation log
- create/list suggestion batches
- persist export jobs/artifacts

### Schema additions
Modify:
- `store_schema.py`
- `store.py`

Add tables:
- `media_projects`
- `media_project_assets`
- `media_project_tracks`
- `media_project_clips`
- `media_project_operations`
- `media_project_suggestion_batches`
- `media_project_exports`

Do not mutate or repurpose `visual_dev_sessions` beyond using it to attach the workspace/editor surface to a chat.

### Routes
Add routes under `/api/media-projects`.

Required V1 endpoints:
- `GET /api/media-projects/chat/<chat_id>` → fetch or lazily create project shell
- `POST /api/media-projects/chat/<chat_id>/assets` → register imported asset
- `POST /api/media-projects/<project_id>/operations` → apply user operation batch
- `POST /api/media-projects/<project_id>/suggestions` → save Hermes suggestion batch
- `POST /api/media-projects/<project_id>/suggestions/<batch_id>/accept`
- `POST /api/media-projects/<project_id>/suggestions/<batch_id>/reject`
- `POST /api/media-projects/<project_id>/export`
- `GET /api/media-projects/<project_id>/exports`

### Export pipeline
`media_project_render_ffmpeg.py` should:
- build a deterministic ffmpeg command from normalized project JSON
- support image clips, text overlays, and audio tracks first
- support simple video clip trimming/concatenation once video asset support lands
- emit mp4 to artifact storage
- stream/export logs back into workspace runtime drawer or project export state

Backend-first principle: preview can be approximate, export must be deterministic.

---

## Frontend design

### Reuse existing workspace shell
Keep these existing files in place and evolve them:
- `templates/app.html`
- `static/app.css`
- `static/app.js`
- `static/visual_dev_shell_helpers.js`
- `static/visual_dev_mode_helpers.js`
- `static/visual_dev_preview_helpers.js`
- `static/visual_dev_bridge.js`

### New frontend modules
Create:
- `static/media_editor_bridge.js`
- `static/media_editor_parent_helpers.js`
- `static/media_editor_project_helpers.js`
- `static/media_editor_timeline_helpers.js`
- `static/media_editor_assets_helpers.js`
- `static/media_editor_inspector_helpers.js`
- `static/media_editor_playback_helpers.js`
- `static/media_editor_suggestions_helpers.js`
- `static/media_editor_iframe_app.js`
- `static/media_editor_iframe.css`
- `templates/media_editor.html`

### Parent app responsibilities
The main miniapp page should:
- attach one media project to the active chat
- load the editor iframe URL instead of arbitrary preview when the chat has a project/editor session
- request project summary from backend
- expose workspace context chips based on editor selection rather than DOM selection
- allow screenshot capture of editor preview or canvas output as artifacts
- surface export status/logs in the existing workspace drawer

### Iframe editor responsibilities
The editor iframe should:
- render project tracks and clips from project JSON
- maintain playhead and selection locally
- emit structured selection messages to parent
- emit user operation batches to parent/backend
- receive Hermes suggestion batches and show them as pending patch previews
- never talk to chat state directly; it stays project-scoped

### Bridge messages
Extend the bridge vocabulary to include editor-specific messages:
- `hermes-media-editor:ready`
- `hermes-media-editor:selection`
- `hermes-media-editor:playhead`
- `hermes-media-editor:operation-batch`
- `hermes-media-editor:suggestion-preview`
- `hermes-media-editor:export-status`

Do not mix old DOM-inspect messages and new editor messages in an ad hoc way; version them cleanly.

---

## Hermes integration design

Hermes should work against a structured editor context payload, not screenshots alone.

### Editor context attached to next send
Replace/expand current context chips so they can attach:
- selected clip summary
- selected track summary
- playhead position
- project summary
- pending export status
- latest screenshot artifact if present

### Prompt context shape
When the operator clicks “attach project context,” append something like:

```text
[Workspace media project context]
Project: Launch teaser
Aspect ratio: 9:16
Duration: 15.0s
Selected clip: intro-title
Track: Text
Clip start: 0.0s
Clip duration: 1.2s
Pending Hermes suggestion batch: none
Please use this workspace timeline context for the next change.
```

### Hermes write path
Hermes should propose JSON operation batches, for example:

```json
{
  "summary": "Make the opening faster and add a title card",
  "operations": [
    {"kind": "trim_clip", "payload": {"clip_id": "clip_a", "source_in_ms": 800, "duration_ms": 1800}},
    {"kind": "create_text_clip", "payload": {"track_id": "track_text", "text": "Hermes Mini App", "start_ms": 0, "duration_ms": 1200, "style_preset": "title"}}
  ]
}
```

The UI must let the operator inspect and accept/reject the batch before it mutates canonical project state.

---

## Implementation tasks

### Task 1: Add plan doc and branch scaffolding note

Objective: Land the design doc in the experiment branch so implementation can proceed without touching live main.

Files:
- Create: `docs/maintainers/plans/2026-04-23-workspace-video-editor-v1-plan.md`

Step 1: Save this plan in the experiment worktree

Step 2: Commit

```bash
git add docs/maintainers/plans/2026-04-23-workspace-video-editor-v1-plan.md
git commit -m "docs: add workspace video editor v1 plan"
```

### Task 2: Introduce backend media-project schema

Objective: Create a clean persistent domain for editor state.

Files:
- Modify: `store_schema.py`
- Modify: `store.py`
- Create: `store_media_projects.py`
- Test: `tests/test_store_media_projects.py`

Step 1: Write failing store tests for project creation, clip persistence, and operation logging

Step 2: Run test to verify failure

Run:
```bash
./scripts/test.sh tests/test_store_media_projects.py
```

Expected: FAIL because media-project tables/mixins do not exist.

Step 3: Add new schema tables and mixin methods

Step 4: Re-run tests and verify pass

Step 5: Commit

```bash
git add store_schema.py store.py store_media_projects.py tests/test_store_media_projects.py
git commit -m "feat: add media project persistence"
```

### Task 3: Add media-project service and routes

Objective: Expose chat-scoped project CRUD and operation APIs.

Files:
- Create: `media_project_models.py`
- Create: `media_project_service.py`
- Create: `routes_media_projects.py`
- Modify: `server.py`
- Test: `tests/test_routes_media_projects.py`

Step 1: Write failing route tests for:
- fetch-or-create project by chat id
- apply operation batch
- save Hermes suggestion batch
- accept/reject suggestion batch

Step 2: Run tests and verify failure

Step 3: Implement minimal service and route registration

Step 4: Re-run tests and verify pass

Step 5: Commit

```bash
git add media_project_models.py media_project_service.py routes_media_projects.py server.py tests/test_routes_media_projects.py
git commit -m "feat: add media project routes"
```

### Task 4: Add editor workspace shell state to the main app

Objective: Reuse the current visual-dev workspace but let it host an editor session instead of only a generic preview page.

Files:
- Modify: `templates/app.html`
- Modify: `static/app.css`
- Modify: `static/app.js`
- Modify: `static/visual_dev_mode_helpers.js`
- Test: `tests/frontend_runtime_media_editor_shell.test.mjs`

Step 1: Write failing frontend tests for:
- active chat loads media project workspace state
- workspace header shows editor-oriented status
- attached context chips can reflect clip/project context

Step 2: Run targeted JS tests

Run:
```bash
node --test tests/frontend_runtime_media_editor_shell.test.mjs
```

Expected: FAIL because media-editor shell state does not exist.

Step 3: Add minimal shell wiring without breaking existing visual-dev preview behavior

Step 4: Re-run tests and verify pass

Step 5: Commit

```bash
git add templates/app.html static/app.css static/app.js static/visual_dev_mode_helpers.js tests/frontend_runtime_media_editor_shell.test.mjs
git commit -m "feat: wire media editor into workspace shell"
```

### Task 5: Build the iframe editor app shell

Objective: Create a dedicated editor surface with preview, asset bin, timeline, and inspector.

Files:
- Create: `templates/media_editor.html`
- Create: `static/media_editor_iframe_app.js`
- Create: `static/media_editor_iframe.css`
- Test: `tests/media_editor_iframe_app.test.mjs`

Step 1: Write failing tests for editor boot, project rendering, and selection state

Step 2: Run tests and verify failure

Step 3: Implement iframe app shell with static rails and project hydration

Step 4: Re-run tests and verify pass

Step 5: Commit

```bash
git add templates/media_editor.html static/media_editor_iframe_app.js static/media_editor_iframe.css tests/media_editor_iframe_app.test.mjs
git commit -m "feat: add media editor iframe shell"
```

### Task 6: Implement timeline interactions

Objective: Make the rails usable for manual editing.

Files:
- Create: `static/media_editor_timeline_helpers.js`
- Create: `static/media_editor_playback_helpers.js`
- Modify: `static/media_editor_iframe_app.js`
- Test: `tests/media_editor_timeline_helpers.test.mjs`

Step 1: Write failing tests for:
- selecting a clip
- moving a clip
- trimming a clip
- splitting a clip
- deleting a clip

Step 2: Run tests and verify failure

Step 3: Implement minimal timeline interaction layer

Step 4: Re-run tests and verify pass

Step 5: Commit

```bash
git add static/media_editor_timeline_helpers.js static/media_editor_playback_helpers.js static/media_editor_iframe_app.js tests/media_editor_timeline_helpers.test.mjs
git commit -m "feat: add media editor timeline interactions"
```

### Task 7: Implement asset bin and text clip creation

Objective: Allow useful first drafts without full video ingestion complexity.

Files:
- Create: `static/media_editor_assets_helpers.js`
- Modify: `static/media_editor_iframe_app.js`
- Modify: `routes_media_projects.py`
- Test: `tests/media_editor_assets_helpers.test.mjs`
- Test: `tests/test_routes_media_projects.py`

Step 1: Write failing tests for:
- adding image asset clips
- adding audio asset clips
- adding text/title clips

Step 2: Run tests and verify failure

Step 3: Implement minimal asset-bin and clip creation flows

Step 4: Re-run tests and verify pass

Step 5: Commit

```bash
git add static/media_editor_assets_helpers.js static/media_editor_iframe_app.js routes_media_projects.py tests/media_editor_assets_helpers.test.mjs tests/test_routes_media_projects.py
git commit -m "feat: add media editor asset workflows"
```

### Task 8: Implement inspector editing

Objective: Support precise manual tweaking after Hermes drafts edits.

Files:
- Create: `static/media_editor_inspector_helpers.js`
- Modify: `static/media_editor_iframe_app.js`
- Test: `tests/media_editor_inspector_helpers.test.mjs`

Step 1: Write failing tests for editing clip fields from inspector

Step 2: Run tests and verify failure

Step 3: Implement inspector-driven operation batching

Step 4: Re-run tests and verify pass

Step 5: Commit

```bash
git add static/media_editor_inspector_helpers.js static/media_editor_iframe_app.js tests/media_editor_inspector_helpers.test.mjs
git commit -m "feat: add media editor inspector controls"
```

### Task 9: Add parent/iframe bridge for editor events

Objective: Carry structured editor context back into the miniapp workspace and composer chips.

Files:
- Create: `static/media_editor_bridge.js`
- Create: `static/media_editor_parent_helpers.js`
- Modify: `static/visual_dev_preview_helpers.js`
- Modify: `static/visual_dev_mode_helpers.js`
- Modify: `static/visual_dev_prompt_context_helpers.js`
- Test: `tests/media_editor_bridge.test.mjs`
- Test: `tests/visual_dev_prompt_context_helpers.test.mjs`

Step 1: Write failing tests for editor-ready, clip-selection, project-summary, and operation messages

Step 2: Run tests and verify failure

Step 3: Implement bridge and prompt-context support for media editor context

Step 4: Re-run tests and verify pass

Step 5: Commit

```bash
git add static/media_editor_bridge.js static/media_editor_parent_helpers.js static/visual_dev_preview_helpers.js static/visual_dev_mode_helpers.js static/visual_dev_prompt_context_helpers.js tests/media_editor_bridge.test.mjs tests/visual_dev_prompt_context_helpers.test.mjs
git commit -m "feat: bridge media editor context into workspace"
```

### Task 10: Add Hermes suggestion batches

Objective: Let Hermes propose visible, reversible edits instead of mutating state silently.

Files:
- Create: `static/media_editor_suggestions_helpers.js`
- Modify: `media_project_service.py`
- Modify: `routes_media_projects.py`
- Modify: `static/media_editor_iframe_app.js`
- Test: `tests/test_routes_media_projects.py`
- Test: `tests/media_editor_suggestions_helpers.test.mjs`

Step 1: Write failing tests for creating, previewing, accepting, and rejecting suggestion batches

Step 2: Run tests and verify failure

Step 3: Implement pending patch UI and backend persistence

Step 4: Re-run tests and verify pass

Step 5: Commit

```bash
git add static/media_editor_suggestions_helpers.js media_project_service.py routes_media_projects.py static/media_editor_iframe_app.js tests/test_routes_media_projects.py tests/media_editor_suggestions_helpers.test.mjs
git commit -m "feat: add hermes media edit suggestion batches"
```

### Task 11: Add export pipeline

Objective: Produce a usable mp4 artifact for short-form projects.

Files:
- Create: `media_project_render_ffmpeg.py`
- Create: `routes_media_project_export.py`
- Modify: `server.py`
- Modify: `static/media_editor_iframe_app.js`
- Modify: `static/visual_dev_mode_helpers.js`
- Test: `tests/test_routes_media_project_export.py`
- Test: `tests/test_media_project_render_ffmpeg.py`

Step 1: Write failing backend tests for ffmpeg command generation and export route status handling

Step 2: Run tests and verify failure

Step 3: Implement deterministic export command builder and export job route

Step 4: Re-run tests and verify pass

Step 5: Commit

```bash
git add media_project_render_ffmpeg.py routes_media_project_export.py server.py static/media_editor_iframe_app.js static/visual_dev_mode_helpers.js tests/test_routes_media_project_export.py tests/test_media_project_render_ffmpeg.py
git commit -m "feat: add media project mp4 export"
```

### Task 12: Add real video clip support after image/text/audio are stable

Objective: Extend the V1 timeline to ingest short source video with trim in/out.

Files:
- Modify: `media_project_service.py`
- Modify: `media_project_render_ffmpeg.py`
- Modify: `static/media_editor_assets_helpers.js`
- Modify: `static/media_editor_timeline_helpers.js`
- Test: `tests/test_media_project_render_ffmpeg.py`
- Test: `tests/media_editor_timeline_helpers.test.mjs`

Step 1: Write failing tests for video asset metadata, source trim, and export filter generation

Step 2: Run tests and verify failure

Step 3: Implement minimal short-clip support

Step 4: Re-run tests and verify pass

Step 5: Commit

```bash
git add media_project_service.py media_project_render_ffmpeg.py static/media_editor_assets_helpers.js static/media_editor_timeline_helpers.js tests/test_media_project_render_ffmpeg.py tests/media_editor_timeline_helpers.test.mjs
git commit -m "feat: add short video clip support to media editor"
```

---

## Verification checklist

Before calling V1 usable, verify all of the following manually:

1. Open a chat and confirm the workspace loads the editor surface for that chat.
2. Create/import at least one image, one text clip, and one audio clip.
3. Move and trim clips in the timeline without janky reflow.
4. Select a clip and edit it in the inspector.
5. Attach current project/clip context to the next Hermes message.
6. Have Hermes generate a suggestion batch.
7. Accept the batch and confirm timeline updates visibly.
8. Reject a different batch and confirm canonical timeline is unchanged.
9. Export mp4 and confirm the resulting file is attached as an artifact.
10. Switch chats and confirm projects remain chat-scoped and isolated.

---

## Recommended first cut order

Do not start with full video support.

Best implementation order:
1. Project schema
2. Editor shell iframe
3. Visual rail with image clips
4. Text clips
5. Audio clips
6. Manual timeline editing
7. Hermes suggestion batches
8. mp4 export
9. Short video support

This de-risks the feature while still proving the core product idea.

---

## Success criteria

V1 is successful if:
- Hermes can assemble a short draft using structured operations
- the operator can see and tweak rails manually in the workspace
- changes are inspectable and reversible
- exports are reliable enough for real short-form output
- the whole thing feels like collaborative editing, not “AI made a file somewhere”

If those are true, then yes: the bigger dream is real, and this becomes the foundation for image/video/storyboard/content-production workflows inside the workspace.
