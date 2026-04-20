import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const shellHelpers = require('../static/visual_dev_shell_helpers.js');

function createElement() {
  return {
    attributes: new Map(),
    textContent: '',
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    },
    removeAttribute(name) {
      this.attributes.delete(name);
    },
  };
}

function buildHarness(overrides = {}) {
  const shellRoot = createElement();
  const previewFrame = createElement();
  previewFrame.src = '';
  const ownershipLabel = createElement();
  const statusLabel = createElement();
  const selectionChip = createElement();
  const screenshotChip = createElement();
  const composerSelectionChip = createElement();
  composerSelectionChip.hidden = true;
  const composerScreenshotChip = createElement();
  composerScreenshotChip.hidden = true;
  const consoleDrawer = createElement();
  consoleDrawer.hidden = true;
  const runtimeSummary = createElement();
  const consoleList = createElement();

  const controller = shellHelpers.createController({
    shellRoot,
    previewFrame,
    ownershipLabel,
    statusLabel,
    selectionChip,
    screenshotChip,
    composerSelectionChip,
    composerScreenshotChip,
    consoleDrawer,
    runtimeSummary,
    consoleList,
    initialEnabled: Boolean(overrides.initialEnabled),
  });

  return {
    controller,
    shellRoot,
    previewFrame,
    ownershipLabel,
    statusLabel,
    selectionChip,
    screenshotChip,
    composerSelectionChip,
    composerScreenshotChip,
    consoleDrawer,
    runtimeSummary,
    consoleList,
  };
}

test('setEnabled toggles shell dataset visibility state', () => {
  const harness = buildHarness();

  harness.controller.setEnabled(true);
  assert.equal(harness.shellRoot.attributes.get('data-visual-dev-enabled'), 'true');

  harness.controller.setEnabled(false);
  assert.equal(harness.shellRoot.attributes.get('data-visual-dev-enabled'), 'false');
});

test('applySessionState syncs preview src ownership and status text', () => {
  const harness = buildHarness();

  harness.controller.applySessionState({
    enabled: true,
    chatId: 73,
    chatLabel: '[feat]Super app',
    sessionId: 'session-1',
    previewUrl: 'https://preview.example.com/app',
    runtime: { state: 'live' },
  });

  assert.equal(harness.shellRoot.attributes.get('data-visual-dev-enabled'), 'true');
  assert.equal(harness.previewFrame.src, 'https://preview.example.com/app');
  assert.equal(harness.ownershipLabel.textContent, '[feat]Super app');
  assert.equal(harness.ownershipLabel.attributes.get('data-chat-id'), '73');
  assert.equal(harness.statusLabel.textContent, 'live');
});

test('applySelectionSummary and applyScreenshotSummary populate workspace and composer-adjacent context chips', () => {
  const harness = buildHarness({ initialEnabled: true });

  harness.controller.applySelectionSummary({
    selectionType: 'dom',
    label: 'Play button',
  });
  harness.controller.applyScreenshotSummary({
    label: 'viewport capture',
  });

  assert.equal(harness.selectionChip.textContent, 'Selected: Play button');
  assert.equal(harness.screenshotChip.textContent, 'Screenshot: viewport capture');
  assert.equal(harness.composerSelectionChip.textContent, 'UI context: Play button');
  assert.equal(harness.composerScreenshotChip.textContent, 'Screenshot context: viewport capture');
  assert.equal(harness.composerSelectionChip.hidden, false);
  assert.equal(harness.composerScreenshotChip.hidden, false);
});

test('applySessionDetails renders runtime summary and recent console events into the drawer', () => {
  const harness = buildHarness({ initialEnabled: true });

  harness.controller.applySessionDetails({
    session: {
      runtime: { state: 'build_failed', message: 'Vite compile failed' },
    },
    console_events: [
      { level: 'error', message: 'Build exploded', event_type: 'console' },
      { level: 'info', message: 'Rebuilding…', event_type: 'console' },
    ],
  });

  assert.equal(harness.runtimeSummary.textContent, 'Runtime: build_failed — Vite compile failed');
  assert.equal(harness.consoleDrawer.hidden, false);
  assert.equal(harness.consoleDrawer.attributes.get('data-open'), 'true');
  assert.equal(harness.consoleDrawer.attributes.get('data-severity'), 'error');
  assert.match(harness.consoleList.textContent, /ERROR: Build exploded/);
  assert.match(harness.consoleList.textContent, /INFO: Rebuilding/);
});

test('appendConsoleEvent auto-opens the drawer on error severity and tracks drawer severity state', () => {
  const harness = buildHarness({ initialEnabled: true });

  harness.controller.appendConsoleEvent({ level: 'warn', message: 'Retrying websocket', event_type: 'console' });
  assert.equal(harness.consoleDrawer.hidden, true);
  assert.equal(harness.consoleDrawer.attributes.get('data-severity'), 'warn');

  harness.controller.appendConsoleEvent({ level: 'error', message: 'Build exploded', event_type: 'console' });

  assert.equal(harness.consoleDrawer.hidden, false);
  assert.equal(harness.consoleDrawer.attributes.get('data-open'), 'true');
  assert.equal(harness.consoleDrawer.attributes.get('data-severity'), 'error');
  assert.match(harness.consoleList.textContent, /ERROR: Build exploded/);

  harness.controller.toggleConsoleDrawer(false);
  assert.equal(harness.consoleDrawer.hidden, true);
  assert.equal(harness.consoleDrawer.attributes.get('data-open'), 'false');
});

test('clearSessionState resets preview frame, summaries, and drawer state', () => {
  const harness = buildHarness({ initialEnabled: true });
  harness.controller.applySessionState({
    enabled: true,
    chatId: 73,
    chatLabel: '[feat]Super app',
    sessionId: 'session-1',
    previewUrl: 'https://preview.example.com/app',
    runtime: { state: 'live' },
  });
  harness.controller.applySelectionSummary({ selectionType: 'dom', label: 'Play button' });
  harness.controller.applyScreenshotSummary({ label: 'viewport capture' });
  harness.controller.applySessionDetails({
    session: { runtime: { state: 'live', message: 'Ready' } },
    console_events: [{ level: 'info', message: 'Preview live' }],
  });
  harness.controller.toggleConsoleDrawer(true);

  harness.controller.clearSessionState();

  assert.equal(harness.previewFrame.src, 'about:blank');
  assert.equal(harness.statusLabel.textContent, 'idle');
  assert.equal(harness.selectionChip.textContent, 'Selected: none');
  assert.equal(harness.screenshotChip.textContent, 'Screenshot: none');
  assert.equal(harness.composerSelectionChip.textContent, 'UI context: none');
  assert.equal(harness.composerScreenshotChip.textContent, 'Screenshot context: none');
  assert.equal(harness.composerSelectionChip.hidden, true);
  assert.equal(harness.composerScreenshotChip.hidden, true);
  assert.equal(harness.runtimeSummary.textContent, 'Runtime: idle');
  assert.equal(harness.consoleList.textContent, 'No console events yet.');
  assert.equal(harness.consoleDrawer.hidden, true);
  assert.equal(harness.consoleDrawer.attributes.get('data-severity'), 'info');
  assert.equal(harness.shellRoot.attributes.get('data-visual-dev-enabled'), 'false');
});
