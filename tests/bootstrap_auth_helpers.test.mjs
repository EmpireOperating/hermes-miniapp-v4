import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bootstrapAuth = require('../static/bootstrap_auth_helpers.js');

function buildHarness(overrides = {}) {
  const {
    desktopTestingEnabled = true,
    ...controllerOverrides
  } = overrides;
  let isAuthenticated = false;
  let operatorDisplayName = '';
  const authStatus = { textContent: '' };
  const operatorName = { textContent: '' };
  const roleNodes = [{ textContent: '' }, { textContent: '' }];
  const messagesEl = {
    querySelectorAll: (selector) => {
      assert.equal(selector, '.message--operator .message__role, .message[data-role="operator"] .message__role, .message[data-role="user"] .message__role');
      return roleNodes;
    },
  };
  const devAuthControls = { hidden: true };
  const devModeBadge = { hidden: true };
  const devSignInButton = { hidden: true, disabled: true };
  const sessionStorageData = new Map();

  const chats = new Map([[5, { pending: false }]]);
  const pendingChats = new Set();
  const histories = new Map();
  const upsertedChats = [];
  const pinnedSyncs = [];
  const renderedMessages = [];
  const localMessages = [];
  let activeChatId = null;
  let skin = '';
  let resumeCalls = [];
  let fetchCalls = [];
  let appendedSystemMessages = [];
  let roleLabelsRefreshed = 0;
  let warmCalls = 0;
  const armedActivationUnreadThresholds = [];
  const bootMetrics = [];
  const bootLatencyStages = [];
  const bootStages = [];
  const locationReplacements = [];
  const windowObject = {
    setTimeout: (callback, _delay) => {
      callback();
      return 1;
    },
    location: {
      pathname: '/app',
      replace: (target) => {
        locationReplacements.push(String(target));
      },
    },
  };

  const controller = bootstrapAuth.createController({
    desktopTestingEnabled,
    devAuthSessionStorageKey: 'dev-auth',
    devAuthControls,
    devModeBadge,
    devSignInButton,
    getIsAuthenticated: () => isAuthenticated,
    setIsAuthenticated: (value) => { isAuthenticated = Boolean(value); },
    sessionStorageRef: {
      getItem: (key) => sessionStorageData.get(key) || null,
      setItem: (key, value) => sessionStorageData.set(key, value),
    },
    devAuthModal: null,
    devAuthForm: null,
    devAuthSecretInput: null,
    devAuthUserIdInput: null,
    devAuthDisplayNameInput: null,
    devAuthUsernameInput: null,
    devAuthCancelButton: null,
    authStatus,
    appendSystemMessage: (text) => appendedSystemMessages.push(String(text)),
    safeReadJson: async (response) => response.json(),
    fetchImpl: async (...args) => {
      fetchCalls.push(args);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          user: { username: 'desktop', display_name: 'Desktop Tester' },
          skin: 'terminal',
          active_chat_id: 5,
          chats: [{ id: 5, pending: false }],
          pinned_chats: [],
          history: [],
        }),
      };
    },
    normalizeHandle: (value) => String(value || '').trim().toLowerCase(),
    initData: 'init-data-token',
    parseSseEvent: () => ({ eventName: '', payload: null }),
    fallbackHandleFromDisplayName: (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, '-'),
    setOperatorDisplayName: (value) => { operatorDisplayName = String(value); },
    getOperatorDisplayName: () => operatorDisplayName,
    operatorName,
    messagesEl,
    refreshOperatorRoleLabels: () => { roleLabelsRefreshed += 1; },
    setSkin: (value) => { skin = String(value); },
    syncChats: (chatList) => upsertedChats.push(...chatList),
    syncPinnedChats: (list) => pinnedSyncs.push(list),
    histories,
    setActiveChatMeta: (chatId) => { activeChatId = chatId == null ? null : Number(chatId); },
    renderPinnedChats: () => {},
    renderMessages: (chatId) => renderedMessages.push(Number(chatId)),
    warmChatHistoryCache: () => { warmCalls += 1; },
    chats,
    pendingChats,
    resumePendingChatStream: (chatId, options = {}) => { resumeCalls.push({ chatId: Number(chatId), options }); },
    addLocalMessage: (chatId, message) => localMessages.push({ chatId: Number(chatId), message }),
    hasFreshPendingStreamSnapshot: () => false,
    restorePendingStreamSnapshot: () => false,
    ensureActivationReadThreshold: (chatId, unreadCount) => {
      armedActivationUnreadThresholds.push({ chatId: Number(chatId), unreadCount: Number(unreadCount || 0) });
    },
    windowObject,
    authBootstrapMaxAttempts: 3,
    authBootstrapBaseDelayMs: 0,
    authBootstrapRetryableStatus: new Set([408, 425, 429, 500, 502, 503, 504]),
    bootBootstrapVersion: 'build-old',
    bootstrapVersionReloadStorageKey: 'bootstrap-version-reload',
    recordBootMetric: (name) => bootMetrics.push(String(name)),
    syncBootLatencyChip: (stage) => bootLatencyStages.push(String(stage)),
    onBootstrapStage: (stage, details = {}) => bootStages.push({ stage: String(stage), details }),
    ...controllerOverrides,
  });

  return {
    controller,
    authStatus,
    operatorName,
    devAuthControls,
    devModeBadge,
    devSignInButton,
    sessionStorageData,
    histories,
    upsertedChats,
    pinnedSyncs,
    renderedMessages,
    localMessages,
    fetchCalls,
    appendedSystemMessages,
    getOperatorDisplayName: () => operatorDisplayName,
    getSkin: () => skin,
    getActiveChatId: () => activeChatId,
    getRoleLabelsRefreshed: () => roleLabelsRefreshed,
    getRoleNodeLabels: () => roleNodes.map((node) => node.textContent),
    getWarmCalls: () => warmCalls,
    getArmedActivationUnreadThresholds: () => armedActivationUnreadThresholds,
    getResumeCalls: () => resumeCalls,
    getBootMetrics: () => bootMetrics,
    getBootLatencyStages: () => bootLatencyStages,
    getBootStages: () => bootStages,
    getLocationReplacements: () => locationReplacements,
    setAuthenticated: (value) => { isAuthenticated = Boolean(value); },
  };
}

test('syncDevAuthUi reflects revealed desktop auth availability and auth state', () => {
  const harness = buildHarness();

  harness.controller.syncDevAuthUi();
  assert.equal(harness.devAuthControls.hidden, false);
  assert.equal(harness.devModeBadge.hidden, false);
  assert.equal(harness.devSignInButton.hidden, false);
  assert.equal(harness.devSignInButton.disabled, false);

  harness.setAuthenticated(true);
  harness.controller.syncDevAuthUi();
  assert.equal(harness.devSignInButton.hidden, true);
});

test('syncDevAuthUi keeps dev auth controls hidden when reveal mode is off', () => {
  const harness = buildHarness({ desktopTestingEnabled: false });

  harness.controller.syncDevAuthUi();

  assert.equal(harness.devAuthControls.hidden, true);
  assert.equal(harness.devModeBadge.hidden, true);
  assert.equal(harness.devSignInButton.hidden, true);
  assert.equal(harness.devSignInButton.disabled, true);
});

test('read/write dev auth defaults round-trip through session storage', () => {
  const harness = buildHarness();

  harness.controller.writeDevAuthDefaults({ secret: 's', userId: '1', displayName: 'Desk', username: 'desk' });

  assert.deepEqual(harness.controller.readDevAuthDefaults(), {
    secret: 's',
    userId: '1',
    displayName: 'Desk',
    username: 'desk',
  });
});

test('normalizeHandle, fallbackHandleFromDisplayName, and refreshOperatorRoleLabels keep bootstrap auth ownership defaults', () => {
  const harness = buildHarness({
    normalizeHandle: null,
    fallbackHandleFromDisplayName: null,
    refreshOperatorRoleLabels: null,
  });

  assert.equal(harness.controller.normalizeHandle(' @@Desk '), 'Desk');
  assert.equal(harness.controller.fallbackHandleFromDisplayName('Desk Top'), 'DeskTop');
  assert.equal(harness.controller.fallbackHandleFromDisplayName('Δ Hermes'), 'Δ Hermes');

  harness.controller.refreshOperatorRoleLabels();
  assert.deepEqual(harness.getRoleNodeLabels(), ['Operator', 'Operator']);

  harness.controller.applyAuthBootstrap({
    user: { username: '', display_name: 'Desk Top' },
    skin: 'terminal',
    active_chat_id: null,
    chats: [],
    pinned_chats: [],
    history: [],
  }, { preferredUsername: '' });

  assert.equal(harness.getOperatorDisplayName(), 'DeskTop');
  assert.deepEqual(harness.getRoleNodeLabels(), ['DeskTop', 'DeskTop']);
});

test('applyAuthBootstrap updates auth-facing UI and history state', () => {
  const harness = buildHarness();

  harness.controller.applyAuthBootstrap({
    user: { username: 'desktop', display_name: 'Desktop Tester' },
    skin: 'oracle',
    active_chat_id: 5,
    chats: [{ id: 5, pending: false }],
    pinned_chats: [{ id: 5 }],
    history: [],
  }, { preferredUsername: 'Desktop' });

  assert.equal(harness.authStatus.textContent, 'Signed in as desktop');
  assert.equal(harness.operatorName.textContent, 'desktop');
  assert.equal(harness.getOperatorDisplayName(), 'desktop');
  assert.equal(harness.getSkin(), 'oracle');
  assert.equal(harness.getActiveChatId(), 5);
  assert.deepEqual(harness.histories.get(5), []);
  assert.deepEqual(harness.upsertedChats, [{ id: 5, pending: false }]);
  assert.deepEqual(harness.pinnedSyncs, [[{ id: 5 }]]);
  assert.deepEqual(harness.localMessages.length, 1);
  assert.equal(harness.getRoleLabelsRefreshed(), 1);
  assert.equal(harness.getWarmCalls(), 1);
  assert.deepEqual(harness.getResumeCalls(), []);
});

test('applyAuthBootstrap arms the active unread threshold for the bootstrap-selected chat', () => {
  const harness = buildHarness({
    chats: new Map([[5, { id: 5, pending: false, unread_count: 3 }]]),
  });

  harness.controller.applyAuthBootstrap({
    user: { username: 'desktop', display_name: 'Desktop Tester' },
    skin: 'terminal',
    active_chat_id: 5,
    chats: [{ id: 5, pending: false, unread_count: 3 }],
    pinned_chats: [],
    history: [],
  }, { preferredUsername: 'Desktop' });

  assert.deepEqual(harness.getArmedActivationUnreadThresholds(), [{ chatId: 5, unreadCount: 3 }]);
});

test('applyAuthBootstrap supports explicit no-active-chat state', () => {
  const harness = buildHarness();

  harness.controller.applyAuthBootstrap({
    user: { username: 'desktop', display_name: 'Desktop Tester' },
    skin: 'terminal',
    active_chat_id: null,
    chats: [],
    pinned_chats: [{ id: 11 }],
    history: [],
  }, { preferredUsername: 'Desktop' });

  assert.equal(harness.getActiveChatId(), null);
  assert.deepEqual(harness.renderedMessages, []);
  assert.deepEqual(harness.localMessages, []);
  assert.equal(harness.getWarmCalls(), 0);
  assert.deepEqual(harness.pinnedSyncs, [[{ id: 11 }]]);
});

test('applyAuthBootstrap restores fresh local pending snapshot and force-resumes when server bootstrap briefly says not pending', () => {
  const harness = buildHarness({
    hasFreshPendingStreamSnapshot: (chatId) => Number(chatId) === 5,
    restorePendingStreamSnapshot: (chatId) => {
      if (Number(chatId) === 5) {
        harness.histories.set(5, [{ role: 'tool', body: 'missed tool', pending: true }]);
        return true;
      }
      return false;
    },
  });

  harness.controller.applyAuthBootstrap({
    user: { username: 'desktop', display_name: 'Desktop Tester' },
    skin: 'terminal',
    active_chat_id: 5,
    chats: [{ id: 5, pending: false }],
    pinned_chats: [],
    history: [],
  }, { preferredUsername: 'Desktop' });

  assert.deepEqual(harness.histories.get(5), [{ role: 'tool', body: 'missed tool', pending: true }]);
  assert.deepEqual(harness.getResumeCalls(), [{ chatId: 5, options: { force: true } }]);
});

test('request utility delegates cover auth payload + safe JSON fallback', async () => {
  const harness = buildHarness();

  assert.deepEqual(harness.controller.authPayload({ chat_id: 7 }), {
    init_data: 'init-data-token',
    chat_id: 7,
  });

  const parsed = await harness.controller.safeReadJson({
    json: async () => ({ ok: true }),
  });
  assert.deepEqual(parsed, { ok: true });

  const invalid = await harness.controller.safeReadJson({
    json: async () => { throw new Error('bad json'); },
  });
  assert.equal(invalid, null);
});

test('apiPost composes auth payloads and surfaces session expiry through auth UI state', async () => {
  let composerStateUpdates = 0;
  let seenOptions = null;
  const harness = buildHarness({
    updateComposerState: () => { composerStateUpdates += 1; },
    fetchImpl: async (_url, options = {}) => {
      seenOptions = options;
      return {
        ok: false,
        status: 401,
        json: async () => ({ ok: false, error: 'Telegram init data is too old' }),
      };
    },
  });

  await assert.rejects(
    harness.controller.apiPost('/api/chats', { chat_id: 7 }),
    /Telegram session expired\. Close and reopen the mini app to refresh auth\./,
  );

  assert.equal(seenOptions.method, 'POST');
  assert.equal(seenOptions.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(seenOptions.body), {
    init_data: 'init-data-token',
    chat_id: 7,
  });
  assert.equal(harness.authStatus.textContent, 'Session expired');
  assert.equal(composerStateUpdates, 1);
});

test('summarizeUiFailure and parseStreamErrorPayload sanitize noisy upstream payloads', () => {
  const harness = buildHarness({
    parseSseEvent: () => ({
      eventName: 'error',
      payload: { error: 'stream failed', chat_id: '42' },
    }),
  });

  const htmlFallback = harness.controller.summarizeUiFailure('<!doctype html><html></html>', {
    status: 500,
    fallback: 'Request failed.',
  });
  assert.equal(htmlFallback, 'Request failed.');

  const unavailable = harness.controller.summarizeUiFailure('gateway timeout', {
    status: 503,
    fallback: 'Request failed.',
  });
  assert.equal(unavailable, 'Mini app backend temporarily unavailable. Please wait a moment and reopen if needed.');

  const parsed = harness.controller.parseStreamErrorPayload('event: error\ndata: {"error":"stream failed"}\n\n');
  assert.deepEqual(parsed, {
    eventName: 'error',
    error: 'stream failed',
    chatId: 42,
  });
});

test('fetchAuthBootstrapWithRetry retries retryable auth bootstrap failures and records metrics', async () => {
  const responses = [
    {
      ok: false,
      status: 503,
      json: async () => ({ ok: false, error: 'temporarily unavailable' }),
    },
    {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, user: { username: 'desktop' } }),
    },
  ];
  const harness = buildHarness({
    fetchImpl: async (...args) => {
      harness.fetchCalls.push(args);
      return responses.shift();
    },
  });

  const result = await harness.controller.fetchAuthBootstrapWithRetry();

  assert.equal(result.response.status, 200);
  assert.equal(result.data.ok, true);
  assert.equal(harness.fetchCalls.length, 2);
  assert.deepEqual(harness.getBootLatencyStages(), ['auth-request']);
  assert.deepEqual(harness.getBootMetrics(), ['authBootstrapStartMs', 'authBootstrapSuccessMs']);
  assert.deepEqual(harness.getBootStages().map((entry) => entry.stage), ['auth-bootstrap-ok']);
});

test('maybeRefreshForBootstrapVersionMismatch refreshes once when server version changes', async () => {
  const harness = buildHarness({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, bootstrap_version: 'build-new' }),
    }),
  });

  const refreshed = await harness.controller.maybeRefreshForBootstrapVersionMismatch();

  assert.equal(refreshed, true);
  assert.equal(harness.authStatus.textContent, 'Refreshing app…');
  assert.equal(
    harness.sessionStorageData.get('bootstrap-version-reload'),
    'build-old->build-new',
  );
  assert.deepEqual(harness.getLocationReplacements(), ['/app?v=build-new']);
});
