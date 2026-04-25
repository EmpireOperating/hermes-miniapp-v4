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
  assert.notEqual(index, -1, `expected template fragment: ${fragment}`);
  return index;
}

test('workspace sidebar keeps chat actions and pinned chats above the overview rail', () => {
  const asideStart = indexOfFragment('<aside class="sidebar panel">');
  const actions = indexOfFragment('<div class="chat-actions">');
  const pinned = indexOfFragment('<div class="pinned-chats" id="pinned-chats-wrap" hidden>');
  const overview = indexOfFragment('<div id="chat-tabs-overview" class="chat-tabs__overview" role="toolbar" aria-label="Chat overview" hidden></div>');
  const asideEnd = indexOfFragment('</aside>');
  const terminalStart = indexOfFragment('<section id="chat-terminal-panel" class="panel terminal-panel">');

  assert.ok(actions > asideStart, 'chat actions should stay inside the sidebar');
  assert.ok(pinned > actions, 'pinned chats should render below the action buttons');
  assert.ok(overview > pinned, 'overview rail should render below pinned chats in the sidebar');
  assert.ok(overview < asideEnd, 'overview rail should stay inside the sidebar');
  assert.ok(asideEnd < terminalStart, 'sidebar should remain before the terminal panel');
});

test('workspace preview markup includes a dedicated bottom-right resize handle inside the preview wrap', () => {
  const previewWrap = indexOfFragment('<div id="visual-dev-preview-wrap" class="visual-dev-workspace__preview-wrap">');
  const previewFrame = indexOfFragment('<iframe id="visual-dev-preview-frame" class="visual-dev-workspace__preview" title="Visual dev preview" src="about:blank" loading="lazy" referrerpolicy="strict-origin-when-cross-origin"></iframe>');
  const resizeHandle = indexOfFragment('<button type="button" id="visual-dev-preview-resize-handle" class="visual-dev-workspace__preview-resize-handle" aria-label="Resize workspace preview"></button>');

  assert.ok(previewFrame > previewWrap, 'preview iframe should stay inside the preview wrap');
  assert.ok(resizeHandle > previewFrame, 'resize handle should render after the preview iframe inside the preview wrap');
});

test('workspace layout includes a dedicated vertical resize handle between the left rail and the workspace preview', () => {
  const terminalStart = indexOfFragment('<section id="chat-terminal-panel" class="panel terminal-panel">');
  const sidebarResizeHandle = indexOfFragment('<button type="button" id="visual-dev-sidebar-resize-handle" class="workspace__sidebar-resize-handle" aria-label="Resize workspace sidebar"></button>');
  const visualStart = indexOfFragment('<section id="visual-dev-workspace" class="panel visual-dev-workspace" data-visual-dev-enabled="false" hidden>');

  assert.ok(sidebarResizeHandle > terminalStart, 'sidebar resize handle should render after the terminal panel markup');
  assert.ok(sidebarResizeHandle < visualStart, 'sidebar resize handle should sit before the workspace preview panel');
});
