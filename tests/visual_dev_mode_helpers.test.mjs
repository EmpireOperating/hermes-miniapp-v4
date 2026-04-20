import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const visualDevModeHelpers = require('../static/visual_dev_mode_helpers.js');

function createHarness({
  enabled = true,
  authenticated = true,
  activeChatId = 11,
  statePayload = {
    ok: true,
    enabled: true,
    sessions: [
      {
        session_id: 'session-11',
        chat_id: 11,
        preview_url: 'https://preview.example.com/app',
        preview_origin: 'https://preview.example.com',
        bridge_parent_origin: 'https://miniapp.example.com',
        preview_title: 'Demo preview',
        runtime: { state: 'connecting' },
      },
    ],
  },
  sessionDetailsByChatId = {
    11: {
      ok: true,
      session: {
        session_id: 'session-11',
        chat_id: 11,
        runtime: { state: 'connecting', message: 'Booting preview' },
      },
      latest_selection: { payload: { label: 'Toolbar' } },
      artifacts: [{ storage_path: '/tmp/cap.png' }],
      console_events: [{ level: 'info', message: 'Preview booting' }],
    },
  },
  getParentOrigin = () => 'https://miniapp.example.com',
} = {}) {
  let currentStatePayload = statePayload;
  const shellCalls = [];
  const previewCreations = [];
  const apiGetCalls = [];
  const apiPostCalls = [];
  const loadHandlers = [];
  let disposedPreviewCount = 0;
  const previewFrame = {
    addEventListener(type, handler) {
      if (type === 'load') {
        loadHandlers.push(handler);
      }
    },
    removeEventListener() {},
    contentWindow: {
      postMessage() {},
    },
  };
  const shellController = {
    applySessionState(session) {
      shellCalls.push(['applySessionState', session]);
    },
    applySelectionSummary(selection) {
      shellCalls.push(['applySelectionSummary', selection]);
    },
    applyScreenshotSummary(screenshot) {
      shellCalls.push(['applyScreenshotSummary', screenshot]);
    },
    applySessionDetails(details) {
      shellCalls.push(['applySessionDetails', details]);
    },
    appendConsoleEvent(event) {
      shellCalls.push(['appendConsoleEvent', event]);
    },
    applyRuntimeSummary(runtime) {
      shellCalls.push(['applyRuntimeSummary', runtime]);
    },
    clearSessionState() {
      shellCalls.push(['clearSessionState']);
    },
  };
  const previewHelpers = {
    createController(deps) {
      previewCreations.push(deps);
      return {
        installMessageBridge() {
          deps.__installed = true;
        },
        sendHandshake() {
          deps.__handshakeCount = (deps.__handshakeCount || 0) + 1;
        },
        sendCommand(command, payload) {
          deps.__commands = deps.__commands || [];
          deps.__commands.push([command, payload]);
        },
        dispose() {
          disposedPreviewCount += 1;
        },
      };
    },
  };
  const controller = visualDevModeHelpers.createController({
    config: {
      enabled,
      allowedPreviewOrigins: ['https://preview.example.com'],
      allowedParentOrigins: ['https://miniapp.example.com'],
    },
    shellHelpers: {
      createController() {
        return shellController;
      },
    },
    previewHelpers,
    shellRoot: {},
    previewFrame,
    ownershipLabel: {},
    statusLabel: {},
    selectionChip: {},
    screenshotChip: {},
    getIsAuthenticated: () => authenticated,
    getActiveChatId: () => activeChatId,
    getParentOrigin,
    chatLabelForId: (chatId) => `Chat ${chatId}`,
    apiGetJson: async (url) => {
      apiGetCalls.push(url);
      if (url === '/api/visual-dev/state') {
        return currentStatePayload;
      }
      const detailsMatch = String(url).match(/^\/api\/visual-dev\/session\/(\d+)$/);
      if (detailsMatch) {
        const chatId = Number(detailsMatch[1]);
        return sessionDetailsByChatId[chatId] || {
          ok: true,
          session: { session_id: `session-${chatId}`, chat_id: chatId, runtime: { state: 'disconnected' } },
          latest_selection: null,
          artifacts: [],
          console_events: [],
        };
      }
      throw new Error(`Unexpected apiGetJson URL: ${url}`);
    },
    apiPost: async (url, payload) => {
      apiPostCalls.push([url, payload]);
      if (url.endsWith('/attach')) {
        const attachedSession = {
          session_id: payload.session_id,
          chat_id: payload.chat_id,
          preview_url: payload.preview_url,
          preview_origin: 'https://preview.example.com',
          bridge_parent_origin: payload.bridge_parent_origin,
          preview_title: payload.preview_title,
          runtime: { state: 'connecting' },
        };
        currentStatePayload = { ok: true, enabled: true, sessions: [attachedSession] };
        return { ok: true, session: attachedSession };
      }
      if (url.endsWith('/detach')) {
        currentStatePayload = { ok: true, enabled: true, sessions: [] };
        return { ok: true, session_id: payload.session_id };
      }
      if (url.endsWith('/select')) {
        return { ok: true, selection: { selection_type: payload.selection_type, payload: payload.payload } };
      }
      if (url.endsWith('/screenshot')) {
        return { ok: true, artifact: { artifact_kind: 'screenshot', storage_path: '/tmp/cap.png' } };
      }
      if (url.endsWith('/console')) {
        return { ok: true, accepted: true, runtime: { state: 'runtime_error', accepted: true } };
      }
      if (url.endsWith('/command')) {
        return { ok: true, runtime: { state: payload.command === 'bridge-ready' ? 'live' : 'reloading' } };
      }
      throw new Error(`Unexpected apiPost URL: ${url}`);
    },
    onUiError(error) {
      shellCalls.push(['error', String(error?.message || error)]);
    },
  });
  return {
    controller,
    shellCalls,
    previewCreations,
    apiGetCalls,
    apiPostCalls,
    loadHandlers,
    getDisposedPreviewCount: () => disposedPreviewCount,
  };
}

test('bootstrap fetches visual-dev state, session details, and applies the active chat session', async () => {
  const harness = createHarness();

  const payload = await harness.controller.bootstrap();

  assert.equal(payload.ok, true);
  assert.deepEqual(harness.apiGetCalls, ['/api/visual-dev/state', '/api/visual-dev/session/11']);
  assert.equal(harness.previewCreations.length, 1);
  assert.equal(harness.previewCreations[0].sessionId, 'session-11');
  assert.equal(harness.previewCreations[0].previewOrigin, 'https://preview.example.com');
  assert.equal(harness.previewCreations[0].parentOrigin, 'https://miniapp.example.com');
  assert.match(
    JSON.stringify(harness.shellCalls),
    /Chat 11/,
    'bootstrap should label preview ownership with the active chat',
  );
  assert.ok(
    harness.shellCalls.some(([name, payload]) => name === 'applySessionDetails' && payload.console_events?.[0]?.message === 'Preview booting'),
    'bootstrap should hydrate the drawer with recent console events for the active session',
  );
});

test('selection, screenshot, console, and runtime bridge events post back to visual-dev APIs and refresh live drawer state', async () => {
  const harness = createHarness();
  await harness.controller.bootstrap();
  const previewDeps = harness.previewCreations[0];

  await previewDeps.onSelection({ selector: '#toolbar', label: 'Toolbar' });
  await previewDeps.onScreenshot({
    contentType: 'image/png',
    bytesB64: 'Zm9v',
    label: 'toolbar',
    capture: 'region',
    region: { left: 10, top: 20, width: 120, height: 48 },
  });
  await previewDeps.onConsole({ level: 'error', message: 'Build exploded', source: 'vite' });
  await previewDeps.onRuntime({ type: 'hermes-visual-dev:ready', previewUrl: 'https://preview.example.com/app', previewTitle: 'Live preview' });

  assert.deepEqual(harness.apiPostCalls[0], [
    '/api/visual-dev/session/select',
    {
      session_id: 'session-11',
      selection_type: 'dom',
      payload: { selector: '#toolbar', label: 'Toolbar' },
    },
  ]);
  assert.deepEqual(harness.apiPostCalls[1], [
    '/api/visual-dev/session/screenshot',
    {
      session_id: 'session-11',
      content_type: 'image/png',
      bytes_b64: 'Zm9v',
      metadata: {
        label: 'toolbar',
        capture: 'region',
        region: { left: 10, top: 20, width: 120, height: 48 },
      },
    },
  ]);
  assert.deepEqual(harness.apiPostCalls[2], [
    '/api/visual-dev/session/console',
    {
      session_id: 'session-11',
      event_type: 'console',
      level: 'error',
      message: 'Build exploded',
      metadata: { source: 'vite' },
    },
  ]);
  assert.deepEqual(harness.apiPostCalls[3], [
    '/api/visual-dev/session/command',
    {
      session_id: 'session-11',
      command: 'bridge-ready',
      payload: { preview_url: 'https://preview.example.com/app', preview_title: 'Live preview' },
    },
  ]);
  assert.ok(
    harness.shellCalls.some(([name, payload]) => name === 'applySelectionSummary' && payload.selector === '#toolbar'),
    'selection bridge events should update the shell summary',
  );
  assert.ok(
    harness.shellCalls.some(([name, payload]) => name === 'applyScreenshotSummary' && payload.storage_path === '/tmp/cap.png'),
    'screenshot bridge events should update the shell summary with the saved artifact',
  );
  assert.ok(
    harness.shellCalls.some(([name, payload]) => name === 'appendConsoleEvent' && payload.message === 'Build exploded'),
    'console bridge events should append into the live drawer',
  );
  assert.ok(
    harness.shellCalls.some(([name, payload]) => name === 'applyRuntimeSummary' && payload.state === 'runtime_error'),
    'console bridge events should refresh runtime summary in the drawer',
  );
  assert.ok(
    harness.shellCalls.some(([name, payload]) => name === 'applyRuntimeSummary' && payload.state === 'live'),
    'ready bridge events should refresh runtime summary in the drawer',
  );
});

test('attachSession posts attach payload for the active chat, refreshes state, and binds the new preview session', async () => {
  const harness = createHarness({
    activeChatId: 22,
    statePayload: { ok: true, enabled: true, sessions: [] },
  });

  const response = await harness.controller.attachSession({
    previewUrl: 'https://preview.example.com/dev',
    previewTitle: 'Dev preview',
  });

  assert.equal(response.ok, true);
  assert.equal(harness.apiPostCalls[0][0], '/api/visual-dev/session/attach');
  assert.equal(harness.apiPostCalls[0][1].chat_id, 22);
  assert.equal(harness.apiPostCalls[0][1].preview_url, 'https://preview.example.com/dev');
  assert.equal(harness.apiPostCalls[0][1].preview_title, 'Dev preview');
  assert.equal(harness.apiPostCalls[0][1].bridge_parent_origin, 'https://miniapp.example.com');
  assert.match(String(harness.apiPostCalls[0][1].session_id), /^visual-dev-22-/);
  assert.deepEqual(harness.apiGetCalls, ['/api/visual-dev/state', '/api/visual-dev/session/22']);
  assert.equal(harness.previewCreations.at(-1)?.sessionId, harness.apiPostCalls[0][1].session_id);
});

test('requestInspectMode, requestScreenshot, and requestRegionScreenshot dispatch preview commands for the active session', async () => {
  const harness = createHarness({
    sessionDetailsByChatId: {
      11: {
        ok: true,
        session: {
          session_id: 'session-11',
          chat_id: 11,
          runtime: { state: 'connecting', message: 'Booting preview' },
        },
        latest_selection: {
          payload: {
            selector: '#toolbar',
            label: 'Toolbar',
            rect: { left: 10, top: 20, width: 120, height: 48 },
          },
        },
        artifacts: [{ storage_path: '/tmp/cap.png' }],
        console_events: [{ level: 'info', message: 'Preview booting' }],
      },
    },
  });
  await harness.controller.bootstrap();

  harness.controller.requestInspectMode();
  harness.controller.requestScreenshot();
  harness.controller.requestRegionScreenshot();

  assert.deepEqual(harness.previewCreations[0].__commands, [
    ['inspect-start', { source: 'toolbar' }],
    ['capture-full', { source: 'toolbar', capture: 'full' }],
    ['capture-region', {
      source: 'toolbar',
      capture: 'region',
      selector: '#toolbar',
      label: 'Toolbar',
      region: { left: 10, top: 20, width: 120, height: 48 },
    }],
  ]);
});

test('syncActiveChatSession swaps preview ownership, reloads drawer details, and clears when the active chat has no attached session', async () => {
  const harness = createHarness({
    activeChatId: 11,
    statePayload: {
      ok: true,
      enabled: true,
      sessions: [
        {
          session_id: 'session-11',
          chat_id: 11,
          preview_url: 'https://preview.example.com/app-11',
          preview_origin: 'https://preview.example.com',
          bridge_parent_origin: 'https://miniapp.example.com',
          preview_title: 'Preview 11',
          runtime: { state: 'live' },
        },
        {
          session_id: 'session-22',
          chat_id: 22,
          preview_url: 'https://preview.example.com/app-22',
          preview_origin: 'https://preview.example.com',
          bridge_parent_origin: 'https://miniapp.example.com',
          preview_title: 'Preview 22',
          runtime: { state: 'connecting' },
        },
      ],
    },
    sessionDetailsByChatId: {
      11: {
        ok: true,
        session: { session_id: 'session-11', chat_id: 11, runtime: { state: 'live', message: 'Ready' } },
        latest_selection: null,
        artifacts: [],
        console_events: [{ level: 'info', message: 'Preview 11 ready' }],
      },
      22: {
        ok: true,
        session: { session_id: 'session-22', chat_id: 22, runtime: { state: 'connecting', message: 'Booting' } },
        latest_selection: null,
        artifacts: [],
        console_events: [{ level: 'warn', message: 'Preview 22 reconnecting' }],
      },
    },
  });

  await harness.controller.bootstrap();
  harness.controller.setActiveChatGetter(() => 22);
  await harness.controller.syncActiveChatSession();
  harness.controller.setActiveChatGetter(() => 999);
  await harness.controller.syncActiveChatSession();

  assert.equal(harness.previewCreations.length, 2);
  assert.equal(harness.previewCreations[1].sessionId, 'session-22');
  assert.ok(
    harness.apiGetCalls.includes('/api/visual-dev/session/22'),
    'switching chats should reload drawer details for the new preview owner',
  );
  assert.ok(
    harness.shellCalls.some(([name, payload]) => name === 'applySessionDetails' && payload.console_events?.[0]?.message === 'Preview 22 reconnecting'),
    'drawer details should follow the newly active preview session',
  );
  assert.equal(harness.getDisposedPreviewCount(), 2);
  assert.ok(
    harness.shellCalls.some(([name]) => name === 'clearSessionState'),
    'controller should clear the shell when no session is attached to the active chat',
  );
});
