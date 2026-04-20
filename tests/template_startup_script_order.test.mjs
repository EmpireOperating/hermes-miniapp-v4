import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const templateSource = readFileSync(join(__dirname, '..', 'templates', 'app.html'), 'utf8');

function indexOfFragment(fragment) {
  const index = templateSource.indexOf(fragment);
  assert.notEqual(index, -1, `expected template to include ${fragment}`);
  return index;
}

function indexOfScript(fragment) {
  return indexOfFragment(`<script defer src="${fragment}"></script>`);
}

test('render trace startup helpers load before app.js so transcript rendering is ready at bootstrap', () => {
  const appIndex = indexOfScript('/static/app.js?v={{ app_js_version }}');

  const renderTraceHelpers = [
    '/static/render_trace_text_helpers.js?v={{ render_trace_text_helpers_version }}',
    '/static/render_trace_debug_helpers.js?v={{ render_trace_debug_helpers_version }}',
    '/static/render_trace_message_helpers.js?v={{ render_trace_message_helpers_version }}',
    '/static/render_trace_history_helpers.js?v={{ render_trace_history_helpers_version }}',
    '/static/render_trace_helpers.js?v={{ render_trace_helpers_version }}',
  ];
  renderTraceHelpers.forEach((fragment) => {
    assert.ok(
      indexOfScript(fragment) < appIndex,
      `expected ${fragment} to load before app.js`,
    );
  });
});

test('interaction helpers load before app.js so quote-selection bindings and mobile detection are available synchronously', () => {
  const appIndex = indexOfScript('/static/app.js?v={{ app_js_version }}');
  const interactionHelpersIndex = indexOfScript('/static/interaction_helpers.js?v={{ interaction_helpers_version }}');

  assert.ok(
    interactionHelpersIndex < appIndex,
    'expected interaction_helpers.js to load before app.js',
  );
});

test('selection quote button opts out of sticky control-focus cleanup so quote insertion can leave the composer caret active', () => {
  assert.match(
    templateSource,
    /<button type="button" id="selection-quote-button" class="selection-quote-button" data-skip-control-focus-release="true" hidden>Quote<\/button>/,
    'expected the selection quote button to preserve composer focus after click',
  );
});

test('runtime helper chain and startup bindings load before app.js so bootstrap dependencies exist synchronously', () => {
  const appIndex = indexOfScript('/static/app.js?v={{ app_js_version }}');
  const runtimeAttentionIndex = indexOfScript('/static/runtime_attention_effects.js?v={{ runtime_attention_effects_version }}');
  const runtimeReadStateIndex = indexOfScript('/static/runtime_read_state.js?v={{ runtime_read_state_version }}');
  const runtimeChatHistorySyncIndex = indexOfScript('/static/runtime_chat_history_sync.js?v={{ runtime_chat_history_sync_version }}');
  const runtimeVisibleHistorySyncIndex = indexOfScript('/static/runtime_visible_history_sync.js?v={{ runtime_visible_history_sync_version }}');
  const runtimeHydrationStateIndex = indexOfScript('/static/runtime_hydration_state.js?v={{ runtime_hydration_state_version }}');
  const runtimeHydrationApplyIndex = indexOfScript('/static/runtime_hydration_apply.js?v={{ runtime_hydration_apply_version }}');
  const runtimeVisibleHydrationIndex = indexOfScript('/static/runtime_visible_hydration.js?v={{ runtime_visible_hydration_version }}');
  const runtimeHydrationFlowIndex = indexOfScript('/static/runtime_hydration_flow.js?v={{ runtime_hydration_flow_version }}');
  const runtimeOpenFlowIndex = indexOfScript('/static/runtime_open_flow.js?v={{ runtime_open_flow_version }}');
  const runtimeChatMetaIndex = indexOfScript('/static/runtime_chat_meta.js?v={{ runtime_chat_meta_version }}');
  const runtimeLocalMutationIndex = indexOfScript('/static/runtime_local_mutation.js?v={{ runtime_local_mutation_version }}');
  const runtimeUnreadIndex = indexOfScript('/static/runtime_unread_helpers.js?v={{ runtime_unread_helpers_version }}');
  const runtimeLatencyIndex = indexOfScript('/static/runtime_latency_helpers.js?v={{ runtime_latency_helpers_version }}');
  const runtimeHistoryIndex = indexOfScript('/static/runtime_history_helpers.js?v={{ runtime_history_helpers_version }}');
  const transcriptAuthorityIndex = indexOfScript('/static/runtime_transcript_authority.js?v={{ runtime_transcript_authority_version }}');
  const streamControllerIndex = indexOfScript('/static/stream_controller.js?v={{ stream_controller_version }}');
  const chatHistoryIndex = indexOfScript('/static/chat_history_helpers.js?v={{ chat_history_helpers_version }}');
  const runtimeIndex = indexOfScript('/static/runtime_helpers.js?v={{ helpers_version }}');
  const startupBindingsIndex = indexOfScript('/static/startup_bindings_helpers.js?v={{ startup_bindings_helpers_version }}');

  assert.ok(runtimeAttentionIndex < runtimeReadStateIndex, 'expected runtime_attention_effects.js to load before runtime_read_state.js');
  assert.ok(runtimeAttentionIndex < runtimeChatHistorySyncIndex, 'expected runtime_attention_effects.js to load before runtime_chat_history_sync.js');
  assert.ok(runtimeAttentionIndex < streamControllerIndex, 'expected runtime_attention_effects.js to load before stream_controller.js');
  assert.ok(runtimeAttentionIndex < chatHistoryIndex, 'expected runtime_attention_effects.js to load before chat_history_helpers.js');
  assert.ok(runtimeAttentionIndex < runtimeUnreadIndex, 'expected runtime_attention_effects.js to load before runtime_unread_helpers.js');
  assert.ok(runtimeAttentionIndex < runtimeIndex, 'expected runtime_attention_effects.js to load before runtime_helpers.js');
  assert.ok(runtimeReadStateIndex < runtimeChatHistorySyncIndex, 'expected runtime_read_state.js to load before runtime_chat_history_sync.js');
  assert.ok(runtimeReadStateIndex < chatHistoryIndex, 'expected runtime_read_state.js to load before chat_history_helpers.js');
  assert.ok(runtimeReadStateIndex < runtimeIndex, 'expected runtime_read_state.js to load before runtime_helpers.js');
  assert.ok(runtimeChatHistorySyncIndex < runtimeVisibleHistorySyncIndex, 'expected runtime_chat_history_sync.js to load before runtime_visible_history_sync.js');
  assert.ok(runtimeVisibleHistorySyncIndex < runtimeHydrationStateIndex, 'expected runtime_visible_history_sync.js to load before runtime_hydration_state.js');
  assert.ok(runtimeHydrationStateIndex < runtimeHydrationApplyIndex, 'expected runtime_hydration_state.js to load before runtime_hydration_apply.js');
  assert.ok(runtimeHydrationApplyIndex < runtimeVisibleHydrationIndex, 'expected runtime_hydration_apply.js to load before runtime_visible_hydration.js');
  assert.ok(runtimeVisibleHydrationIndex < runtimeHydrationFlowIndex, 'expected runtime_visible_hydration.js to load before runtime_hydration_flow.js');
  assert.ok(runtimeHydrationFlowIndex < runtimeOpenFlowIndex, 'expected runtime_hydration_flow.js to load before runtime_open_flow.js');
  assert.ok(runtimeOpenFlowIndex < runtimeChatMetaIndex, 'expected runtime_open_flow.js to load before runtime_chat_meta.js');
  assert.ok(runtimeChatMetaIndex < runtimeLocalMutationIndex, 'expected runtime_chat_meta.js to load before runtime_local_mutation.js');
  assert.ok(runtimeVisibleHistorySyncIndex < runtimeHydrationApplyIndex, 'expected runtime_visible_history_sync.js to load before runtime_hydration_apply.js');
  assert.ok(runtimeOpenFlowIndex < chatHistoryIndex, 'expected runtime_open_flow.js to load before chat_history_helpers.js');
  assert.ok(runtimeChatMetaIndex < chatHistoryIndex, 'expected runtime_chat_meta.js to load before chat_history_helpers.js');
  assert.ok(runtimeLocalMutationIndex < chatHistoryIndex, 'expected runtime_local_mutation.js to load before chat_history_helpers.js');
  assert.ok(runtimeHydrationFlowIndex < chatHistoryIndex, 'expected runtime_hydration_flow.js to load before chat_history_helpers.js');
  assert.ok(runtimeVisibleHydrationIndex < chatHistoryIndex, 'expected runtime_visible_hydration.js to load before chat_history_helpers.js');
  assert.ok(runtimeHydrationApplyIndex < chatHistoryIndex, 'expected runtime_hydration_apply.js to load before chat_history_helpers.js');
  assert.ok(runtimeHydrationStateIndex < chatHistoryIndex, 'expected runtime_hydration_state.js to load before chat_history_helpers.js');
  assert.ok(runtimeVisibleHistorySyncIndex < chatHistoryIndex, 'expected runtime_visible_history_sync.js to load before chat_history_helpers.js');
  assert.ok(runtimeChatHistorySyncIndex < chatHistoryIndex, 'expected runtime_chat_history_sync.js to load before chat_history_helpers.js');
  assert.ok(runtimeUnreadIndex < runtimeIndex, 'expected runtime_unread_helpers.js to load before runtime_helpers.js');
  assert.ok(runtimeLatencyIndex < runtimeIndex, 'expected runtime_latency_helpers.js to load before runtime_helpers.js');
  assert.ok(runtimeHistoryIndex < runtimeIndex, 'expected runtime_history_helpers.js to load before runtime_helpers.js');
  assert.ok(transcriptAuthorityIndex < streamControllerIndex, 'expected runtime_transcript_authority.js to load before stream_controller.js');
  assert.ok(transcriptAuthorityIndex < chatHistoryIndex, 'expected runtime_transcript_authority.js to load before chat_history_helpers.js');
  assert.ok(runtimeIndex < appIndex, 'expected runtime_helpers.js to load before app.js');
  assert.ok(startupBindingsIndex < appIndex, 'expected startup_bindings_helpers.js to load before app.js');
});

test('non-critical startup helpers load after app.js', () => {
  const appIndex = indexOfScript('/static/app.js?v={{ app_js_version }}');

  const deferredHelpers = [
    '/static/chat_admin_helpers.js?v={{ chat_admin_helpers_version }}',
    '/static/message_actions_helpers.js?v={{ message_actions_helpers_version }}',
    '/static/keyboard_shortcuts_helpers.js?v={{ keyboard_shortcuts_helpers_version }}',
    '/static/shell_ui_helpers.js?v={{ shell_ui_helpers_version }}',
    '/static/composer_viewport_helpers.js?v={{ composer_viewport_helpers_version }}',
    '/static/file_preview_helpers.js?v={{ file_preview_helpers_version }}',
    '/static/visibility_skin_helpers.js?v={{ visibility_skin_helpers_version }}',
    '/static/visual_dev_shell_helpers.js?v={{ visual_dev_shell_helpers_version }}',
    '/static/visual_dev_preview_helpers.js?v={{ visual_dev_preview_helpers_version }}',
    '/static/visual_dev_mode_helpers.js?v={{ visual_dev_mode_helpers_version }}',
    '/static/visual_dev_attach_helpers.js?v={{ visual_dev_attach_helpers_version }}',
    '/static/visual_dev_prompt_context_helpers.js?v={{ visual_dev_prompt_context_helpers_version }}',
    '/static/visual_dev_bridge.js?v={{ visual_dev_bridge_version }}',
  ];
  deferredHelpers.forEach((fragment) => {
    assert.ok(
      appIndex < indexOfScript(fragment),
      `expected app.js to load before ${fragment}`,
    );
  });
});

test('critical startup scripts are preloaded before deferred execution', () => {
  const preloadFragments = [
    '/static/runtime_transcript_authority.js?v={{ runtime_transcript_authority_version }}',
    '/static/runtime_attention_effects.js?v={{ runtime_attention_effects_version }}',
    '/static/runtime_read_state.js?v={{ runtime_read_state_version }}',
    '/static/runtime_chat_history_sync.js?v={{ runtime_chat_history_sync_version }}',
    '/static/runtime_visible_history_sync.js?v={{ runtime_visible_history_sync_version }}',
    '/static/runtime_hydration_state.js?v={{ runtime_hydration_state_version }}',
    '/static/runtime_hydration_apply.js?v={{ runtime_hydration_apply_version }}',
    '/static/runtime_visible_hydration.js?v={{ runtime_visible_hydration_version }}',
    '/static/runtime_hydration_flow.js?v={{ runtime_hydration_flow_version }}',
    '/static/runtime_open_flow.js?v={{ runtime_open_flow_version }}',
    '/static/runtime_chat_meta.js?v={{ runtime_chat_meta_version }}',
    '/static/runtime_local_mutation.js?v={{ runtime_local_mutation_version }}',
    '/static/stream_controller.js?v={{ stream_controller_version }}',
    '/static/bootstrap_auth_helpers.js?v={{ bootstrap_auth_helpers_version }}',
    '/static/chat_history_helpers.js?v={{ chat_history_helpers_version }}',
    '/static/startup_bindings_helpers.js?v={{ startup_bindings_helpers_version }}',
    '/static/interaction_helpers.js?v={{ interaction_helpers_version }}',
    '/static/startup_metrics_helpers.js?v={{ startup_metrics_helpers_version }}',
    '/static/app.js?v={{ app_js_version }}',
  ];
  preloadFragments.forEach((fragment) => {
    const preloadFragment = `<link rel="preload" as="script" href="${fragment}">`;
    const scriptFragment = `<script defer src="${fragment}"></script>`;
    assert.ok(
      indexOfFragment(preloadFragment) < indexOfScript(fragment),
      `expected preload for ${fragment} to appear before the deferred script tag`,
    );
  });
});
