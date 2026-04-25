from __future__ import annotations

from visual_dev_context import build_visual_context_message_block, deserialize_visual_context, serialize_visual_context


def test_visual_context_preserves_media_editor_clip_selection_metadata() -> None:
    payload = {
        "selection": {
            "selectionType": "media_editor_clip",
            "label": "Opening title",
            "selector": "media-editor-clip:clip_1",
            "tagName": "media-editor-clip",
            "clip_id": "clip_1",
            "track_id": "track_text",
            "clip_kind": "text",
            "start_ms": 250,
            "duration_ms": 1750,
            "text": "Big opening hook",
        }
    }

    serialized = serialize_visual_context(payload)
    normalized = deserialize_visual_context(serialized)

    assert normalized == {
        "selection": {
            "selectionType": "media_editor_clip",
            "label": "Opening title",
            "selector": "media-editor-clip:clip_1",
            "tagName": "media-editor-clip",
            "clip_id": "clip_1",
            "track_id": "track_text",
            "clip_kind": "text",
            "start_ms": "250",
            "duration_ms": "1750",
            "text": "Big opening hook",
        }
    }


def test_visual_context_message_block_describes_selected_media_editor_clip() -> None:
    block = build_visual_context_message_block(
        {
            "selection": {
                "selectionType": "media_editor_clip",
                "label": "Opening title",
                "selector": "media-editor-clip:clip_1",
                "tagName": "media-editor-clip",
                "clip_id": "clip_1",
                "track_id": "track_text",
                "clip_kind": "text",
                "start_ms": 250,
                "duration_ms": 1750,
                "text": "Big opening hook",
            }
        }
    )

    assert "Media editor context for this turn:" in block
    assert "- Selected clip: Opening title" in block
    assert "- Timing: 250–2000ms (duration 1750ms)" in block
    assert "- Clip ID: clip_1" in block
    assert "- Track ID: track_text" in block
    assert "- Clip kind: text" in block
    assert "- Visible text: Big opening hook" in block



def test_visual_context_message_block_instructs_media_editor_suggestion_format() -> None:
    block = build_visual_context_message_block(
        {
            "selection": {
                "selectionType": "media_editor_clip",
                "label": "Opening title",
                "clip_id": "clip_1",
                "track_id": "track_text",
                "clip_kind": "text",
                "start_ms": 0,
                "duration_ms": 1500,
            }
        }
    )

    assert "```media-project-suggestions" in block
    assert '"operations"' in block
    assert "create_text_clip" in block

