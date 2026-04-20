import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const previewHelpers = require('../static/visual_dev_preview_helpers.js');

function buildHarness(overrides = {}) {
  const posted = [];
  const listeners = new Map();
  const windowObject = {
    location: { origin: 'https://miniapp.example.com' },
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
    ...overrides.windowObject,
  };
  const frameWindow = {
    postMessage(payload, targetOrigin) {
      posted.push({ payload, targetOrigin });
    },
  };
  const previewFrame = {
    contentWindow: frameWindow,
    src: 'https://preview.example.com/app',
    ...overrides.previewFrame,
  };
  const controller = previewHelpers.createController({
    sessionId: 'session-1',
    previewOrigin: 'https://preview.example.com',
    parentOrigin: 'https://miniapp.example.com',
    previewFrame,
    windowObject,
    onSelection(payload) {
      harness.selections.push(payload);
    },
    onScreenshot(payload) {
      harness.screenshots.push(payload);
    },
    onConsole(payload) {
      harness.consoleEvents.push(payload);
    },
    onRuntime(payload) {
      harness.runtimeEvents.push(payload);
    },
  });
  const harness = {
    controller,
    posted,
    listeners,
    previewFrame,
    windowObject,
    selections: [],
    screenshots: [],
    consoleEvents: [],
    runtimeEvents: [],
  };
  return harness;
}

test('sendHandshake posts connect message to trusted preview origin', () => {
  const harness = buildHarness();

  harness.controller.sendHandshake();

  assert.equal(harness.posted.length, 1);
  assert.deepEqual(harness.posted[0], {
    payload: {
      type: 'hermes-visual-dev:connect',
      sessionId: 'session-1',
      parentOrigin: 'https://miniapp.example.com',
    },
    targetOrigin: 'https://preview.example.com',
  });
});

test('sendCommand posts trusted visual-dev commands into the preview frame', () => {
  const harness = buildHarness();

  harness.controller.sendCommand('inspect-start', { source: 'toolbar' });

  assert.deepEqual(harness.posted[0], {
    payload: {
      type: 'hermes-visual-dev:command',
      sessionId: 'session-1',
      command: 'inspect-start',
      payload: { source: 'toolbar' },
    },
    targetOrigin: 'https://preview.example.com',
  });
});

test('installMessageBridge accepts trusted preview events and routes by type', () => {
  const harness = buildHarness();

  harness.controller.installMessageBridge();
  const handler = harness.listeners.get('message');
  assert.equal(typeof handler, 'function');

  handler({
    origin: 'https://preview.example.com',
    data: {
      type: 'hermes-visual-dev:selection',
      sessionId: 'session-1',
      selection: { label: 'Play button' },
    },
  });
  handler({
    origin: 'https://preview.example.com',
    data: {
      type: 'hermes-visual-dev:screenshot',
      sessionId: 'session-1',
      screenshot: { label: 'viewport capture' },
    },
  });
  handler({
    origin: 'https://preview.example.com',
    data: {
      type: 'hermes-visual-dev:console',
      sessionId: 'session-1',
      consoleEvent: { level: 'error' },
    },
  });
  handler({
    origin: 'https://preview.example.com',
    data: {
      type: 'hermes-visual-dev:runtime',
      sessionId: 'session-1',
      runtime: { state: 'reloading' },
    },
  });

  assert.deepEqual(harness.selections, [{ label: 'Play button' }]);
  assert.deepEqual(harness.screenshots, [{ label: 'viewport capture' }]);
  assert.deepEqual(harness.consoleEvents, [{ level: 'error' }]);
  assert.deepEqual(harness.runtimeEvents, [{ state: 'reloading' }]);
});

test('installMessageBridge ignores unexpected origin and mismatched session', () => {
  const harness = buildHarness();

  harness.controller.installMessageBridge();
  const handler = harness.listeners.get('message');
  handler({
    origin: 'https://evil.example.com',
    data: {
      type: 'hermes-visual-dev:selection',
      sessionId: 'session-1',
      selection: { label: 'Evil button' },
    },
  });
  handler({
    origin: 'https://preview.example.com',
    data: {
      type: 'hermes-visual-dev:selection',
      sessionId: 'session-2',
      selection: { label: 'Wrong session' },
    },
  });

  assert.deepEqual(harness.selections, []);
});

test('dispose removes installed message listener', () => {
  const harness = buildHarness();
  harness.controller.installMessageBridge();
  assert.equal(harness.listeners.has('message'), true);

  harness.controller.dispose();

  assert.equal(harness.listeners.has('message'), false);
});
