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
    operatorName,
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
    resumePendingChatStream: (chatId) => { resumeCalls.push(Number(chatId)); },
    addLocalMessage: (chatId, message) => localMessages.push({ chatId: Number(chatId), message }),
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
    getWarmCalls: () => warmCalls,
    getResumeCalls: () => resumeCalls,
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
