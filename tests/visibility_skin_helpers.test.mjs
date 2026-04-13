import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const visibilitySkin = require('../static/visibility_skin_helpers.js');

function createEventTarget(initial = {}) {
  const listeners = new Map();
  return {
    ...initial,
    addEventListener(type, handler) {
      const bucket = listeners.get(type) || [];
      bucket.push(handler);
      listeners.set(type, bucket);
    },
    listeners(type) {
      return listeners.get(type) || [];
    },
    dispatch(type, event = {}) {
      for (const handler of listeners.get(type) || []) {
        handler({ target: this, currentTarget: this, ...event });
      }
    },
  };
}

function buildHarness({ visibilityState = 'visible', authenticated = true, pendingChatsSize = 0, apiPostImpl = null } = {}) {
  let currentSkin = 'terminal';
  const skinCalls = [];
  const reloadCalls = [];
  const intervalCallbacks = [];
  const fetchCalls = [];
  const syncActiveMessageViewCalls = [];
  const syncVisibleActiveChatCalls = [];
  const refreshChatsCalls = [];
  const apiPostCalls = [];
  const bootstrapRefreshCalls = [];
  const lifecycleMarks = [];
  const visibilityResumes = [];
  const callOrder = [];

  const documentObject = createEventTarget({
    visibilityState,
    documentElement: {
      setAttribute() {},
    },
  });

  const localStore = new Map();
  const localStorageRef = {
    getItem(key) {
      return localStore.has(key) ? localStore.get(key) : null;
    },
    setItem(key, value) {
      localStore.set(key, String(value));
    },
  };

  const skinSyncChannel = createEventTarget({
    sent: [],
    postMessage(payload) {
      this.sent.push(payload);
    },
  });

  const body = { dataset: { skin: currentSkin } };
  const skinName = { textContent: currentSkin };
  const panelHint = { textContent: 'pending' };
  const skinButtons = [
    { dataset: { skin: 'terminal' }, classList: { toggle() {} } },
    { dataset: { skin: 'oracle' }, classList: { toggle() {} } },
    { dataset: { skin: 'obsidian' }, classList: { toggle() {} } },
  ];

  const pendingChats = new Set();
  for (let i = 0; i < pendingChatsSize; i += 1) pendingChats.add(i + 1);
  const streamAbortControllers = new Map([[1, { abort() {} }]]);

  const windowObject = createEventTarget({
    location: {
      reload() {
        reloadCalls.push('reload');
      },
    },
    setInterval(callback, delay) {
      intervalCallbacks.push({ callback, delay });
      return intervalCallbacks.length;
    },
  });

  const fetchImpl = async (url) => {
    fetchCalls.push(url);
    return {
      ok: true,
      async json() {
        return { version: 'v2' };
      },
    };
  };

  const controller = visibilitySkin.createController({
    windowObject,
    documentObject,
    localStorageRef,
    fetchImpl,
    devConfig: {
      enabled: true,
      reloadStateUrl: '/dev/reload-state',
      intervalMs: 1200,
      version: 'v1',
    },
    pendingChats,
    skinStorageKey: 'hermes_skin',
    allowedSkins: new Set(['terminal', 'oracle', 'obsidian']),
    skinSyncChannel,
    body,
    skinName,
    panelHint,
    skinButtons,
    getCurrentSkin: () => currentSkin,
    setCurrentSkin: (value) => {
      currentSkin = String(value || '');
    },
    apiPost: async (url, payload) => {
      callOrder.push(`apiPost:${url}`);
      apiPostCalls.push({ url, payload });
      if (typeof apiPostImpl === 'function') {
        return apiPostImpl(url, payload);
      }
      return { skin: payload?.skin === 'terminal' ? 'obsidian' : payload?.skin };
    },
    syncTelegramChromeForSkin: (skin) => {
      skinCalls.push(skin);
    },
    getIsAuthenticated: () => authenticated,
    getActiveChatId: () => 1,
    maybeRefreshForBootstrapVersionMismatch: async () => {
      bootstrapRefreshCalls.push('refresh');
      return false;
    },
    refreshChats: async () => {
      callOrder.push('refreshChats');
      refreshChatsCalls.push('refresh');
    },
    syncVisibleActiveChat: async (options = {}) => {
      callOrder.push('syncVisibleActiveChat');
      syncVisibleActiveChatCalls.push(options);
    },
    syncActiveMessageView: (chatId, options) => {
      callOrder.push('syncActiveMessageView');
      syncActiveMessageViewCalls.push({ chatId, options });
    },
    getStreamAbortControllers: () => streamAbortControllers,
    markBackgrounded: (marker) => lifecycleMarks.push({ ...marker }),
    markVisibilityResume: (marker) => visibilityResumes.push({ ...marker }),
  });

  return {
    controller,
    body,
    skinName,
    panelHint,
    localStore,
    skinSyncChannel,
    documentObject,
    windowObject,
    fetchCalls,
    skinCalls,
    reloadCalls,
    intervalCallbacks,
    syncActiveMessageViewCalls,
    syncVisibleActiveChatCalls,
    refreshChatsCalls,
    apiPostCalls,
    bootstrapRefreshCalls,
    lifecycleMarks,
    visibilityResumes,
    streamAbortControllers,
    callOrder,
    getCurrentSkin: () => currentSkin,
  };
}

test('setSkin updates state, local storage, and broadcast channel', () => {
  const harness = buildHarness();

  harness.controller.setSkin('oracle');

  assert.equal(harness.getCurrentSkin(), 'oracle');
  assert.equal(harness.body.dataset.skin, 'oracle');
  assert.equal(harness.skinName.textContent, 'oracle');
  assert.equal(harness.localStore.get('hermes_skin'), 'oracle');
  assert.deepEqual(harness.skinSyncChannel.sent, [{ type: 'skin', skin: 'oracle' }]);
  assert.deepEqual(harness.skinCalls, ['oracle']);
  assert.equal(harness.panelHint.textContent, '');
});

test('syncSkinFromStorage applies only changed valid skins', () => {
  const harness = buildHarness();
  harness.localStore.set('hermes_skin', 'obsidian');

  harness.controller.syncSkinFromStorage();

  assert.equal(harness.getCurrentSkin(), 'obsidian');
});

test('saveSkinPreference persists through apiPost and applies returned skin', async () => {
  const harness = buildHarness();

  const data = await harness.controller.saveSkinPreference('terminal');

  assert.deepEqual(harness.apiPostCalls, [{
    url: '/api/preferences/skin',
    payload: { skin: 'terminal' },
  }]);
  assert.equal(harness.getCurrentSkin(), 'obsidian');
  assert.equal(harness.body.dataset.skin, 'obsidian');
  assert.deepEqual(harness.skinCalls, ['obsidian']);
  assert.deepEqual(data, { skin: 'obsidian' });
});

test('installLifecycleListeners wires storage/focus/channel handlers', async () => {
  const harness = buildHarness();

  harness.controller.installLifecycleListeners();

  harness.windowObject.dispatch('storage', { key: 'hermes_skin', newValue: 'oracle' });
  assert.equal(harness.getCurrentSkin(), 'oracle');

  harness.skinSyncChannel.dispatch('message', { data: { type: 'skin', skin: 'terminal' } });
  assert.equal(harness.getCurrentSkin(), 'terminal');

  harness.localStore.set('hermes_skin', 'obsidian');
  harness.windowObject.dispatch('focus');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(harness.getCurrentSkin(), 'obsidian');
  assert.deepEqual(harness.syncActiveMessageViewCalls, [{ chatId: 1, options: { preserveViewport: true } }]);
  assert.deepEqual(harness.refreshChatsCalls, ['refresh']);
  assert.deepEqual(harness.syncVisibleActiveChatCalls, [{
    hidden: false,
    streamAbortControllers: harness.streamAbortControllers,
  }]);
  assert.deepEqual(harness.callOrder.slice(0, 3), [
    'apiPost:/api/presence/state',
    'syncActiveMessageView',
    'syncVisibleActiveChat',
  ]);
  assert.equal(harness.callOrder.indexOf('syncVisibleActiveChat') < harness.callOrder.indexOf('refreshChats'), true);
  assert.equal(harness.visibilityResumes.length, 1);
  assert.equal(harness.visibilityResumes[0].trigger, 'focus');
});

test('handleVisibilityChange refreshes lifecycle and delegates active-chat reconciliation when visible and authenticated', async () => {
  const harness = buildHarness({ visibilityState: 'visible', authenticated: true });

  await harness.controller.handleVisibilityChange();

  assert.deepEqual(harness.bootstrapRefreshCalls, []);
  assert.equal(harness.visibilityResumes.length, 1);
  assert.equal(harness.visibilityResumes[0].trigger, 'visibilitychange');
  assert.equal(harness.visibilityResumes[0].pendingChatCount, 0);
  assert.deepEqual(harness.syncActiveMessageViewCalls, [{ chatId: 1, options: { preserveViewport: true } }]);
  assert.deepEqual(harness.refreshChatsCalls, ['refresh']);
  assert.equal(harness.syncVisibleActiveChatCalls.length, 1);
  assert.deepEqual(harness.syncVisibleActiveChatCalls[0], {
    hidden: false,
    streamAbortControllers: harness.streamAbortControllers,
  });
  assert.deepEqual(harness.callOrder.slice(0, 3), [
    'apiPost:/api/presence/state',
    'syncActiveMessageView',
    'syncVisibleActiveChat',
  ]);
  assert.equal(harness.callOrder.indexOf('syncVisibleActiveChat') < harness.callOrder.indexOf('refreshChats'), true);
});

test('handleVisibilityChange is a no-op when document is hidden', async () => {
  const harness = buildHarness({ visibilityState: 'hidden', authenticated: true });

  await harness.controller.handleVisibilityChange();

  assert.equal(harness.lifecycleMarks.length, 1);
  assert.equal(harness.lifecycleMarks[0].trigger, 'visibilitychange');
  assert.deepEqual(harness.bootstrapRefreshCalls, []);
  assert.deepEqual(harness.syncActiveMessageViewCalls, []);
  assert.deepEqual(harness.refreshChatsCalls, []);
  assert.deepEqual(harness.syncVisibleActiveChatCalls, []);
});

test('handleVisibilityChange is a no-op when unauthenticated', async () => {
  const harness = buildHarness({ visibilityState: 'visible', authenticated: false });

  await harness.controller.handleVisibilityChange();

  assert.deepEqual(harness.bootstrapRefreshCalls, []);
  assert.deepEqual(harness.refreshChatsCalls, []);
  assert.deepEqual(harness.syncVisibleActiveChatCalls, []);
});

test('resumeVisibleApp does not let visible presence sync block active chat hydration', async () => {
  let resolvePresence;
  const harness = buildHarness({
    visibilityState: 'visible',
    authenticated: true,
    apiPostImpl: async (url, payload) => {
      if (url === '/api/presence/state' && payload?.visible) {
        await new Promise((resolve) => {
          resolvePresence = resolve;
        });
        return { ok: true };
      }
      return { skin: payload?.skin === 'terminal' ? 'obsidian' : payload?.skin };
    },
  });

  const resumePromise = harness.controller.handleVisibilityChange();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(harness.syncVisibleActiveChatCalls, [{
    hidden: false,
    streamAbortControllers: harness.streamAbortControllers,
  }]);
  assert.deepEqual(harness.refreshChatsCalls, ['refresh']);
  assert.equal(harness.callOrder.indexOf('syncVisibleActiveChat') < harness.callOrder.indexOf('refreshChats'), true);

  resolvePresence();
  await resumePromise;
});

test('handleVisibilityChange ignores bootstrap refresh callbacks and continues normal sync', async () => {
  const harness = buildHarness({ visibilityState: 'visible', authenticated: true });
  harness.controller = visibilitySkin.createController({
    windowObject: harness.windowObject,
    documentObject: harness.documentObject,
    localStorageRef: {
      getItem() { return null; },
      setItem() {},
    },
    fetchImpl: async () => ({ ok: true, async json() { return { version: 'v2' }; } }),
    devConfig: {
      enabled: true,
      reloadStateUrl: '/dev/reload-state',
      intervalMs: 1200,
      version: 'v1',
    },
    pendingChats: new Set(),
    skinStorageKey: 'hermes_skin',
    allowedSkins: new Set(['terminal', 'oracle', 'obsidian']),
    skinSyncChannel: harness.skinSyncChannel,
    body: harness.body,
    skinName: harness.skinName,
    panelHint: harness.panelHint,
    skinButtons: [
      { dataset: { skin: 'terminal' }, classList: { toggle() {} } },
      { dataset: { skin: 'oracle' }, classList: { toggle() {} } },
    ],
    getCurrentSkin: () => harness.getCurrentSkin(),
    setCurrentSkin: () => {},
    apiPost: async () => ({ skin: 'terminal' }),
    syncTelegramChromeForSkin: () => {},
    getIsAuthenticated: () => true,
    getActiveChatId: () => 1,
    maybeRefreshForBootstrapVersionMismatch: async () => true,
    refreshChats: async () => { harness.refreshChatsCalls.push('refresh'); },
    syncVisibleActiveChat: async () => { harness.syncVisibleActiveChatCalls.push({ hidden: false, streamAbortControllers: new Map() }); },
    syncActiveMessageView: () => { harness.syncActiveMessageViewCalls.push({ chatId: 1, options: { preserveViewport: true } }); },
    getStreamAbortControllers: () => new Map(),
  });

  await harness.controller.handleVisibilityChange();

  assert.deepEqual(harness.bootstrapRefreshCalls, []);
  assert.deepEqual(harness.refreshChatsCalls, ['refresh']);
  assert.equal(harness.syncVisibleActiveChatCalls.length, 1);
});

test('syncVisibleActiveChat delegates to injected controller method', async () => {
  const harness = buildHarness({ visibilityState: 'visible', authenticated: true });
  const streamAbortControllers = new Map();

  await harness.controller.syncVisibleActiveChat({
    hidden: true,
    streamAbortControllers,
  });

  assert.deepEqual(harness.syncVisibleActiveChatCalls, [{
    hidden: true,
    streamAbortControllers,
  }]);
});

test('startDevAutoRefresh polls and queues reload on version changes', async () => {
  const harness = buildHarness({ visibilityState: 'visible', pendingChatsSize: 0 });

  harness.controller.startDevAutoRefresh();

  assert.equal(harness.intervalCallbacks.length, 1);
  await harness.intervalCallbacks[0].callback();

  assert.equal(harness.fetchCalls.length, 1);
  assert.deepEqual(harness.reloadCalls, ['reload']);
});
