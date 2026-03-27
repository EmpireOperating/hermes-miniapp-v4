from pathlib import Path


def _app_js() -> str:
    return Path("static/app.js").read_text(encoding="utf-8")


def test_tool_streaming_uses_keyed_target_resolution_and_phase_guardrails():
    app_js = _app_js()

    assert "const streamPhaseByChat = new Map();" in app_js
    assert "function patchVisibleToolTrace(chatId)" in app_js
    assert "findMessageNodeByKey(\n    \".message--tool\"" in app_js
    assert "stream-tool-phase-mismatch" in app_js
    assert "toolNodes[toolNodes.length - 1]" not in app_js


def test_assistant_streaming_uses_keyed_target_resolution():
    app_js = _app_js()

    assert "function patchVisiblePendingAssistant(chatId, nextBody, pendingState = true)" in app_js
    assert "findLatestAssistantHistoryMessage(chatId" in app_js
    assert "findMessageNodeByKey(\n    \".message--assistant\"" in app_js


def test_visibility_reconcile_for_active_chat_is_present():
    app_js = _app_js()

    assert "function handleVisibilityChange()" in app_js
    assert "syncActiveMessageView(activeId, { preserveViewport: true });" in app_js


def test_stream_latency_lifecycle_labels_are_seeded_for_send_and_resume():
    app_js = _app_js()

    assert "setChatLatency(chatId, \"calculating...\");" in app_js
    assert "setChatLatency(key, \"recalculating...\");" in app_js
    assert "setChatLatency(chatId, formatLatency(payload.latency_ms));" in app_js


def test_stream_debug_breadcrumbs_are_wired_through_event_and_latency_updates():
    app_js = _app_js()

    assert "function streamDebugLog(eventName, details = null)" in app_js
    assert "streamDebugLog(\"sse-event\"" in app_js
    assert "streamDebugLog(\"latency-set\"" in app_js
