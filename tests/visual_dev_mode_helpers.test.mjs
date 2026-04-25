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
  mediaEditorUrlForChat = null,
  previewUrlForSession = null,
} = {}) {
  let currentStatePayload = statePayload;
  const shellCalls = [];
  const shellCreateDeps = [];
  const previewCreations = [];
  const apiGetCalls = [];
  const apiPostCalls = [];
  const bridgeCaptureCalls = [];
  const bridgeCaptureOptions = [];
  const loadHandlers = [];
  let disposedPreviewCount = 0;
  const previewFramesBySessionId = new Map();
  let activePreviewFrame = null;
  const previewFrame = {
    id: 'base-preview-frame',
    addEventListener(type, handler) {
      if (type === 'load') {
        loadHandlers.push(handler);
      }
    },
    removeEventListener() {},
    contentWindow: {
      postMessage() {},
      document: {
        documentElement: { outerHTML: '<body><main>Base preview</main></body>' },
      },
      innerWidth: 640,
      innerHeight: 360,
    },
  };
  activePreviewFrame = previewFrame;
  let workspaceOpen = false;
  const shellController = {
    applySessionState(session) {
      const sessionId = String(session?.sessionId || session?.session_id || '');
      if (sessionId) {
        if (!previewFramesBySessionId.has(sessionId)) {
          previewFramesBySessionId.set(sessionId, {
            id: `frame-${sessionId}`,
            addEventListener(type, handler) {
              if (type === 'load') {
                loadHandlers.push(handler);
              }
            },
            removeEventListener() {},
            contentWindow: {
              postMessage() {},
              document: {
                documentElement: { outerHTML: `<body><main>${sessionId}</main></body>` },
              },
              innerWidth: 640,
              innerHeight: 360,
            },
          });
        }
        activePreviewFrame = previewFramesBySessionId.get(sessionId);
      }
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
    clearSessionState(options = {}) {
      activePreviewFrame = previewFrame;
      shellCalls.push(['clearSessionState', options]);
    },
    invalidateSessionPreview(sessionId) {
      previewFramesBySessionId.delete(String(sessionId || ''));
      shellCalls.push(['invalidateSessionPreview', String(sessionId || '')]);
    },
    getActivePreviewFrame() {
      return activePreviewFrame;
    },
    getActivePreviewRegion() {
      return { left: 24, top: 48, width: 640, height: 360 };
    },
    toggleWorkspace(forceOpen = null) {
      workspaceOpen = forceOpen == null ? !workspaceOpen : Boolean(forceOpen);
      shellCalls.push(['toggleWorkspace', workspaceOpen]);
      return workspaceOpen;
    },
    isWorkspaceOpen() {
      return workspaceOpen;
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
  globalThis.HermesMiniappVisualDevBridge = {
    captureDocumentScreenshot: async (payload, options = {}) => {
      bridgeCaptureCalls.push(payload);
      bridgeCaptureOptions.push(options);
      return {
        contentType: 'image/png',
        bytesB64: 'YmFy',
        width: Number(payload?.region?.width || 0) || Number(options?.windowObject?.innerWidth || 0) || 640,
        height: Number(payload?.region?.height || 0) || Number(options?.windowObject?.innerHeight || 0) || 360,
        label: 'workspace preview screenshot',
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
      createController(deps) {
        shellCreateDeps.push(deps);
        return shellController;
      },
    },
    previewHelpers,
    appShell: {},
    workspaceRoot: {},
    shellRoot: {},
    toggleButton: {},
    previewWrap: {},
    sidebarResizeHandle: {},
    previewResizeHandle: {},
    previewFrame,
    ownershipLabel: {},
    statusLabel: {},
    selectionChip: {},
    screenshotChip: {},
    composerSelectionChip: {},
    composerScreenshotChip: {},
    composerPreviewChip: {},
    composerConsoleChip: {},
    onWorkspaceOpenChange() {},
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
          preview_origin: String(payload.preview_url || '').startsWith('https://miniapp.example.com') ? 'https://miniapp.example.com' : 'https://preview.example.com',
          bridge_parent_origin: payload.bridge_parent_origin,
          preview_title: payload.preview_title,
          metadata: payload.metadata || {},
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
    mediaEditorUrlForChat,
    previewUrlForSession,
    onUiError(error) {
      shellCalls.push(['error', String(error?.message || error)]);
    },
  });
  return {
    controller,
    shellCalls,
    shellCreateDeps,
    previewCreations,
    apiGetCalls,
    apiPostCalls,
    bridgeCaptureCalls,
    bridgeCaptureOptions,
    loadHandlers,
    previewFrame,
    previewFramesBySessionId,
    getDisposedPreviewCount: () => disposedPreviewCount,
  };
}

test('createController forwards Workspace shell deps to the shell helper', () => {
  const harness = createHarness();

  assert.equal(harness.shellCreateDeps.length, 1);
  assert.ok(harness.shellCreateDeps[0].workspaceRoot, 'workspaceRoot should be forwarded to shell helper');
  assert.ok(harness.shellCreateDeps[0].appShell, 'appShell should be forwarded to shell helper');
  assert.ok(harness.shellCreateDeps[0].toggleButton, 'toggleButton should be forwarded to shell helper');
  assert.ok(harness.shellCreateDeps[0].composerSelectionChip, 'composer chips should be forwarded to shell helper');
  assert.ok(harness.shellCreateDeps[0].previewWrap, 'previewWrap should be forwarded to shell helper');
  assert.ok(harness.shellCreateDeps[0].sidebarResizeHandle, 'sidebarResizeHandle should be forwarded to shell helper');
  assert.ok(harness.shellCreateDeps[0].previewResizeHandle, 'previewResizeHandle should be forwarded to shell helper');
  assert.equal(harness.shellCreateDeps[0].initialEnabled, true);
});

test('bootstrap fetches visual-dev state, session details, and applies the active chat session', async () => {
  const harness = createHarness();

  const payload = await harness.controller.bootstrap();

  assert.equal(payload.ok, true);
  assert.deepEqual(harness.apiGetCalls, ['/api/visual-dev/state', '/api/visual-dev/session/11']);
  assert.equal(harness.previewCreations.length, 1);
  assert.equal(harness.previewCreations[0].sessionId, 'session-11');
  assert.equal(harness.previewCreations[0].previewFrame.id, 'frame-session-11');
  assert.equal(harness.previewCreations[0].previewOrigin, 'https://preview.example.com');
  assert.equal(harness.previewCreations[0].parentOrigin, 'https://miniapp.example.com');
  assert.equal(harness.previewCreations[0].__handshakeCount, 1);
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

test('requestScreenshot captures the active preview iframe document and saves that artifact', async () => {
  const harness = createHarness();
  await harness.controller.bootstrap();

  await harness.controller.requestScreenshot();

  assert.deepEqual(harness.bridgeCaptureCalls, [{
    source: 'toolbar',
    capture: 'full',
    label: 'workspace preview screenshot',
  }]);
  assert.equal(harness.bridgeCaptureOptions.length, 1);
  assert.equal(harness.bridgeCaptureOptions[0].windowObject, harness.previewCreations[0].previewFrame.contentWindow);
  assert.equal(harness.bridgeCaptureOptions[0].documentObject, harness.previewCreations[0].previewFrame.contentWindow.document);
  assert.deepEqual(harness.apiPostCalls.at(-1), [
    '/api/visual-dev/session/screenshot',
    {
      session_id: 'session-11',
      content_type: 'image/png',
      bytes_b64: 'YmFy',
      metadata: {
        label: 'workspace preview screenshot',
        capture: 'full',
      },
    },
  ]);
});

test('requestScreenshot falls back to preview-command capture when the iframe document is not directly accessible', async () => {
  const harness = createHarness();
  await harness.controller.bootstrap();
  const previewDeps = harness.previewCreations[0];
  previewDeps.previewFrame.contentWindow = {
    postMessage() {},
  };

  const response = await harness.controller.requestScreenshot();

  assert.equal(response, null);
  assert.deepEqual(harness.bridgeCaptureCalls, []);
  assert.deepEqual(previewDeps.__commands, [[
    'capture-full',
    {
      source: 'toolbar',
      capture: 'full',
      label: 'workspace preview screenshot',
    },
  ]]);
});

test('bootstrap marks same-origin /app previews with an embedded-preview query param to avoid recursive self-embedding', async () => {
  const harness = createHarness({
    statePayload: {
      ok: true,
      enabled: true,
      sessions: [{
        session_id: 'session-11',
        chat_id: 11,
        preview_url: 'https://miniapp.example.com/app',
        preview_origin: 'https://miniapp.example.com',
        bridge_parent_origin: 'https://miniapp.example.com',
        preview_title: 'Hermes test',
        runtime: { state: 'connecting' },
      }],
    },
    getParentOrigin: () => 'https://miniapp.example.com',
  });

  await harness.controller.bootstrap();

  const applySessionStateCall = harness.shellCalls.find(([name]) => name === 'applySessionState');
  assert.ok(applySessionStateCall, 'bootstrap should still apply the active session');
  assert.equal(
    applySessionStateCall[1].preview_frame_url,
    'https://miniapp.example.com/app?__hermes_visual_dev_preview=1',
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

test('attachMediaEditorSession attaches same-origin media editor workspace without persisting init_data', async () => {
  const harness = createHarness({
    activeChatId: 33,
    statePayload: { ok: true, enabled: true, sessions: [] },
    mediaEditorUrlForChat: (chatId) => `https://miniapp.example.com/workspace/media-editor?chat_id=${chatId}`,
  });

  await harness.controller.attachMediaEditorSession();

  assert.equal(harness.apiPostCalls[0][0], '/api/visual-dev/session/attach');
  assert.equal(harness.apiPostCalls[0][1].chat_id, 33);
  assert.equal(harness.apiPostCalls[0][1].preview_url, 'https://miniapp.example.com/workspace/media-editor?chat_id=33');
  assert.equal(harness.apiPostCalls[0][1].preview_title, 'Workspace media editor');
  assert.deepEqual(harness.apiPostCalls[0][1].metadata, {
    workspace_kind: 'media_editor',
    workspace_mode: 'timeline',
  });
});

test('attachMediaEditorSession can derive the same-origin editor URL from the parent origin', async () => {
  const harness = createHarness({
    activeChatId: 44,
    statePayload: { ok: true, enabled: true, sessions: [] },
  });

  await harness.controller.attachMediaEditorSession();

  assert.equal(harness.apiPostCalls[0][1].preview_url, 'https://miniapp.example.com/workspace/media-editor?chat_id=44');
});

test('requestInspectMode and requestRegionScreenshot dispatch preview commands, while requestScreenshot captures the active iframe directly', async () => {

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
  await harness.controller.requestScreenshot();
  await harness.controller.requestRegionScreenshot();

  const previewDeps = harness.previewCreations[0];
  assert.deepEqual(previewDeps.__commands, [
    ['inspect-start', { source: 'toolbar' }],
    ['capture-region', {
      source: 'toolbar',
      capture: 'region',
      selector: '#toolbar',
      label: 'Toolbar',
      region: { left: 10, top: 20, width: 120, height: 48 },
    }],
  ]);
  assert.deepEqual(harness.bridgeCaptureCalls, [{
    source: 'toolbar',
    capture: 'full',
    label: 'workspace preview screenshot',
  }]);
  assert.equal(harness.bridgeCaptureOptions[0].windowObject, previewDeps.previewFrame.contentWindow);
});

test('syncActiveChatSession reuses cached preview frames when returning to a recently attached workspace chat', async () => {
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
  const frame11 = harness.previewCreations[0].previewFrame;

  harness.controller.setActiveChatGetter(() => 22);
  await harness.controller.syncActiveChatSession();
  const frame22 = harness.previewCreations[1].previewFrame;

  harness.controller.setActiveChatGetter(() => 11);
  await harness.controller.syncActiveChatSession();
  const frame11Return = harness.previewCreations[2].previewFrame;

  assert.notEqual(frame11, frame22);
  assert.equal(frame11Return, frame11);
  assert.ok(
    harness.apiGetCalls.filter((url) => url === '/api/visual-dev/session/11').length >= 2,
    'switching back should refresh details without rebuilding the underlying iframe',
  );
});

test('syncActiveChatSession swaps preview ownership, reloads drawer details, and keeps the workspace shell enabled when the active chat has no attached session', async () => {
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
  harness.shellCreateDeps[0].onWorkspaceOpenChange(true);
  harness.controller.setActiveChatGetter(() => 22);
  await harness.controller.syncActiveChatSession();
  harness.controller.setActiveChatGetter(() => 999);
  await harness.controller.syncActiveChatSession();

  assert.equal(harness.previewCreations.length, 2);
  assert.equal(harness.previewCreations[1].sessionId, 'session-22');
  assert.equal(harness.previewCreations[1].previewFrame.id, 'frame-session-22');
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
    harness.shellCalls.some(([name, payload]) => name === 'clearSessionState' && payload?.enabled === true),
    'controller should keep the workspace shell enabled when the active chat has no attachment',
  );
});

test('switching to unattached chats keeps the workspace open instead of restoring a per-chat closed state', async () => {
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
        console_events: [],
      },
      22: {
        ok: true,
        session: { session_id: 'session-22', chat_id: 22, runtime: { state: 'connecting', message: 'Booting' } },
        latest_selection: null,
        artifacts: [],
        console_events: [],
      },
    },
  });

  await harness.controller.bootstrap();
  harness.shellCreateDeps[0].onWorkspaceOpenChange(true);
  harness.controller.setActiveChatGetter(() => 22);
  await harness.controller.syncActiveChatSession();
  harness.controller.setActiveChatGetter(() => 999);
  await harness.controller.syncActiveChatSession();
  harness.controller.setActiveChatGetter(() => 11);
  await harness.controller.syncActiveChatSession();

  assert.equal(harness.previewCreations.length, 3);
  assert.equal(harness.previewCreations[0].previewFrame.id, 'frame-session-11');
  assert.equal(harness.previewCreations[2].previewFrame.id, 'frame-session-11');
  assert.equal(harness.previewCreations[2].sessionId, 'session-11');
  assert.equal(harness.previewCreations[2].__handshakeCount, 1);
  assert.equal(harness.getDisposedPreviewCount(), 2);
  assert.deepEqual(
    harness.shellCalls.filter(([name]) => name === 'toggleWorkspace').map(([, value]) => value),
    [],
    'chat switches should preserve the current workspace open state instead of forcing per-chat open/close toggles',
  );
  assert.ok(
    harness.shellCalls.some(([name, payload]) => name === 'clearSessionState' && payload?.enabled === true),
    'switching to an unattached chat should clear the preview content but keep the workspace shell enabled',
  );
});
