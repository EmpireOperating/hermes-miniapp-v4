import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bridge = require('../static/visual_dev_bridge.js');

function buildHarness(overrides = {}) {
  const posted = [];
  const listeners = new Map();
  const documentListeners = new Map();
  const windowObject = {
    location: {
      href: 'https://preview.example.com/app',
      origin: 'https://preview.example.com',
    },
    parent: {
      postMessage(payload, targetOrigin) {
        posted.push({ payload, targetOrigin });
      },
    },
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
    ...overrides.windowObject,
  };
  const documentObject = {
    title: 'Preview title',
    documentElement: {
      dataset: {},
    },
    addEventListener(type, handler, options) {
      documentListeners.set(type, { handler, options });
    },
    removeEventListener(type) {
      documentListeners.delete(type);
    },
    ...overrides.documentObject,
  };
  const controller = bridge.createController({
    windowObject,
    documentObject,
    captureScreenshot: overrides.captureScreenshot,
  });
  return {
    controller,
    posted,
    listeners,
    documentListeners,
    windowObject,
    documentObject,
  };
}

test('handleConnect stores session metadata and posts ready handshake', () => {
  const harness = buildHarness();
  harness.controller.install();
  const messageHandler = harness.listeners.get('message');

  messageHandler({
    origin: 'https://miniapp.example.com',
    data: {
      type: 'hermes-visual-dev:connect',
      sessionId: 'session-1',
      parentOrigin: 'https://miniapp.example.com',
    },
  });

  assert.equal(harness.documentObject.documentElement.dataset.visualDevSessionId, 'session-1');
  assert.deepEqual(harness.posted, [{
    payload: {
      type: 'hermes-visual-dev:ready',
      sessionId: 'session-1',
      previewUrl: 'https://preview.example.com/app',
      previewTitle: 'Preview title',
    },
    targetOrigin: 'https://miniapp.example.com',
  }]);
});

test('reportSelection and reportConsole forward typed payloads after connect', () => {
  const harness = buildHarness();
  harness.controller.install();
  harness.controller.handleConnect({
    sessionId: 'session-1',
    parentOrigin: 'https://miniapp.example.com',
  });

  harness.controller.reportSelection({ label: 'Play button' });
  harness.controller.reportConsole({ level: 'warn', message: 'Hot reload fallback' });

  assert.deepEqual(harness.posted.slice(0, 2), [
    {
      payload: {
        type: 'hermes-visual-dev:ready',
        sessionId: 'session-1',
        previewUrl: 'https://preview.example.com/app',
        previewTitle: 'Preview title',
      },
      targetOrigin: 'https://miniapp.example.com',
    },
    {
      payload: {
        type: 'hermes-visual-dev:selection',
        sessionId: 'session-1',
        selection: { label: 'Play button' },
      },
      targetOrigin: 'https://miniapp.example.com',
    },
  ]);
  assert.deepEqual(harness.posted[2], {
    payload: {
      type: 'hermes-visual-dev:console',
      sessionId: 'session-1',
      consoleEvent: { level: 'warn', message: 'Hot reload fallback' },
    },
    targetOrigin: 'https://miniapp.example.com',
  });
});

test('reportScreenshot sends screenshot envelope only after connect', () => {
  const harness = buildHarness();

  harness.controller.reportScreenshot({ label: 'viewport capture' });
  assert.equal(harness.posted.length, 0);

  harness.controller.handleConnect({
    sessionId: 'session-1',
    parentOrigin: 'https://miniapp.example.com',
  });
  harness.controller.reportScreenshot({ label: 'viewport capture' });

  assert.deepEqual(harness.posted.at(-1), {
    payload: {
      type: 'hermes-visual-dev:screenshot',
      sessionId: 'session-1',
      screenshot: { label: 'viewport capture' },
    },
    targetOrigin: 'https://miniapp.example.com',
  });
});

test('trusted command message starts inspect mode and reports clicked element metadata', () => {
  const target = {
    tagName: 'BUTTON',
    id: 'play-button',
    className: 'cta primary',
    textContent: 'Play now',
    closest() { return this; },
    getAttribute(name) { return name === 'aria-label' ? 'Play' : null; },
    getBoundingClientRect() {
      return { left: 10, top: 20, width: 120, height: 48 };
    },
  };
  const harness = buildHarness();
  harness.controller.install();
  harness.controller.handleConnect({
    sessionId: 'session-1',
    parentOrigin: 'https://miniapp.example.com',
  });

  const windowMessageHandler = harness.listeners.get('message');
  windowMessageHandler({
    origin: 'https://miniapp.example.com',
    data: {
      type: 'hermes-visual-dev:command',
      sessionId: 'session-1',
      command: 'inspect-start',
      payload: { source: 'toolbar' },
    },
  });

  const clickHandler = harness.documentListeners.get('click')?.handler;
  assert.equal(typeof clickHandler, 'function');
  clickHandler({
    preventDefault() {},
    stopPropagation() {},
    target,
  });

  assert.equal(harness.documentListeners.has('click'), false);
  assert.deepEqual(harness.posted.at(-1), {
    payload: {
      type: 'hermes-visual-dev:selection',
      sessionId: 'session-1',
      selection: {
        label: 'Play',
        selector: '#play-button',
        tagName: 'button',
        text: 'Play now',
        rect: { left: 10, top: 20, width: 120, height: 48 },
        source: 'toolbar',
      },
    },
    targetOrigin: 'https://miniapp.example.com',
  });
});

test('trusted command message captures screenshot via injected hook and reports the artifact payload', async () => {
  const harness = buildHarness({
    captureScreenshot: async () => ({
      contentType: 'image/png',
      bytesB64: 'Zm9v',
      label: 'viewport capture',
    }),
  });
  harness.controller.install();
  harness.controller.handleConnect({
    sessionId: 'session-1',
    parentOrigin: 'https://miniapp.example.com',
  });

  const windowMessageHandler = harness.listeners.get('message');
  await windowMessageHandler({
    origin: 'https://miniapp.example.com',
    data: {
      type: 'hermes-visual-dev:command',
      sessionId: 'session-1',
      command: 'capture-full',
      payload: { source: 'toolbar', capture: 'full' },
    },
  });

  assert.deepEqual(harness.posted.at(-1), {
    payload: {
      type: 'hermes-visual-dev:screenshot',
      sessionId: 'session-1',
      screenshot: {
        contentType: 'image/png',
        bytesB64: 'Zm9v',
        label: 'viewport capture',
        source: 'toolbar',
        capture: 'full',
      },
    },
    targetOrigin: 'https://miniapp.example.com',
  });
});

test('trusted command message captures a region screenshot and preserves region metadata', async () => {
  const captureCalls = [];
  const harness = buildHarness({
    captureScreenshot: async (payload) => {
      captureCalls.push(payload);
      return {
        contentType: 'image/png',
        bytesB64: 'YmFy',
        label: 'toolbar region',
      };
    },
  });
  harness.controller.install();
  harness.controller.handleConnect({
    sessionId: 'session-1',
    parentOrigin: 'https://miniapp.example.com',
  });

  const windowMessageHandler = harness.listeners.get('message');
  await windowMessageHandler({
    origin: 'https://miniapp.example.com',
    data: {
      type: 'hermes-visual-dev:command',
      sessionId: 'session-1',
      command: 'capture-region',
      payload: {
        source: 'toolbar',
        capture: 'region',
        region: { left: 10, top: 20, width: 120, height: 48 },
      },
    },
  });

  assert.deepEqual(captureCalls, [{
    source: 'toolbar',
    capture: 'region',
    region: { left: 10, top: 20, width: 120, height: 48 },
  }]);
  assert.deepEqual(harness.posted.at(-1), {
    payload: {
      type: 'hermes-visual-dev:screenshot',
      sessionId: 'session-1',
      screenshot: {
        contentType: 'image/png',
        bytesB64: 'YmFy',
        label: 'toolbar region',
        source: 'toolbar',
        capture: 'region',
        region: { left: 10, top: 20, width: 120, height: 48 },
      },
    },
    targetOrigin: 'https://miniapp.example.com',
  });
});
