import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const startupBindings = require('../static/startup_bindings_helpers.js');

function createEventTarget(initial = {}) {
  const listeners = new Map();
  return {
    ...initial,
    addEventListener(type, handler, options = undefined) {
      const bucket = listeners.get(type) || [];
      bucket.push({ handler, options });
      listeners.set(type, bucket);
    },
    listeners(type) {
      return listeners.get(type) || [];
    },
    dispatch(type, event = {}) {
      const evt = event;
      if (typeof evt.preventDefault !== 'function') {
        evt.preventDefault = () => {};
      }
      if (evt.currentTarget === undefined) {
        evt.currentTarget = this;
      }
      if (evt.target === undefined) {
        evt.target = this;
      }
      for (const entry of listeners.get(type) || []) {
        entry.handler(evt);
      }
    },
  };
}

function flushAsync() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function buildHarness({
  isAuthenticated = true,
  desktopTestingEnabled = false,
  desktopTestingRequested = false,
  missingTemplate = false,
  bootstrapResponse = { response: { ok: true, status: 200 }, data: { ok: true, active_chat_id: 7, chats: [{ id: 7, pending: true }] } },
  maybeRefresh = false,
  isNearBottom = true,
} = {}) {
  const chatScrollTop = new Map();
  const chatStickToBottom = new Map();
  const unseenStreamChats = new Set([7]);
  const histories = new Map([[7, [{ id: 1 }, { id: 2 }]]]);
  const chats = new Map([[7, { id: 7, pending: true }]]);
  const pendingChats = new Set([7]);
  const refreshTabCalls = [];
  const maybeMarkReadCalls = [];
  const syncActiveMessageViewCalls = [];
  const scheduleActiveViewCalls = [];
  const appendMessages = [];
  const reportErrors = [];
  const saveSkinCalls = [];
  const closeSettingsCalls = [];
  const signInCalls = [];
  const syncDevAuthUiCalls = [];
  const logBootStages = [];
  const bootLatency = [];
  const authBootstrapCalls = [];
  const restoreSnapshotCalls = [];
  const renderMessagesCalls = [];
  const recordBootMetricCalls = [];
  const summarizeBootMetricsCalls = [];
  const refreshChatsCalls = [];
  const syncVisibleActiveChatCalls = [];
  const intervalCallbacks = [];
  const consoleErrors = [];
  let initDataValue = '';
  let renderTraceEnabled = false;

  const tabsEl = createEventTarget();
  const pinnedChatsEl = createEventTarget();
  const pinnedChatsToggleButton = createEventTarget();
  const jumpLatestButton = createEventTarget();
  const jumpLastStartButton = createEventTarget();
  const skinButton = createEventTarget({ dataset: { skin: 'oracle' } });
  const newChatButton = createEventTarget();
  const renameChatButton = createEventTarget();
  const pinChatButton = createEventTarget();
  const removeChatButton = createEventTarget();
  const fullscreenAppTopButton = createEventTarget();
  const closeAppTopButton = createEventTarget();
  const renderTraceBadge = createEventTarget();
  const settingsButton = createEventTarget();
  const devSignInButton = createEventTarget();
  const settingsClose = createEventTarget();
  const settingsModal = createEventTarget();
  const authStatusEl = { textContent: '', title: '' };
  const operatorNameEl = { textContent: 'operator' };
  const formEl = createEventTarget();
  const promptEl = { value: '' };
  const sendButton = createEventTarget();
  const templateEl = missingTemplate ? null : { content: { firstElementChild: {} } };

  const messagesEl = createEventTarget({
    scrollTop: 120,
    querySelectorAll(selector) {
      if (selector !== '.message') return [];
      return [{ offsetTop: 90 }, { offsetTop: 460 }];
    },
  });

  const documentObject = createEventTarget({ visibilityState: 'visible' });
  const windowObject = {
    setInterval(callback) {
      intervalCallbacks.push(callback);
      return intervalCallbacks.length;
    },
    console: {
      error(...args) {
        consoleErrors.push(args);
      },
    },
  };
  const tg = {
    initData: 'telegram-init-data',
    initDataUnsafe: { user: { username: 'agentuser' } },
    readyCalls: 0,
    expandCalls: 0,
    eventRegistrations: [],
    ready() {
      this.readyCalls += 1;
    },
    expand() {
      this.expandCalls += 1;
    },
    onEvent(name, handler) {
      this.eventRegistrations.push([name, handler]);
    },
  };

  const controller = startupBindings.createController({
    windowObject,
    documentObject,
    tabsEl,
    pinnedChatsEl,
    pinnedChatsToggleButton,
    messagesEl,
    jumpLatestButton,
    jumpLastStartButton,
    skinButtons: [skinButton],
    newChatButton,
    renameChatButton,
    pinChatButton,
    removeChatButton,
    fullscreenAppTopButton,
    closeAppTopButton,
    renderTraceBadge,
    settingsButton,
    devSignInButton,
    settingsClose,
    settingsModal,
    authStatusEl,
    operatorNameEl,
    formEl,
    promptEl,
    sendButton,
    templateEl,
    tg,
    getActiveChatId: () => 7,
    getRenderedChatId: () => 7,
    isNearBottomFn: () => isNearBottom,
    chatScrollTop,
    chatStickToBottom,
    unseenStreamChats,
    histories,
    chats,
    pendingChats,
    shouldVirtualizeHistoryFn: () => true,
    scheduleActiveMessageView: (chatId) => scheduleActiveViewCalls.push(chatId),
    refreshTabNode: (chatId) => refreshTabCalls.push(chatId),
    maybeMarkRead: (chatId, options = undefined) => maybeMarkReadCalls.push([chatId, options]),
    updateJumpLatestVisibility: () => {},
    syncActiveMessageView: (chatId, options) => syncActiveMessageViewCalls.push([chatId, options]),
    cancelSelectionQuoteSync: () => {},
    cancelSelectionQuoteSettle: () => {},
    cancelSelectionQuoteClear: () => {},
    clearSelectionQuoteState: () => {},
    handleTabClick: () => {},
    handlePinnedChatClick: () => {},
    togglePinnedChatsCollapsed: () => {},
    handleGlobalTabCycle: () => {},
    handleGlobalArrowJump: () => {},
    handleGlobalComposerFocusShortcut: () => {},
    handleGlobalChatActionShortcut: () => {},
    handleGlobalControlEnterDefuse: () => {},
    handleGlobalControlMouseDownFocusGuard: () => {},
    handleGlobalControlClickFocusCleanup: () => {},
    handleFullscreenToggle: () => {},
    handleCloseApp: () => {},
    handleRenderTraceBadgeClick: () => {},
    openSettingsModal: () => {},
    closeSettingsModal: () => closeSettingsCalls.push(true),
    signInWithDevAuth: async (options = {}) => {
      signInCalls.push(options);
      if (desktopTestingEnabled && bootstrapResponse?.response?.ok === false) {
        return false;
      }
      throw new Error('boom');
    },
    appendSystemMessage: (text) => appendMessages.push(text),
    syncDevAuthUi: () => syncDevAuthUiCalls.push(true),
    reportUiError: (error) => reportErrors.push(error?.message || String(error)),
    getIsAuthenticated: () => isAuthenticated,
    saveSkinPreference: async (skin) => saveSkinCalls.push(skin),
    createChat: async () => {},
    renameActiveChat: async () => {},
    toggleActiveChatPin: async () => {},
    removeActiveChat: async () => {
      throw new Error('remove failed');
    },
    syncRenderTraceBadge: () => {
      renderTraceEnabled = true;
    },
    loadDraftsFromStorage: () => {},
    syncClosingConfirmation: () => {},
    syncFullscreenControlState: () => {},
    setInitData: (value) => {
      initDataValue = String(value || '');
    },
    getInitData: () => initDataValue,
    getRenderTraceDebugEnabled: () => renderTraceEnabled,
    renderTraceLog: (eventName, details) => logBootStages.push(['trace', eventName, details]),
    maybeRefreshForBootstrapVersionMismatch: async () => maybeRefresh,
    logBootStage: (eventName, details = null) => logBootStages.push([eventName, details]),
    syncBootLatencyChip: (eventName) => bootLatency.push(eventName),
    fetchAuthBootstrapWithRetry: async () => {
      authBootstrapCalls.push(true);
      return bootstrapResponse;
    },
    desktopTestingEnabled,
    desktopTestingRequested,
    devConfig: { devAuthEnabled: false },
    applyAuthBootstrap: (...args) => authBootstrapCalls.push(args),
    hasFreshPendingStreamSnapshot: () => true,
    restorePendingStreamSnapshot: (chatId) => {
      restoreSnapshotCalls.push(chatId);
      return true;
    },
    renderMessages: (chatId, options) => renderMessagesCalls.push([chatId, options]),
    updateComposerState: () => {},
    revealShell: () => logBootStages.push(['revealShell', null]),
    recordBootMetric: (name) => recordBootMetricCalls.push(name),
    summarizeBootMetrics: (payload) => summarizeBootMetricsCalls.push(payload),
    getChatsSize: () => chats.size,
    isActiveChatPending: () => true,
    refreshChats: async () => {
      refreshChatsCalls.push(true);
    },
    syncVisibleActiveChat: async (options) => {
      syncVisibleActiveChatCalls.push(options);
    },
    getStreamAbortControllers: () => new Map([[7, { abort() {} }]]),
  });

  return {
    controller,
    tabsEl,
    pinnedChatsEl,
    pinnedChatsToggleButton,
    messagesEl,
    jumpLatestButton,
    jumpLastStartButton,
    skinButton,
    removeChatButton,
    devSignInButton,
    settingsModal,
    documentObject,
    authStatusEl,
    chatScrollTop,
    chatStickToBottom,
    unseenStreamChats,
    refreshTabCalls,
    maybeMarkReadCalls,
    syncActiveMessageViewCalls,
    scheduleActiveViewCalls,
    appendMessages,
    reportErrors,
    saveSkinCalls,
    closeSettingsCalls,
    signInCalls,
    syncDevAuthUiCalls,
    logBootStages,
    bootLatency,
    authBootstrapCalls,
    restoreSnapshotCalls,
    renderMessagesCalls,
    recordBootMetricCalls,
    summarizeBootMetricsCalls,
    refreshChatsCalls,
    syncVisibleActiveChatCalls,
    intervalCallbacks,
    consoleErrors,
    tg,
    get initDataValue() {
      return initDataValue;
    },
  };
}

test('handleMessagesScroll reconciles active chat scroll state and read markers', () => {
  const harness = buildHarness();

  harness.controller.handleMessagesScroll();

  assert.equal(harness.chatScrollTop.get(7), 120);
  assert.equal(harness.chatStickToBottom.get(7), true);
  assert.deepEqual(harness.refreshTabCalls, [7]);
  assert.deepEqual(harness.maybeMarkReadCalls, [[7, undefined]]);
  assert.deepEqual(harness.scheduleActiveViewCalls, [7]);
  assert.equal(harness.unseenStreamChats.has(7), false);
});

test('handleMessagesScroll still checks exact unread-message threshold when not near chat bottom', () => {
  const harness = buildHarness({ isNearBottom: false });

  harness.controller.handleMessagesScroll();

  assert.equal(harness.chatStickToBottom.get(7), false);
  assert.deepEqual(harness.refreshTabCalls, []);
  assert.deepEqual(harness.maybeMarkReadCalls, [[7, undefined]]);
  assert.equal(harness.unseenStreamChats.has(7), true);
});

test('handleJumpLatest forces bottom sync and mark-read', () => {
  const harness = buildHarness();

  harness.controller.handleJumpLatest();

  assert.deepEqual(harness.refreshTabCalls, [7]);
  assert.deepEqual(harness.syncActiveMessageViewCalls, [[7, { forceBottom: true }]]);
  assert.deepEqual(harness.maybeMarkReadCalls, [[7, { force: true }]]);
});

test('handleJumpLastStart scrolls to latest rendered message offset', () => {
  const harness = buildHarness();

  harness.controller.handleJumpLastStart();

  assert.equal(harness.messagesEl.scrollTop, 460);
  assert.equal(harness.chatScrollTop.get(7), 460);
});

test('installCoreEventBindings wires keyboard/mouse and scroll/click listeners', () => {
  const harness = buildHarness();

  harness.controller.installCoreEventBindings();

  assert.equal(harness.tabsEl.listeners('click').length, 1);
  assert.equal(harness.pinnedChatsEl.listeners('click').length, 1);
  assert.equal(harness.pinnedChatsToggleButton.listeners('click').length, 1);
  assert.equal(harness.documentObject.listeners('keydown').length, 5);
  assert.equal(harness.documentObject.listeners('mousedown').length, 1);
  assert.equal(harness.documentObject.listeners('click').length, 1);
  assert.equal(harness.messagesEl.listeners('scroll').length, 1);
  assert.equal(harness.jumpLatestButton.listeners('click').length, 1);
  assert.equal(harness.jumpLastStartButton.listeners('click').length, 1);
});

test('installActionButtonBindings guards unauthenticated skin change and reports async button errors', async () => {
  const harness = buildHarness({ isAuthenticated: false });

  harness.controller.installActionButtonBindings();
  harness.skinButton.dispatch('click');
  harness.removeChatButton.dispatch('click');
  await flushAsync();

  assert.deepEqual(harness.appendMessages, ['Still signing you in. Try again in a moment.']);
  assert.deepEqual(harness.saveSkinCalls, []);
  assert.deepEqual(harness.reportErrors, ['remove failed']);
});

test('installActionButtonBindings saves skin and closes settings when authenticated', async () => {
  const harness = buildHarness({ isAuthenticated: true });

  harness.controller.installActionButtonBindings();
  harness.skinButton.dispatch('click');
  await flushAsync();

  assert.deepEqual(harness.saveSkinCalls, ['oracle']);
  assert.equal(harness.closeSettingsCalls.length, 1);
});

test('installShellModalBindings handles dev sign-in failures', async () => {
  const harness = buildHarness();

  harness.controller.installShellModalBindings();
  harness.devSignInButton.dispatch('click');
  await flushAsync();

  assert.equal(harness.signInCalls.length, 1);
  assert.equal(harness.authStatusEl.textContent, 'Dev sign-in error');
  assert.deepEqual(harness.appendMessages, ['Dev sign-in failed: boom']);
  assert.equal(harness.syncDevAuthUiCalls.length, 1);

  const cancelEvent = {
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  };
  harness.settingsModal.dispatch('cancel', cancelEvent);
  assert.equal(cancelEvent.prevented, true);
  assert.equal(harness.closeSettingsCalls.length, 1);
});

test('getMissingBootstrapBindings reports missing required startup nodes', () => {
  const harness = buildHarness({ missingTemplate: true });

  assert.deepEqual(harness.controller.getMissingBootstrapBindings(), ['message template (#message-template)']);
});

test('reportBootstrapMismatch updates status and appends system message when transcript bindings exist', () => {
  const harness = buildHarness();

  harness.controller.reportBootstrapMismatch('Required startup bindings are missing', ['message log (#messages)']);

  assert.equal(harness.authStatusEl.textContent, 'Client bootstrap mismatch');
  assert.match(harness.authStatusEl.title, /Required startup bindings are missing/);
  assert.deepEqual(harness.appendMessages, ['Required startup bindings are missing. Missing: message log (#messages). Reload the mini app to refresh assets.']);
});

test('reportBootstrapMismatch falls back to console error without transcript bindings', () => {
  const harness = buildHarness({ missingTemplate: true });

  harness.controller.reportBootstrapMismatch('Required startup bindings are missing', ['message template (#message-template)']);

  assert.equal(harness.consoleErrors.length, 1);
  assert.equal(harness.consoleErrors[0][0], '[miniapp/bootstrap]');
});

test('bootstrap runs happy-path startup orchestration and restores pending snapshot render', async () => {
  const harness = buildHarness();

  await harness.controller.bootstrap();

  assert.equal(harness.tg.readyCalls, 1);
  assert.equal(harness.tg.expandCalls, 1);
  assert.equal(harness.initDataValue, 'telegram-init-data');
  assert.deepEqual(harness.bootLatency, ['bootstrap-start']);
  assert.equal(harness.authBootstrapCalls.length, 2);
  assert.equal(harness.restoreSnapshotCalls[0], 7);
  assert.deepEqual(harness.renderMessagesCalls, [[7, { preserveViewport: true }]]);
  assert.equal(harness.syncDevAuthUiCalls.length >= 2, true);
  assert.equal(harness.summarizeBootMetricsCalls.length, 1);
});

test('bootstrap restores pending snapshot when local snapshot exists even if bootstrap chat metadata briefly says not pending', async () => {
  const harness = buildHarness({
    bootstrapResponse: { response: { ok: true, status: 200 }, data: { ok: true, active_chat_id: 7, chats: [{ id: 7, pending: false }] } },
  });

  await harness.controller.bootstrap();

  assert.deepEqual(harness.restoreSnapshotCalls, [7]);
  assert.deepEqual(harness.renderMessagesCalls, [[7, { preserveViewport: true }]]);
});

test('bootstrap short-circuits on missing bindings and still reveals shell', async () => {
  const harness = buildHarness({ missingTemplate: true });

  await harness.controller.bootstrap();

  assert.equal(harness.authBootstrapCalls.length, 0);
  assert.deepEqual(harness.appendMessages, []);
  assert.equal(harness.consoleErrors.length, 1);
  assert.ok(harness.logBootStages.some(([name]) => name === 'revealShell'));
});

test('bootstrap stops after bootstrap-version refresh redirect', async () => {
  const harness = buildHarness({ maybeRefresh: true });

  await harness.controller.bootstrap();

  assert.equal(harness.authBootstrapCalls.length, 0);
  assert.ok(harness.logBootStages.some(([name]) => name === 'revealShell'));
});

test('bootstrap surfaces desktop testing ready message when auth bootstrap fails in desktop mode', async () => {
  const harness = buildHarness({
    desktopTestingEnabled: true,
    bootstrapResponse: { response: { ok: false, status: 401 }, data: { ok: false, error: 'Use desktop auth' } },
  });

  await harness.controller.bootstrap();

  assert.equal(harness.authStatusEl.textContent, 'Desktop testing ready');
  assert.deepEqual(harness.appendMessages, ['Use desktop auth']);
  assert.deepEqual(harness.signInCalls, [{ interactive: false }]);
});

test('installPendingCompletionWatchdog refreshes pending active chat with hidden-state metadata', async () => {
  const harness = buildHarness();
  harness.documentObject.visibilityState = 'hidden';

  harness.controller.installPendingCompletionWatchdog();
  assert.equal(harness.intervalCallbacks.length, 1);

  harness.intervalCallbacks[0]();
  await flushAsync();

  assert.equal(harness.refreshChatsCalls.length, 1);
  assert.equal(harness.syncVisibleActiveChatCalls.length, 1);
  assert.equal(harness.syncVisibleActiveChatCalls[0].hidden, true);
  assert.equal(harness.syncVisibleActiveChatCalls[0].streamAbortControllers instanceof Map, true);
  assert.equal(harness.syncVisibleActiveChatCalls[0].streamAbortControllers.has(7), true);
});
