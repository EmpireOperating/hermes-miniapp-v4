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

function buildHarness({ isAuthenticated = true } = {}) {
  const chatScrollTop = new Map();
  const chatStickToBottom = new Map();
  const unseenStreamChats = new Set([7]);
  const histories = new Map([[7, [{ id: 1 }, { id: 2 }]]]);
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
  const authStatusEl = { textContent: '' };

  const messagesEl = createEventTarget({
    scrollTop: 120,
    querySelectorAll(selector) {
      if (selector !== '.message') return [];
      return [{ offsetTop: 90 }, { offsetTop: 460 }];
    },
  });

  const documentObject = createEventTarget();
  const windowObject = {};

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
    getActiveChatId: () => 7,
    getRenderedChatId: () => 7,
    isNearBottomFn: () => true,
    chatScrollTop,
    chatStickToBottom,
    unseenStreamChats,
    histories,
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
    signInWithDevAuth: async () => {
      signInCalls.push(true);
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
    fullscreenAppTopButton,
    closeAppTopButton,
    renderTraceBadge,
    settingsButton,
    devSignInButton,
    settingsClose,
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
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(harness.appendMessages, ['Still signing you in. Try again in a moment.']);
  assert.deepEqual(harness.saveSkinCalls, []);
  assert.deepEqual(harness.reportErrors, ['remove failed']);
});

test('installActionButtonBindings saves skin and closes settings when authenticated', async () => {
  const harness = buildHarness({ isAuthenticated: true });

  harness.controller.installActionButtonBindings();
  harness.skinButton.dispatch('click');
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(harness.saveSkinCalls, ['oracle']);
  assert.equal(harness.closeSettingsCalls.length, 1);
});

test('installShellModalBindings handles dev sign-in failures', async () => {
  const harness = buildHarness();

  harness.controller.installShellModalBindings();
  harness.devSignInButton.dispatch('click');
  await new Promise((resolve) => setTimeout(resolve, 0));

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
