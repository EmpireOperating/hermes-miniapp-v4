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

test('non-critical startup helpers load after app.js', () => {
  const appIndex = indexOfScript('/static/app.js?v={{ app_js_version }}');

  const deferredHelpers = [
    '/static/chat_admin_helpers.js?v={{ chat_admin_helpers_version }}',
    '/static/interaction_helpers.js?v={{ interaction_helpers_version }}',
    '/static/message_actions_helpers.js?v={{ message_actions_helpers_version }}',
    '/static/keyboard_shortcuts_helpers.js?v={{ keyboard_shortcuts_helpers_version }}',
    '/static/shell_ui_helpers.js?v={{ shell_ui_helpers_version }}',
    '/static/composer_viewport_helpers.js?v={{ composer_viewport_helpers_version }}',
    '/static/file_preview_helpers.js?v={{ file_preview_helpers_version }}',
    '/static/visibility_skin_helpers.js?v={{ visibility_skin_helpers_version }}',
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
    '/static/stream_controller.js?v={{ stream_controller_version }}',
    '/static/bootstrap_auth_helpers.js?v={{ bootstrap_auth_helpers_version }}',
    '/static/chat_history_helpers.js?v={{ chat_history_helpers_version }}',
    '/static/startup_bindings_helpers.js?v={{ startup_bindings_helpers_version }}',
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
